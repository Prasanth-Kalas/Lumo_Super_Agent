/**
 * /api/cron/sync-workspace — every 15 minutes, prime the connector
 * cache for active users so /workspace renders instantly on focus.
 *
 * Active = a user signed in within the last 7 days. We don't want to
 * pay API quota refreshing data for dormant accounts.
 *
 * For each active user we refresh a small set of cheap, high-value
 * endpoints per platform:
 *   - Google: gmail.messages.top3.unread, calendar.events.next3
 *   - Microsoft: outlook.messages.top3.unread, calendar.events.next3
 *   - YouTube: channels list (the main 1h-cache that powers the
 *     channel selector + Today tab)
 *   - Spotify: NOT refreshed via cron — too volatile, on-demand only
 *
 * Heavy analytics endpoints (YouTube Analytics reports, IG insights,
 * etc.) are NOT refreshed by cron — those pull on-demand to keep
 * quota burn predictable.
 *
 * Self-reports to ops_cron_runs.
 */

import { type NextRequest, NextResponse } from "next/server";
import { getSupabase } from "@/lib/db";
import { recordCronRun } from "@/lib/ops";
import {
  GOOGLE_AGENT_ID,
  googleFetchJson,
} from "@/lib/integrations/google";
import {
  MICROSOFT_AGENT_ID,
  msftFetchJson,
} from "@/lib/integrations/microsoft";
import { listChannels } from "@/lib/integrations/youtube";
import { fetchWithArchive } from "@/lib/connector-archive";
import { getDispatchableConnection } from "@/lib/connections";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ACTIVE_WINDOW_DAYS = 7;
const PER_USER_TIMEOUT_MS = 8000;
const PER_BATCH_USER_CAP = 50;

function isAuthorized(req: NextRequest): boolean {
  const expected = process.env.LUMO_CRON_SECRET;
  if (!expected) return true;
  const provided =
    req.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ??
    req.headers.get("x-vercel-cron") ??
    "";
  return provided === expected;
}

export async function GET(req: NextRequest) {
  if (!isAuthorized(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const startedAt = new Date();
  const counts = {
    users_scanned: 0,
    google_refreshed: 0,
    microsoft_refreshed: 0,
    youtube_refreshed: 0,
    skipped: 0,
    failed: 0,
  };
  const errors: string[] = [];
  let ok = true;

  const sb = getSupabase();
  if (!sb) {
    return NextResponse.json({ ok: true, note: "no DB; skipping" });
  }

  try {
    const cutoff = new Date(Date.now() - ACTIVE_WINDOW_DAYS * 86400_000).toISOString();
    // Active users = anyone whose connection was last_used_at within
    // the active window. This is a proxy for "they signed in recently"
    // until we wire a profiles.last_seen_at column.
    const { data: activeRows, error: activeErr } = await sb
      .from("agent_connections")
      .select("user_id")
      .eq("status", "active")
      .gte("last_used_at", cutoff)
      .limit(PER_BATCH_USER_CAP * 4);
    if (activeErr) throw new Error(`active-users query: ${activeErr.message}`);

    const userIds = Array.from(
      new Set(((activeRows ?? []) as Array<{ user_id: string }>).map((r) => r.user_id)),
    ).slice(0, PER_BATCH_USER_CAP);

    counts.users_scanned = userIds.length;

    for (const user_id of userIds) {
      const userBudget = Date.now() + PER_USER_TIMEOUT_MS;
      try {
        // Google
        if (Date.now() < userBudget) {
          const refreshed = await refreshGoogle(user_id);
          if (refreshed.google) counts.google_refreshed += 1;
          if (refreshed.youtube) counts.youtube_refreshed += 1;
        }
        // Microsoft
        if (Date.now() < userBudget) {
          const refreshed = await refreshMicrosoft(user_id);
          if (refreshed) counts.microsoft_refreshed += 1;
        }
      } catch (err) {
        counts.failed += 1;
        errors.push(
          `user ${user_id.slice(0, 8)}: ${err instanceof Error ? err.message : String(err)}`.slice(
            0,
            240,
          ),
        );
      }
    }
  } catch (err) {
    ok = false;
    errors.push(`scan: ${err instanceof Error ? err.message : String(err)}`);
  }

  await recordCronRun({
    endpoint: "sync-workspace",
    started_at: startedAt,
    finished_at: new Date(),
    ok,
    counts,
    errors,
  });
  return NextResponse.json({ ok, counts, errors: errors.slice(0, 10) });
}

async function refreshGoogle(
  user_id: string,
): Promise<{ google: boolean; youtube: boolean }> {
  const conn = await getDispatchableConnection({
    user_id,
    agent_id: GOOGLE_AGENT_ID,
    oauth2_config: {
      authorize_url: "",
      token_url: "",
      scopes: [],
      client_id_env: "",
      client_secret_env: "",
      client_type: "confidential",
    } as never,
  }).catch(() => null);
  if (!conn) return { google: false, youtube: false };

  // Calendar next-3
  await fetchWithArchive(
    {
      user_id,
      agent_id: GOOGLE_AGENT_ID,
      endpoint: "calendar.events.next3",
    },
    {
      ttl_seconds: 300,
      force_refresh: true,
      fetcher: async () => {
        const data = await googleFetchJson<unknown>({
          access_token: conn.access_token,
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
  ).catch(() => null);

  // Gmail top-3 unread (list only; preview hydration on demand)
  await fetchWithArchive(
    {
      user_id,
      agent_id: GOOGLE_AGENT_ID,
      endpoint: "gmail.messages.top3.unread.list",
    },
    {
      ttl_seconds: 300,
      force_refresh: true,
      fetcher: async () => {
        const data = await googleFetchJson<unknown>({
          access_token: conn.access_token,
          url: "https://gmail.googleapis.com/gmail/v1/users/me/messages",
          query: { q: "is:unread in:inbox", maxResults: 3 },
        });
        return { data, response_status: 200 };
      },
    },
  ).catch(() => null);

  // YouTube channels
  let youtube = false;
  try {
    await listChannels({
      user_id,
      access_token: conn.access_token,
      force_refresh: true,
    });
    youtube = true;
  } catch {
    // best-effort
  }
  return { google: true, youtube };
}

async function refreshMicrosoft(user_id: string): Promise<boolean> {
  const conn = await getDispatchableConnection({
    user_id,
    agent_id: MICROSOFT_AGENT_ID,
    oauth2_config: {
      authorize_url: "",
      token_url: "",
      scopes: [],
      client_id_env: "",
      client_secret_env: "",
      client_type: "confidential",
    } as never,
  }).catch(() => null);
  if (!conn) return false;

  // Calendar
  await fetchWithArchive(
    {
      user_id,
      agent_id: MICROSOFT_AGENT_ID,
      endpoint: "calendar.events.next3",
    },
    {
      ttl_seconds: 300,
      force_refresh: true,
      fetcher: async () => {
        const data = await msftFetchJson<unknown>({
          access_token: conn.access_token,
          url:
            "https://graph.microsoft.com/v1.0/me/calendarview" +
            `?startDateTime=${encodeURIComponent(new Date().toISOString())}` +
            `&endDateTime=${encodeURIComponent(
              new Date(Date.now() + 30 * 86400_000).toISOString(),
            )}&$top=3&$orderby=start/dateTime`,
        });
        return { data, response_status: 200 };
      },
    },
  ).catch(() => null);

  // Outlook top-3 unread
  await fetchWithArchive(
    {
      user_id,
      agent_id: MICROSOFT_AGENT_ID,
      endpoint: "outlook.messages.top3.unread",
    },
    {
      ttl_seconds: 300,
      force_refresh: true,
      fetcher: async () => {
        const data = await msftFetchJson<unknown>({
          access_token: conn.access_token,
          url:
            "https://graph.microsoft.com/v1.0/me/messages" +
            "?$filter=isRead%20eq%20false&$top=3&$orderby=receivedDateTime%20desc",
        });
        return { data, response_status: 200 };
      },
    },
  ).catch(() => null);
  return true;
}
