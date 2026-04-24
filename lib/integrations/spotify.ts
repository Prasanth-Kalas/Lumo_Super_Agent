/**
 * Spotify integration — OAuth config + tool handlers in one file.
 *
 * Same privacy posture: tokens stored encrypted in agent_connections;
 * nothing else persisted. Playback control requires Spotify Premium
 * — free accounts can search and see recently-played but playback
 * endpoints return 403. We surface that as a user-readable error
 * instead of pretending it worked.
 */

export const SPOTIFY_AGENT_ID = "spotify";

/**
 * Scopes we request. Kept to what Lumo actually exercises:
 *   - user-read-currently-playing     see what's playing right now
 *   - user-modify-playback-state      play / pause / skip / queue
 *   - user-read-recently-played       history
 *   - playlist-read-private           user's private playlists
 *   - user-read-private               profile (country, product tier)
 *   - user-read-email                 identity for UI
 *
 * Missing from the list (intentionally): user-library-modify (add to
 * library), playlist-modify-*. We don't have tools that need them;
 * widen later when we do and force re-consent.
 */
export const SPOTIFY_SCOPES = [
  "user-read-currently-playing",
  "user-modify-playback-state",
  "user-read-playback-state",
  "user-read-recently-played",
  "playlist-read-private",
  "user-read-private",
  "user-read-email",
] as const;

export const SPOTIFY_SCOPE_DESCRIPTIONS: Record<string, string> = {
  "user-read-currently-playing": "See what's playing on your Spotify",
  "user-modify-playback-state": "Play, pause, skip, and queue tracks (Premium only)",
  "user-read-playback-state": "See which device is active and the current volume",
  "user-read-recently-played": "See what you've listened to recently",
  "playlist-read-private": "Read your private playlists",
  "user-read-private": "Confirm your Spotify identity",
  "user-read-email": "See your email address",
};

export const SPOTIFY_AUTHORIZE_URL = "https://accounts.spotify.com/authorize";
export const SPOTIFY_TOKEN_URL = "https://accounts.spotify.com/api/token";

export function getSpotifyClientId(): string | null {
  const v = (process.env.LUMO_SPOTIFY_CLIENT_ID ?? "").trim();
  return v || null;
}

export function getSpotifyClientSecret(): string | null {
  const v = (process.env.LUMO_SPOTIFY_CLIENT_SECRET ?? "").trim();
  return v || null;
}

export function isSpotifyConfigured(): boolean {
  return !!(getSpotifyClientId() && getSpotifyClientSecret());
}

// ──────────────────────────────────────────────────────────────────────────
// Fetch helper
// ──────────────────────────────────────────────────────────────────────────

async function spotifyFetch<T = unknown>(args: {
  access_token: string;
  url: string;
  method?: "GET" | "POST" | "PUT" | "DELETE";
  body?: unknown;
  query?: Record<string, string | number | undefined>;
  timeoutMs?: number;
}): Promise<T> {
  const u = new URL(args.url);
  if (args.query) {
    for (const [k, v] of Object.entries(args.query)) {
      if (v === undefined) continue;
      u.searchParams.set(k, String(v));
    }
  }
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), args.timeoutMs ?? 10_000);
  try {
    const res = await fetch(u.toString(), {
      method: args.method ?? "GET",
      headers: {
        authorization: `Bearer ${args.access_token}`,
        accept: "application/json",
        ...(args.body ? { "content-type": "application/json" } : {}),
      },
      body: args.body ? JSON.stringify(args.body) : undefined,
      signal: controller.signal,
    });
    // 204 = success with no body (common on PUT /me/player endpoints).
    if (res.status === 204) return { ok: true } as T;
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new SpotifyApiError(res.status, text.slice(0, 240));
    }
    return (await res.json()) as T;
  } finally {
    clearTimeout(t);
  }
}

export class SpotifyApiError extends Error {
  readonly http_status: number;
  constructor(status: number, detail: string) {
    let message = `Spotify API ${status}`;
    // 403 on playback endpoints almost always means "not Premium".
    // Tag that explicitly so the orchestrator can surface a useful error.
    if (status === 403 && /premium/i.test(detail)) {
      message = "Spotify Premium required for playback control.";
    } else if (status === 404 && /no active device/i.test(detail)) {
      message =
        "No active Spotify device — open Spotify on your phone or desktop first.";
    } else {
      message = `${message}: ${detail}`;
    }
    super(message);
    this.name = "SpotifyApiError";
    this.http_status = status;
  }
}

export function isSpotifyApiError(e: unknown): e is SpotifyApiError {
  return e instanceof Error && e.name === "SpotifyApiError";
}

// ──────────────────────────────────────────────────────────────────────────
// Tool handlers
// ──────────────────────────────────────────────────────────────────────────

export interface CurrentPlayback {
  is_playing: boolean;
  track: { name: string; artists: string; album: string; uri: string } | null;
  device: { name: string; type: string; volume_percent: number | null } | null;
  progress_ms: number | null;
}

export async function spotifyCurrentPlayback(args: {
  access_token: string;
}): Promise<CurrentPlayback> {
  // Empty response (status 204) = nothing playing.
  try {
    const data = await spotifyFetch<{
      is_playing?: boolean;
      progress_ms?: number;
      item?: {
        name: string;
        uri: string;
        artists?: Array<{ name: string }>;
        album?: { name: string };
      };
      device?: {
        name: string;
        type: string;
        volume_percent: number;
      };
    }>({
      access_token: args.access_token,
      url: "https://api.spotify.com/v1/me/player",
    });
    if (!data?.item) {
      return { is_playing: false, track: null, device: null, progress_ms: null };
    }
    return {
      is_playing: !!data.is_playing,
      track: {
        name: data.item.name,
        artists: (data.item.artists ?? []).map((a) => a.name).join(", "),
        album: data.item.album?.name ?? "",
        uri: data.item.uri,
      },
      device: data.device
        ? {
            name: data.device.name,
            type: data.device.type,
            volume_percent: data.device.volume_percent ?? null,
          }
        : null,
      progress_ms: data.progress_ms ?? null,
    };
  } catch (err) {
    if (isSpotifyApiError(err) && err.http_status === 204) {
      return { is_playing: false, track: null, device: null, progress_ms: null };
    }
    throw err;
  }
}

export interface SpotifySearchResult {
  tracks: Array<{
    name: string;
    artists: string;
    album: string;
    uri: string;
    duration_ms: number;
  }>;
}

export async function spotifySearch(args: {
  access_token: string;
  query: string;
  max_results?: number;
}): Promise<SpotifySearchResult> {
  const max = Math.min(20, Math.max(1, args.max_results ?? 10));
  const data = await spotifyFetch<{
    tracks?: {
      items?: Array<{
        name: string;
        uri: string;
        duration_ms: number;
        artists?: Array<{ name: string }>;
        album?: { name: string };
      }>;
    };
  }>({
    access_token: args.access_token,
    url: "https://api.spotify.com/v1/search",
    query: { q: args.query, type: "track", limit: max },
  });
  return {
    tracks: (data.tracks?.items ?? []).map((t) => ({
      name: t.name,
      artists: (t.artists ?? []).map((a) => a.name).join(", "),
      album: t.album?.name ?? "",
      uri: t.uri,
      duration_ms: t.duration_ms,
    })),
  };
}

export async function spotifyPlay(args: {
  access_token: string;
  uri?: string;
}): Promise<{ ok: true }> {
  await spotifyFetch({
    access_token: args.access_token,
    url: "https://api.spotify.com/v1/me/player/play",
    method: "PUT",
    body: args.uri ? (args.uri.includes(":track:") ? { uris: [args.uri] } : { context_uri: args.uri }) : undefined,
  });
  return { ok: true };
}

export async function spotifyPause(args: {
  access_token: string;
}): Promise<{ ok: true }> {
  await spotifyFetch({
    access_token: args.access_token,
    url: "https://api.spotify.com/v1/me/player/pause",
    method: "PUT",
  });
  return { ok: true };
}

export async function spotifySkipNext(args: {
  access_token: string;
}): Promise<{ ok: true }> {
  await spotifyFetch({
    access_token: args.access_token,
    url: "https://api.spotify.com/v1/me/player/next",
    method: "POST",
  });
  return { ok: true };
}

export async function spotifyAddToQueue(args: {
  access_token: string;
  uri: string;
}): Promise<{ ok: true }> {
  await spotifyFetch({
    access_token: args.access_token,
    url: "https://api.spotify.com/v1/me/player/queue",
    method: "POST",
    query: { uri: args.uri },
  });
  return { ok: true };
}

export interface SpotifyRecentlyPlayed {
  tracks: Array<{
    name: string;
    artists: string;
    album: string;
    uri: string;
    played_at: string;
  }>;
}

export async function spotifyRecentlyPlayed(args: {
  access_token: string;
  max_results?: number;
}): Promise<SpotifyRecentlyPlayed> {
  const max = Math.min(50, Math.max(1, args.max_results ?? 20));
  const data = await spotifyFetch<{
    items?: Array<{
      played_at: string;
      track: {
        name: string;
        uri: string;
        artists?: Array<{ name: string }>;
        album?: { name: string };
      };
    }>;
  }>({
    access_token: args.access_token,
    url: "https://api.spotify.com/v1/me/player/recently-played",
    query: { limit: max },
  });
  return {
    tracks: (data.items ?? []).map((i) => ({
      name: i.track.name,
      artists: (i.track.artists ?? []).map((a) => a.name).join(", "),
      album: i.track.album?.name ?? "",
      uri: i.track.uri,
      played_at: i.played_at,
    })),
  };
}
