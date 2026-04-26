/**
 * GET /api/connections/callback?code=…&state=…
 *
 * OAuth 2.1 authorization-code callback. The downstream agent redirects
 * the user here after consent. We:
 *
 *   1. Consume the oauth_states row — must exist, must not be expired,
 *      must belong to the current Lumo user.
 *   2. Exchange the code for tokens at the agent's token_url using the
 *      PKCE verifier we stashed on start.
 *   3. Persist tokens encrypted in agent_connections.
 *   4. Redirect the user to the `redirect_after` stored at start
 *      (defaults to /connections).
 *
 * Error cases redirect to /connections?error=… so the UI can show a
 * toast rather than the user landing on a JSON blob.
 */

import { NextResponse, type NextRequest } from "next/server";
import { requireServerUser } from "@/lib/auth";
import { ensureRegistry } from "@/lib/agent-registry";
import {
  consumeOAuthState,
  exchangeAuthorizationCode,
  listConnectionsForUser,
  saveConnection,
} from "@/lib/connections";
import { constantTimeEqual } from "@/lib/crypto";
import { permissionSnapshotForManifest } from "@/lib/app-installs";
import { hasRecentActiveOAuthConnection } from "@/lib/oauth-callback";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest): Promise<Response> {
  const url = req.nextUrl;
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const oauthError = url.searchParams.get("error");

  // Agent-side error (user denied consent, etc.) arrives as `?error=…`.
  if (oauthError) {
    return redirectBack(url, `/connections?error=${encodeURIComponent(oauthError)}`);
  }
  if (!code || !state) {
    return redirectBack(url, "/connections?error=missing_code_or_state");
  }

  let user;
  try {
    user = await requireServerUser();
  } catch {
    // Rare: session expired between start and callback. Send to login
    // with a next= that brings them back to this callback.
    const login = new URL("/login", url.origin);
    login.search = `?next=${encodeURIComponent(url.pathname + url.search)}`;
    return NextResponse.redirect(login);
  }

  const stateRow = await consumeOAuthState(state);
  if (!stateRow) {
    const recentConnections = await listConnectionsForUser(user.id);
    if (hasRecentActiveOAuthConnection(recentConnections)) {
      return redirectBack(url, "/connections?connected=1");
    }
    return redirectBack(url, "/connections?error=invalid_or_expired_state");
  }

  // State rows are single-use and scoped to a Lumo user. If the session
  // on this callback doesn't match the user the state was minted for,
  // someone's attempting an attack.
  if (!constantTimeEqual(stateRow.user_id, user.id)) {
    console.warn(
      `[connections/callback] state user mismatch: state.user=${stateRow.user_id} session.user=${user.id}`,
    );
    return redirectBack(url, "/connections?error=state_user_mismatch");
  }

  const registry = await ensureRegistry();
  const entry = Object.values(registry.agents).find(
    (a) => a.manifest.agent_id === stateRow.agent_id,
  );
  if (!entry) {
    return redirectBack(url, "/connections?error=agent_removed");
  }
  const connect = entry.manifest.connect;
  if (connect.model !== "oauth2") {
    return redirectBack(url, "/connections?error=not_oauth2");
  }

  const redirect_uri = new URL(
    "/api/connections/callback",
    process.env.LUMO_SHELL_PUBLIC_URL ?? url.origin,
  ).toString();

  try {
    const tokens = await exchangeAuthorizationCode({
      code,
      code_verifier: stateRow.code_verifier,
      redirect_uri,
      oauth2_config: connect,
    });

    const scopes_granted =
      typeof tokens.scope === "string" && tokens.scope.length > 0
        ? tokens.scope.split(/\s+/)
        : connect.scopes.filter((s) => s.required).map((s) => s.name);

    await saveConnection({
      user_id: user.id,
      agent_id: stateRow.agent_id,
      tokens,
      scopes_granted,
      permissions: {
        ...permissionSnapshotForManifest(entry.manifest),
        granted_scopes: scopes_granted,
      },
    });

    const dest = stateRow.redirect_after ?? "/connections?connected=1";
    return redirectBack(url, dest);
  } catch (err) {
    console.error("[connections/callback] exchange failed:", err);
    const msg = err instanceof Error ? err.message : "exchange_failed";
    return redirectBack(url, `/connections?error=${encodeURIComponent(msg)}`);
  }
}

function redirectBack(reqUrl: URL, toPath: string): Response {
  // Build an absolute URL using the incoming request's origin as base.
  // We use `new URL(path, base)` rather than NextURL.clone() so the
  // signature accepts both NextURL and plain URL.
  const [path, qs] = toPath.split("?");
  const dest = new URL(path ?? "/connections", reqUrl.origin);
  if (qs) dest.search = `?${qs}`;
  return NextResponse.redirect(dest);
}
