/**
 * Meta (Facebook + Instagram) OAuth + shared Graph fetch helpers.
 *
 * One Meta App (id 843352985454776), one OAuth flow via Facebook Login,
 * one set of scopes that covers BOTH the user's Instagram Business
 * accounts AND their Facebook Pages. After consent, the user's token
 * can manage every IG Business account + every FB Page they admin.
 *
 * Why Facebook Login (not Instagram Login):
 *   The newer "Instagram API with Instagram Login" flow is simpler but
 *   IG-only — it doesn't expose Pages or Messenger. Our /workspace
 *   tabs read across IG + FB + Messenger, so a single FB Login flow
 *   that grants all three scope sets is the right model. This is how
 *   Buffer / Hootsuite / Sprout do it too.
 *
 * Mirrors lib/integrations/microsoft.ts in shape: one OAuth app,
 * bundled scopes, encrypted tokens in agent_connections, nothing else
 * persisted. Long-lived token exchange happens at refresh time.
 *
 * Env:
 *   LUMO_META_APP_ID       Required. From Meta dashboard → App settings → Basic.
 *   LUMO_META_APP_SECRET   Required. Same place. Marked Sensitive in Vercel.
 *   LUMO_META_API_VERSION  Optional override. Defaults to current GA.
 *
 * Redirect URI to whitelist in Meta App settings → Facebook Login for
 * Business → Settings → Valid OAuth Redirect URIs:
 *   https://<your-deployment>/api/connections/callback
 */

import { createHmac } from "node:crypto";

export const META_AGENT_ID = "meta";

/**
 * Default Graph API version. Bump when Meta deprecates the current GA.
 * Meta typically supports each version for ~2 years before forced
 * sunset. The override env var lets us pin a specific version per
 * deployment without a code change if a regression hits us mid-flight.
 */
const DEFAULT_API_VERSION = "v23.0";

export function getMetaApiVersion(): string {
  const v = (process.env.LUMO_META_API_VERSION ?? "").trim();
  return v || DEFAULT_API_VERSION;
}

/**
 * Scopes we request on the authorize trip. Bundles V1.2 IG + V1.3 FB
 * Pages + V1.3 Messenger so a single consent screen unlocks
 * everything we'll wire over the next two sub-versions.
 *
 * Notes per scope:
 *   - business_management — required to enumerate the user's Business
 *     Portfolio assets (Pages + IG accounts under one umbrella).
 *   - pages_show_list — list every Page the user admins.
 *   - pages_read_engagement — read Page posts + insights.
 *   - pages_manage_posts — publish / edit / delete Page posts.
 *   - pages_manage_engagement — reply / hide / delete Page comments.
 *   - pages_manage_metadata — webhook subscriptions + Page settings.
 *   - pages_messaging — send + receive DMs through Messenger.
 *   - instagram_business_basic — read IG profile + media.
 *   - instagram_business_content_publish — publish posts/reels/stories.
 *   - instagram_business_manage_comments — read + reply to comments.
 *   - instagram_business_manage_insights — audience + engagement metrics.
 *   - instagram_business_manage_messages — IG DM inbox.
 *
 * `email` + `public_profile` are auto-granted by Facebook Login and
 * we ask for them so the user's identity round-trip works without
 * extra calls.
 */
export const META_SCOPES = [
  "email",
  "public_profile",
  "business_management",
  "pages_show_list",
  "pages_read_engagement",
  "pages_manage_posts",
  "pages_manage_engagement",
  "pages_manage_metadata",
  "pages_messaging",
  "instagram_business_basic",
  "instagram_business_content_publish",
  "instagram_business_manage_comments",
  "instagram_business_manage_insights",
  "instagram_business_manage_messages",
] as const;

export const META_SCOPE_DESCRIPTIONS: Record<string, string> = {
  email: "See your email address",
  public_profile: "See your Facebook name + profile photo",
  business_management:
    "Read your Business Portfolio so Lumo can list your Pages and Instagram accounts",
  pages_show_list:
    "List the Facebook Pages you manage",
  pages_read_engagement:
    "Read posts, comments, and engagement insights on your Pages",
  pages_manage_posts:
    "Publish, edit, and delete posts on your Pages (always gated by your confirmation)",
  pages_manage_engagement:
    "Reply to or hide comments on your Pages (gated by confirmation)",
  pages_manage_metadata:
    "Subscribe to webhooks so Lumo's Inbox tab refreshes in real time",
  pages_messaging:
    "Read and reply to Messenger conversations on your Pages (gated by confirmation)",
  instagram_business_basic:
    "Read your Instagram Business account profile + media",
  instagram_business_content_publish:
    "Publish Instagram posts / reels / stories (gated by confirmation)",
  instagram_business_manage_comments:
    "Read and reply to comments on your Instagram media (gated by confirmation)",
  instagram_business_manage_insights:
    "Read Instagram audience + engagement insights",
  instagram_business_manage_messages:
    "Read and reply to Instagram direct messages (gated by confirmation)",
};

// Facebook Login dialog — version-pinned at the URL level. The token
// exchange uses the same /oauth/access_token endpoint regardless of
// scope set, so V1.3+ Messenger additions don't change the URLs.
function buildAuthorizeUrl(): string {
  return `https://www.facebook.com/${getMetaApiVersion()}/dialog/oauth`;
}

function buildTokenUrl(): string {
  return `https://graph.facebook.com/${getMetaApiVersion()}/oauth/access_token`;
}

function buildGraphBase(): string {
  return `https://graph.facebook.com/${getMetaApiVersion()}`;
}

// Exported as plain strings (not URL builders) so the registry's
// synthesized manifest can render them at module load time without
// pulling getMetaApiVersion in. Re-evaluate if you ever override
// LUMO_META_API_VERSION at runtime per request.
export const META_AUTHORIZE_URL = buildAuthorizeUrl();
export const META_TOKEN_URL = buildTokenUrl();
export const META_GRAPH_BASE = buildGraphBase();

// Meta has no first-party OAuth revocation endpoint per scope. Users
// revoke at https://www.facebook.com/settings?tab=business_tools or
// via Business Settings → Apps. Our disconnect flow just drops our
// local encrypted token copy + soft-deletes connected_accounts rows.

// ──────────────────────────────────────────────────────────────────────────
// Env
// ──────────────────────────────────────────────────────────────────────────

export function getMetaAppId(): string | null {
  const v = (process.env.LUMO_META_APP_ID ?? "").trim();
  return v || null;
}

export function getMetaAppSecret(): string | null {
  const v = (process.env.LUMO_META_APP_SECRET ?? "").trim();
  return v || null;
}

export function isMetaConfigured(): boolean {
  return !!(getMetaAppId() && getMetaAppSecret());
}

// ──────────────────────────────────────────────────────────────────────────
// appsecret_proof
// ──────────────────────────────────────────────────────────────────────────

/**
 * Meta strongly recommends — and on certain endpoints requires —
 * `appsecret_proof`: HMAC-SHA256 of the access token, keyed by the app
 * secret, hex-encoded. Including it on every Graph call hardens us
 * against tokens leaked through logs / proxies / browser extensions.
 *
 * Reference: https://developers.facebook.com/docs/graph-api/security/
 */
export function appSecretProof(access_token: string): string | null {
  const secret = getMetaAppSecret();
  if (!secret) return null;
  return createHmac("sha256", secret).update(access_token).digest("hex");
}

// ──────────────────────────────────────────────────────────────────────────
// Long-lived token exchange
// ──────────────────────────────────────────────────────────────────────────

/**
 * Meta's authorize step returns a short-lived (~1h) user access token.
 * Exchange it for a long-lived token (~60d) immediately after callback
 * so the connection survives the first hour without forcing a refresh.
 *
 * Pages tokens derived from the long-lived user token are themselves
 * "page tokens" — those don't expire as long as the user token stays
 * valid, which is why we exchange the user token rather than each
 * page token.
 */
export interface LongLivedTokenResponse {
  access_token: string;
  token_type: "bearer";
  expires_in?: number; // seconds; usually ~5184000 (60d)
}

export async function exchangeShortToLongLived(args: {
  short_lived_token: string;
}): Promise<LongLivedTokenResponse> {
  const appId = getMetaAppId();
  const appSecret = getMetaAppSecret();
  if (!appId || !appSecret) {
    throw new Error("Meta app not configured (LUMO_META_APP_ID / SECRET missing)");
  }
  const url = new URL(buildTokenUrl());
  url.searchParams.set("grant_type", "fb_exchange_token");
  url.searchParams.set("client_id", appId);
  url.searchParams.set("client_secret", appSecret);
  url.searchParams.set("fb_exchange_token", args.short_lived_token);

  const r = await fetch(url.toString(), { method: "GET" });
  if (!r.ok) {
    const text = await r.text().catch(() => "");
    throw new MetaApiError(r.status, text.slice(0, 240));
  }
  return (await r.json()) as LongLivedTokenResponse;
}

// ──────────────────────────────────────────────────────────────────────────
// Authenticated fetch
// ──────────────────────────────────────────────────────────────────────────

/**
 * Thin wrapper around `fetch` for Meta Graph endpoints. Auto-injects
 * appsecret_proof when LUMO_META_APP_SECRET is set. Mirrors the shape
 * of googleFetchJson + msftFetchJson so the connector-archive layer
 * can wrap any of them uniformly.
 *
 * Pass a fully-qualified URL OR a path starting with "/" (we'll
 * prefix with the Graph base). Query params merge in via `query`.
 */
export async function metaFetchJson<T = unknown>(args: {
  access_token: string;
  url: string;
  method?: "GET" | "POST" | "DELETE";
  body?: unknown;
  query?: Record<string, string | number | boolean | undefined>;
  /** Override appsecret_proof injection (Meta recommends always-on). */
  no_proof?: boolean;
  timeoutMs?: number;
}): Promise<T> {
  const isAbsolute = /^https?:\/\//i.test(args.url);
  const u = new URL(isAbsolute ? args.url : `${buildGraphBase()}${args.url.startsWith("/") ? args.url : `/${args.url}`}`);

  if (args.query) {
    for (const [k, v] of Object.entries(args.query)) {
      if (v === undefined) continue;
      u.searchParams.set(k, String(v));
    }
  }
  if (!u.searchParams.has("access_token")) {
    u.searchParams.set("access_token", args.access_token);
  }
  if (!args.no_proof) {
    const proof = appSecretProof(args.access_token);
    if (proof && !u.searchParams.has("appsecret_proof")) {
      u.searchParams.set("appsecret_proof", proof);
    }
  }

  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), args.timeoutMs ?? 15_000);
  try {
    const res = await fetch(u.toString(), {
      method: args.method ?? "GET",
      headers: {
        accept: "application/json",
        ...(args.body ? { "content-type": "application/json" } : {}),
      },
      body: args.body ? JSON.stringify(args.body) : undefined,
      signal: controller.signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new MetaApiError(res.status, text.slice(0, 360));
    }
    return (await res.json()) as T;
  } finally {
    clearTimeout(t);
  }
}

export class MetaApiError extends Error {
  readonly http_status: number;
  /** Meta nests errors as { error: { code, type, message, fbtrace_id } }. */
  readonly meta_code?: number;
  readonly meta_subcode?: number;
  readonly fbtrace_id?: string;

  constructor(status: number, detail: string) {
    super(`Meta Graph ${status}: ${detail}`);
    this.name = "MetaApiError";
    this.http_status = status;
    // Best-effort parse of Meta's structured error envelope. Don't
    // throw inside the constructor if the body isn't JSON.
    try {
      const parsed = JSON.parse(detail);
      const e = parsed?.error;
      if (e) {
        this.meta_code = e.code;
        this.meta_subcode = e.error_subcode;
        this.fbtrace_id = e.fbtrace_id;
        if (e.message) this.message = `Meta Graph ${status}: ${e.message}`;
      }
    } catch {
      // body wasn't JSON; keep the raw detail in this.message.
    }
  }
}

// ──────────────────────────────────────────────────────────────────────────
// /me probe — used by /api/connections/callback to capture the FB user
// id as agent_connections.provider_account_id, and to verify the token
// is alive immediately after exchange.
// ──────────────────────────────────────────────────────────────────────────

export interface MetaSelf {
  id: string;
  name?: string;
  email?: string;
}

export async function metaWhoAmI(args: { access_token: string }): Promise<MetaSelf> {
  return metaFetchJson<MetaSelf>({
    access_token: args.access_token,
    url: "/me",
    query: { fields: "id,name,email" },
  });
}
