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
 * Scopes the user grants when they Connect.
 *
 * IMPORTANT: with Facebook Login for Business, scopes are NOT passed
 * as `scope=` query params on the authorize URL. They live inside a
 * **Configuration** that the OAuth dialog references via `config_id`.
 * The list below is the V1.2-launch set bundled inside our Lumo OAuth
 * configuration in the Meta dashboard (config_id 3084025388467252).
 *
 * The marketplace tile + consent disclosure read this list so users
 * see what they're granting before they click Connect. If you change
 * the Configuration in Meta's dashboard, update this list too — the
 * dashboard's binding is source-of-truth at runtime; this list is
 * source-of-truth for our UI copy.
 *
 * Why this V1.2 subset (not the full V1.3+ scope wishlist):
 *   - `pages_manage_posts`, `pages_manage_engagement`, `pages_manage_
 *     metadata` require Advanced Access (App Review). Configurations
 *     in Standard Access can't include them.
 *   - `instagram_business_*` scopes belong to the new Instagram API
 *     with Instagram Login flow (api.instagram.com), not Facebook
 *     Login for Business. We'll add a separate IG Login flow in V1.3
 *     to capture those.
 *   - For V1.2 we ship the legacy `instagram_manage_comments` scope
 *     which works for IG Business accounts linked to a FB Page (the
 *     standard creator setup) under FB Login for Business.
 *
 * Identity scopes (`email`, `public_profile`) are auto-granted by FB
 * Login and don't need to be in the Configuration. We don't list them
 * to avoid the marketplace tile cluttering with redundant rows.
 */
export const META_SCOPES = [
  "business_management",
  "pages_show_list",
  "pages_read_engagement",
  "pages_messaging",
  "instagram_manage_comments",
] as const;

export const META_SCOPE_DESCRIPTIONS: Record<string, string> = {
  business_management:
    "Read your Business Portfolio so Lumo can list your Pages and Instagram accounts",
  pages_show_list: "List the Facebook Pages you manage",
  pages_read_engagement:
    "Read posts, comments, and engagement insights on your Pages",
  pages_messaging:
    "Read and reply to Messenger conversations on your Pages (always gated by your confirmation)",
  instagram_manage_comments:
    "Read and reply to comments on your Instagram Business account (gated by your confirmation; requires your IG Business account to be linked to a Facebook Page)",
};

/**
 * Facebook Login for Business Configuration ID. Created via Meta
 * dashboard → App → Facebook Login for Business → Configurations.
 *
 * The OAuth authorize URL must include `config_id=<this>` instead of
 * `scope=...`. Meta validates the config_id is owned by the same app
 * issuing the request, so there's no risk of leak — but if the
 * config is deleted in the dashboard, OAuth breaks. Treat the dashboard
 * config as a co-versioned dependency of this code.
 *
 * Override path: set LUMO_META_CONFIG_ID in env to point at a different
 * configuration (useful when testing scope-set changes via a fresh
 * config without committing).
 */
const DEFAULT_META_CONFIG_ID = "3084025388467252";

export function getMetaConfigId(): string {
  const v = (process.env.LUMO_META_CONFIG_ID ?? "").trim();
  return v || DEFAULT_META_CONFIG_ID;
}

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
