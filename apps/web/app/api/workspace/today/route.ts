/**
 * GET /api/workspace/today — aggregator for the Today tab.
 *
 * Returns a single JSON envelope with the data each Today card needs.
 * Server-side aggregation lets us:
 *   - Decrypt OAuth tokens once (rather than once per card endpoint)
 *   - Fan out to platform APIs in parallel via Promise.allSettled
 *   - Return graceful per-card source/error envelopes when one of the
 *     platforms is down so the dashboard still renders
 *
 * Each card carries a `source` ('live' | 'cached' | 'stale' | 'error')
 * + `age_ms` so the UI can render "Cached 12m ago" pills accurately.
 *
 * Auth: requires a signed-in user. Returns 401 otherwise.
 */

import { type NextRequest, NextResponse } from "next/server";
import { getServerUser } from "@/lib/auth";
import {
  GOOGLE_AGENT_ID,
  googleFetchJson,
  type GoogleApiError,
} from "@/lib/integrations/google";
import {
  MICROSOFT_AGENT_ID,
  msftFetchJson,
} from "@/lib/integrations/microsoft";
import { SPOTIFY_AGENT_ID } from "@/lib/integrations/spotify";
import { listChannels, listRecentVideos } from "@/lib/integrations/youtube";
import { getDispatchableConnection } from "@/lib/connections";
import { fetchWithArchive } from "@/lib/connector-archive";

export const runtime = "nodejs";

interface CardSourceEnvelope {
  source: "live" | "cached" | "stale" | "error";
  age_ms: number;
  error?: string;
}

interface CalendarEvent {
  id: string;
  title: string;
  start_iso: string;
  end_iso?: string;
  location?: string;
  attendees_count: number;
  source: "google" | "microsoft";
}

interface EmailPreview {
  id: string;
  from: string;
  subject: string;
  snippet: string;
  received_iso: string;
  source: "gmail" | "outlook";
  unread: boolean;
}

interface SpotifyNowPlaying {
  is_playing: boolean;
  track_name?: string;
  artist?: string;
  album_art_url?: string;
}

interface YouTubeRecentSummary {
  channel_id: string;
  channel_title: string;
  recent_videos: Array<{
    id: string;
    title: string;
    views?: number;
    published_at: string;
    thumbnail_url?: string;
  }>;
}

interface TodayEnvelope {
  generated_at: string;
  calendar: { events: CalendarEvent[] } & CardSourceEnvelope;
  email: { messages: EmailPreview[] } & CardSourceEnvelope;
  spotify: { now_playing: SpotifyNowPlaying | null } & CardSourceEnvelope;
  youtube: { channels: YouTubeRecentSummary[] } & CardSourceEnvelope;
}

export async function GET(_req: NextRequest) {
  const user = await getServerUser();
  if (!user?.id) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const user_id = user.id;

  // Fan out per platform. Each helper returns its own envelope so a
  // single platform failing doesn't take the whole response with it.
  const [calendar, email, spotify, youtube] = await Promise.all([
    fetchCalendarCard(user_id),
    fetchEmailCard(user_id),
    fetchSpotifyCard(user_id),
    fetchYouTubeCard(user_id),
  ]);

  const envelope: TodayEnvelope = {
    generated_at: new Date().toISOString(),
    calendar,
    email,
    spotify,
    youtube,
  };
  return NextResponse.json(envelope);
}

// ──────────────────────────────────────────────────────────────────────────
// Calendar — Google + Microsoft, merged
// ──────────────────────────────────────────────────────────────────────────

async function fetchCalendarCard(user_id: string): Promise<TodayEnvelope["calendar"]> {
  const events: CalendarEvent[] = [];
  let source: CardSourceEnvelope["source"] = "live";
  let age_ms = 0;
  let error: string | undefined;

  try {
    const google = await getActiveAccessToken(user_id, GOOGLE_AGENT_ID);
    if (google) {
      const env = await fetchWithArchive<{ items?: GoogleEvent[] }>(
        {
          user_id,
          agent_id: GOOGLE_AGENT_ID,
          endpoint: "calendar.events.next3",
        },
        {
          ttl_seconds: 300,
          fetcher: async () => {
            const data = await googleFetchJson<{ items?: GoogleEvent[] }>({
              access_token: google,
              url: "https://www.googleapis.com/calendar/v3/calendars/primary/events",
              query: {
                timeMin: new Date().toISOString(),
                maxResults: 3,
                singleEvents: "true",
                orderBy: "startTime",
              },
            });
            return { data, response_status: 200 };
          },
        },
      );
      for (const e of env.data.items ?? []) {
        if (!e.id || !e.summary || !e.start) continue;
        events.push({
          id: e.id,
          title: e.summary,
          start_iso: e.start.dateTime ?? e.start.date ?? "",
          end_iso: e.end?.dateTime ?? e.end?.date,
          location: e.location,
          attendees_count: e.attendees?.length ?? 0,
          source: "google",
        });
      }
      source = env.source;
      age_ms = env.age_ms;
    }
  } catch (err) {
    error = serializeErr(err);
    source = "error";
  }

  // Best-effort: pull next-3 from Outlook too if connected. We don't
  // fail the whole card if Outlook is missing.
  try {
    const ms = await getActiveAccessToken(user_id, MICROSOFT_AGENT_ID);
    if (ms) {
      const env = await fetchWithArchive<{ value?: OutlookEvent[] }>(
        {
          user_id,
          agent_id: MICROSOFT_AGENT_ID,
          endpoint: "calendar.events.next3",
        },
        {
          ttl_seconds: 300,
          fetcher: async () => {
            const data = await msftFetchJson<{ value?: OutlookEvent[] }>({
              access_token: ms,
              url:
                "https://graph.microsoft.com/v1.0/me/calendarview" +
                `?startDateTime=${encodeURIComponent(new Date().toISOString())}` +
                `&endDateTime=${encodeURIComponent(
                  new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString(),
                )}&$top=3&$orderby=start/dateTime`,
            });
            return { data, response_status: 200 };
          },
        },
      );
      for (const e of env.data.value ?? []) {
        if (!e.id || !e.subject) continue;
        events.push({
          id: e.id,
          title: e.subject,
          start_iso: e.start?.dateTime ?? "",
          end_iso: e.end?.dateTime,
          location: e.location?.displayName,
          attendees_count: e.attendees?.length ?? 0,
          source: "microsoft",
        });
      }
    }
  } catch {
    // Microsoft failure shouldn't take Google events down.
  }

  // Merge + sort + cap at 3 across both sources.
  events.sort((a, b) => a.start_iso.localeCompare(b.start_iso));
  return { events: events.slice(0, 3), source, age_ms, ...(error ? { error } : {}) };
}

// ──────────────────────────────────────────────────────────────────────────
// Email — Gmail + Outlook, top by recency
// ──────────────────────────────────────────────────────────────────────────

async function fetchEmailCard(user_id: string): Promise<TodayEnvelope["email"]> {
  const messages: EmailPreview[] = [];
  let source: CardSourceEnvelope["source"] = "live";
  let age_ms = 0;
  let error: string | undefined;

  try {
    const google = await getActiveAccessToken(user_id, GOOGLE_AGENT_ID);
    if (google) {
      const env = await fetchWithArchive<GmailListThenGet>(
        {
          user_id,
          agent_id: GOOGLE_AGENT_ID,
          endpoint: "gmail.messages.top3.unread",
        },
        {
          ttl_seconds: 180,
          fetcher: async () => {
            const list = await googleFetchJson<{ messages?: Array<{ id: string }> }>({
              access_token: google,
              url: "https://gmail.googleapis.com/gmail/v1/users/me/messages",
              query: { q: "is:unread in:inbox", maxResults: 3 },
            });
            const ids = (list.messages ?? []).map((m) => m.id).filter(Boolean);
            const previews = await Promise.all(
              ids.map((id) =>
                googleFetchJson<GmailMessage>({
                  access_token: google,
                  url: `https://gmail.googleapis.com/gmail/v1/users/me/messages/${id}`,
                  query: {
                    format: "metadata",
                    "metadataHeaders.0": "From",
                    "metadataHeaders.1": "Subject",
                    "metadataHeaders.2": "Date",
                  },
                }),
              ),
            );
            return { data: { list, previews }, response_status: 200 };
          },
        },
      );
      for (const m of env.data.previews) {
        const headers = (m.payload?.headers ?? []).reduce<Record<string, string>>(
          (acc, h) => {
            if (h.name && h.value) acc[h.name.toLowerCase()] = h.value;
            return acc;
          },
          {},
        );
        messages.push({
          id: m.id,
          from: headers["from"] ?? "(unknown sender)",
          subject: headers["subject"] ?? "(no subject)",
          snippet: m.snippet ?? "",
          received_iso: m.internalDate
            ? new Date(parseInt(m.internalDate, 10)).toISOString()
            : new Date().toISOString(),
          source: "gmail",
          unread: (m.labelIds ?? []).includes("UNREAD"),
        });
      }
      source = env.source;
      age_ms = env.age_ms;
    }
  } catch (err) {
    error = serializeErr(err);
    source = "error";
  }

  // Outlook top-3 unread — best effort.
  try {
    const ms = await getActiveAccessToken(user_id, MICROSOFT_AGENT_ID);
    if (ms) {
      const env = await fetchWithArchive<{ value?: OutlookMessage[] }>(
        {
          user_id,
          agent_id: MICROSOFT_AGENT_ID,
          endpoint: "outlook.messages.top3.unread",
        },
        {
          ttl_seconds: 180,
          fetcher: async () => {
            const data = await msftFetchJson<{ value?: OutlookMessage[] }>({
              access_token: ms,
              url:
                "https://graph.microsoft.com/v1.0/me/messages" +
                "?$filter=isRead%20eq%20false&$top=3&$orderby=receivedDateTime%20desc",
            });
            return { data, response_status: 200 };
          },
        },
      );
      for (const m of env.data.value ?? []) {
        if (!m.id || !m.subject) continue;
        messages.push({
          id: m.id,
          from:
            m.from?.emailAddress?.name ??
            m.from?.emailAddress?.address ??
            "(unknown sender)",
          subject: m.subject,
          snippet: m.bodyPreview ?? "",
          received_iso: m.receivedDateTime ?? new Date().toISOString(),
          source: "outlook",
          unread: !m.isRead,
        });
      }
    }
  } catch {
    // Outlook fail doesn't take Gmail down.
  }

  messages.sort((a, b) => b.received_iso.localeCompare(a.received_iso));
  return {
    messages: messages.slice(0, 3),
    source,
    age_ms,
    ...(error ? { error } : {}),
  };
}

// ──────────────────────────────────────────────────────────────────────────
// Spotify — currently playing
// ──────────────────────────────────────────────────────────────────────────

async function fetchSpotifyCard(user_id: string): Promise<TodayEnvelope["spotify"]> {
  let source: CardSourceEnvelope["source"] = "live";
  let age_ms = 0;
  let error: string | undefined;
  let nowPlaying: SpotifyNowPlaying | null = null;

  try {
    const token = await getActiveAccessToken(user_id, SPOTIFY_AGENT_ID);
    if (token) {
      const env = await fetchWithArchive<SpotifyCurrentlyPlaying>(
        {
          user_id,
          agent_id: SPOTIFY_AGENT_ID,
          endpoint: "spotify.player.currently_playing",
        },
        {
          ttl_seconds: 30, // music status changes constantly
          fetcher: async () => {
            const r = await fetch(
              "https://api.spotify.com/v1/me/player/currently-playing",
              {
                headers: { authorization: `Bearer ${token}` },
              },
            );
            if (r.status === 204) {
              return { data: { is_playing: false }, response_status: 204 };
            }
            if (!r.ok) {
              throw new Error(`Spotify ${r.status}`);
            }
            const data = (await r.json()) as SpotifyCurrentlyPlaying;
            return { data, response_status: 200 };
          },
        },
      );
      const d = env.data;
      if (d?.is_playing && d.item) {
        nowPlaying = {
          is_playing: true,
          track_name: d.item.name,
          artist: (d.item.artists ?? []).map((a) => a.name).join(", "),
          album_art_url: d.item.album?.images?.[0]?.url,
        };
      } else {
        nowPlaying = { is_playing: false };
      }
      source = env.source;
      age_ms = env.age_ms;
    }
  } catch (err) {
    error = serializeErr(err);
    source = "error";
  }

  return { now_playing: nowPlaying, source, age_ms, ...(error ? { error } : {}) };
}

// ──────────────────────────────────────────────────────────────────────────
// YouTube — channels + recent uploads
// ──────────────────────────────────────────────────────────────────────────

async function fetchYouTubeCard(user_id: string): Promise<TodayEnvelope["youtube"]> {
  const channels: YouTubeRecentSummary[] = [];
  let source: CardSourceEnvelope["source"] = "live";
  let age_ms = 0;
  let error: string | undefined;

  try {
    const token = await getActiveAccessToken(user_id, GOOGLE_AGENT_ID);
    if (token) {
      const channelList = await listChannels({ user_id, access_token: token });
      source = channelList.source;
      age_ms = channelList.age_ms;

      // Fetch recent videos for up to 2 channels (avoid quota burn for
      // multi-channel users until we wire the channel selector).
      const subset = channelList.channels.slice(0, 2);
      const videoBundles = await Promise.allSettled(
        subset.map((c) =>
          listRecentVideos({
            user_id,
            channel_id: c.id,
            access_token: token,
            limit: 3,
          }).then((r) => ({ channel: c, recent: r })),
        ),
      );
      for (const b of videoBundles) {
        if (b.status !== "fulfilled") continue;
        channels.push({
          channel_id: b.value.channel.id,
          channel_title: b.value.channel.title,
          recent_videos: b.value.recent.videos.map((v) => ({
            id: v.id,
            title: v.title,
            views: v.views,
            published_at: v.publishedAt,
            thumbnail_url: v.thumbnailUrl,
          })),
        });
      }
    }
  } catch (err) {
    error = serializeErr(err);
    source = "error";
  }

  return { channels, source, age_ms, ...(error ? { error } : {}) };
}

// ──────────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────────

async function getActiveAccessToken(
  user_id: string,
  agent_id: string,
): Promise<string | null> {
  // We don't need the full OAuth config here because we're not refreshing —
  // the route handlers that mutate state do that. For pure reads we just
  // pull the decrypted token.
  const conn = await getDispatchableConnection({
    user_id,
    agent_id,
    oauth2_config: {
      authorize_url: "",
      token_url: "",
      scopes: [],
      client_id_env: "",
      client_secret_env: "",
      client_type: "confidential",
    } as never,
  }).catch(() => null);
  if (!conn) return null;
  return conn.access_token;
}

function serializeErr(err: unknown): string {
  if (err instanceof Error) return `${err.name}: ${err.message}`.slice(0, 240);
  return String(err).slice(0, 240);
}

// ──────────────────────────────────────────────────────────────────────────
// Provider response shapes (minimal — only what the cards need)
// ──────────────────────────────────────────────────────────────────────────

interface GoogleEvent {
  id?: string;
  summary?: string;
  start?: { dateTime?: string; date?: string };
  end?: { dateTime?: string; date?: string };
  location?: string;
  attendees?: Array<{ email?: string }>;
}

interface OutlookEvent {
  id?: string;
  subject?: string;
  start?: { dateTime?: string };
  end?: { dateTime?: string };
  location?: { displayName?: string };
  attendees?: Array<{ emailAddress?: { name?: string } }>;
}

interface GmailListThenGet {
  list: { messages?: Array<{ id: string }> };
  previews: GmailMessage[];
}

interface GmailMessage {
  id: string;
  internalDate?: string;
  snippet?: string;
  labelIds?: string[];
  payload?: { headers?: Array<{ name?: string; value?: string }> };
}

interface OutlookMessage {
  id?: string;
  subject?: string;
  bodyPreview?: string;
  receivedDateTime?: string;
  isRead?: boolean;
  from?: { emailAddress?: { name?: string; address?: string } };
}

interface SpotifyCurrentlyPlaying {
  is_playing?: boolean;
  item?: {
    name?: string;
    artists?: Array<{ name?: string }>;
    album?: { images?: Array<{ url?: string }> };
  };
}

// Ensure unused import doesn't break tsc.
export type { GoogleApiError };
