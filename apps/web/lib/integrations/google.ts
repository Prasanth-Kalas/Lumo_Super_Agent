/**
 * Google OAuth config + authenticated fetch helpers.
 *
 * Lumo treats the user's Google account as a "personal integration" —
 * Lumo READS from Gmail/Calendar/Contacts at query time to perform
 * tasks, and NEVER persists the returned data. The only thing we
 * persist is the encrypted access/refresh token (in agent_connections,
 * same AES-256-GCM pipeline as every other OAuth connection).
 *
 * One OAuth app → three integrations. We bundle gmail + calendar +
 * contacts scopes into a single authorize trip so the user connects
 * once. If they later want to narrow scope, they can revoke at
 * https://myaccount.google.com/permissions and we'll auto-detect the
 * failure on the next token refresh.
 *
 * Env:
 *   LUMO_GOOGLE_CLIENT_ID       Required. From Google Cloud Console.
 *   LUMO_GOOGLE_CLIENT_SECRET   Required. Same.
 *
 * Redirect URI to whitelist in the Cloud Console:
 *   https://<your-deployment>/api/connections/callback
 *
 * See docs/integrations-google.md for the full setup walkthrough.
 */

// ──────────────────────────────────────────────────────────────────────────
// Constants
// ──────────────────────────────────────────────────────────────────────────

export const GOOGLE_AGENT_ID = "google";

/**
 * Minimum scopes for Lumo's Gmail + Calendar + Contacts tools. Narrow
 * by default — we ask for readonly on mail and contacts because that's
 * what our MVP tools need. Calendar is full-access because we expose
 * create_event.
 *
 * When we add a gmail_send or gmail_modify tool, bump gmail scope then,
 * not preemptively.
 */
export const GOOGLE_SCOPES = [
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/calendar",
  "https://www.googleapis.com/auth/contacts.readonly",
  // YouTube scopes for /workspace creator-tab features. Read-only on the
  // Data API for channel/video/comment reads; force-ssl for comment
  // replies (gated by the publish confirmation card). Analytics scopes
  // unlock the per-video performance reports.
  "https://www.googleapis.com/auth/youtube.readonly",
  "https://www.googleapis.com/auth/youtube.force-ssl",
  "https://www.googleapis.com/auth/yt-analytics.readonly",
  "https://www.googleapis.com/auth/yt-analytics-monetary.readonly",
  "openid",
  "email",
  "profile",
] as const;

// Human-friendly labels for the consent / marketplace scope list.
export const GOOGLE_SCOPE_DESCRIPTIONS: Record<string, string> = {
  "https://www.googleapis.com/auth/gmail.readonly":
    "Read your Gmail messages (Lumo never stores them)",
  "https://www.googleapis.com/auth/calendar":
    "View and create events on your Google Calendar",
  "https://www.googleapis.com/auth/contacts.readonly":
    "Look up your Google Contacts (Lumo never stores them)",
  "https://www.googleapis.com/auth/youtube.readonly":
    "View your YouTube channels, videos, and comments",
  "https://www.googleapis.com/auth/youtube.force-ssl":
    "Reply to comments on your YouTube videos (always gated by your confirmation)",
  "https://www.googleapis.com/auth/yt-analytics.readonly":
    "Read your YouTube analytics (views, watch time, audience insights)",
  "https://www.googleapis.com/auth/yt-analytics-monetary.readonly":
    "Read your YouTube monetization metrics (revenue, ad performance)",
  openid: "Confirm your Google identity",
  email: "See your email address",
  profile: "See your name and profile photo",
};

export const GOOGLE_AUTHORIZE_URL = "https://accounts.google.com/o/oauth2/v2/auth";
export const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
export const GOOGLE_REVOCATION_URL = "https://oauth2.googleapis.com/revoke";

// ──────────────────────────────────────────────────────────────────────────
// Env
// ──────────────────────────────────────────────────────────────────────────

export function getGoogleClientId(): string | null {
  const v = (process.env.LUMO_GOOGLE_CLIENT_ID ?? "").trim();
  return v || null;
}

export function getGoogleClientSecret(): string | null {
  const v = (process.env.LUMO_GOOGLE_CLIENT_SECRET ?? "").trim();
  return v || null;
}

export function isGoogleConfigured(): boolean {
  return !!(getGoogleClientId() && getGoogleClientSecret());
}

// ──────────────────────────────────────────────────────────────────────────
// Authenticated fetch — used by gmail/calendar/contacts handlers
// ──────────────────────────────────────────────────────────────────────────

/**
 * Thin wrapper around `fetch` that attaches the Bearer token, enforces
 * a JSON response, and surfaces Google's error shape in a consistent
 * way. Caller handles refresh (that's the router's job via the
 * connections DAO — we're already downstream of that).
 */
export async function googleFetchJson<T = unknown>(args: {
  access_token: string;
  url: string;
  method?: "GET" | "POST" | "PATCH" | "DELETE";
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
  const t = setTimeout(() => controller.abort(), args.timeoutMs ?? 15_000);
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
    if (!res.ok) {
      // Google returns a structured error in the body.
      const text = await res.text().catch(() => "");
      throw new GoogleApiError(res.status, text.slice(0, 240));
    }
    return (await res.json()) as T;
  } finally {
    clearTimeout(t);
  }
}

export class GoogleApiError extends Error {
  readonly http_status: number;
  constructor(status: number, detail: string) {
    super(`Google API ${status}: ${detail}`);
    this.name = "GoogleApiError";
    this.http_status = status;
  }
}
