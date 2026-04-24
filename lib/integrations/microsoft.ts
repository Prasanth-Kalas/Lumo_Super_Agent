/**
 * Microsoft Graph OAuth + shared fetch helpers.
 *
 * Mirrors lib/integrations/google.ts: one Azure AD app, bundled scopes
 * across Outlook Mail + Calendar + Contacts, tokens stored encrypted
 * in agent_connections, nothing else persisted. The multi-tenant
 * endpoint (/common) accepts personal Microsoft accounts AND work /
 * school accounts, so a single registration covers both.
 *
 * Env:
 *   LUMO_MICROSOFT_CLIENT_ID       Required. From Azure AD app reg.
 *   LUMO_MICROSOFT_CLIENT_SECRET   Required. Same.
 *
 * Redirect URI to whitelist in Azure:
 *   https://<your-deployment>/api/connections/callback
 *
 * See docs/integrations-microsoft.md for the Azure AD walkthrough.
 */

export const MICROSOFT_AGENT_ID = "microsoft";

/**
 * Scopes we request on the authorize trip. `offline_access` is what
 * unlocks refresh tokens — without it Microsoft returns access-only
 * and the user has to re-consent every hour. `User.Read` is the
 * minimum identity probe Graph requires before the others work.
 *
 * When we add ms_outlook_send or ms_calendar_send-invite tools, bump
 * to Mail.ReadWrite / Mail.Send / Calendars.ReadWrite.Shared and
 * force a re-consent. Don't preemptively widen scope.
 */
export const MICROSOFT_SCOPES = [
  "openid",
  "profile",
  "email",
  "offline_access",
  "User.Read",
  "Mail.Read",
  "Calendars.ReadWrite",
  "Contacts.Read",
] as const;

export const MICROSOFT_SCOPE_DESCRIPTIONS: Record<string, string> = {
  "User.Read": "Confirm your Microsoft identity",
  "Mail.Read": "Read your Outlook messages (Lumo never stores them)",
  "Calendars.ReadWrite": "View and create events on your Outlook calendar",
  "Contacts.Read": "Look up your Outlook contacts (Lumo never stores them)",
  "offline_access": "Stay connected so Lumo doesn't ask you to sign in every hour",
  openid: "Sign in with Microsoft",
  email: "See your email address",
  profile: "See your name and profile",
};

// `/common` = multi-tenant. Personal + Work/School accounts both work.
// For enterprise-only deployments swap to the tenant GUID.
export const MICROSOFT_AUTHORIZE_URL =
  "https://login.microsoftonline.com/common/oauth2/v2.0/authorize";
export const MICROSOFT_TOKEN_URL =
  "https://login.microsoftonline.com/common/oauth2/v2.0/token";
// Graph doesn't have an OAuth2 revocation endpoint — users revoke at
// https://account.live.com/consent/Manage or via Azure AD. Our
// disconnect flow just drops our local copy of the token.

export function getMicrosoftClientId(): string | null {
  const v = (process.env.LUMO_MICROSOFT_CLIENT_ID ?? "").trim();
  return v || null;
}

export function getMicrosoftClientSecret(): string | null {
  const v = (process.env.LUMO_MICROSOFT_CLIENT_SECRET ?? "").trim();
  return v || null;
}

export function isMicrosoftConfigured(): boolean {
  return !!(getMicrosoftClientId() && getMicrosoftClientSecret());
}

/**
 * Thin wrapper around `fetch` for Microsoft Graph v1.0. Handles query
 * building, timeout, and uniform error surfacing.
 */
export async function msftFetchJson<T = unknown>(args: {
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
      const text = await res.text().catch(() => "");
      throw new MicrosoftApiError(res.status, text.slice(0, 240));
    }
    // Graph sometimes returns empty on 204 (e.g. delete). Guard against
    // JSON.parse failure on empty body.
    if (res.status === 204) return {} as T;
    return (await res.json()) as T;
  } finally {
    clearTimeout(t);
  }
}

export class MicrosoftApiError extends Error {
  readonly http_status: number;
  constructor(status: number, detail: string) {
    super(`Microsoft Graph ${status}: ${detail}`);
    this.name = "MicrosoftApiError";
    this.http_status = status;
  }
}

export function isMicrosoftApiError(e: unknown): e is MicrosoftApiError {
  return e instanceof Error && e.name === "MicrosoftApiError";
}
