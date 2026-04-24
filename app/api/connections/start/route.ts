/**
 * POST /api/connections/start
 *
 * Begins an OAuth 2.1 Authorization Code + PKCE flow with a downstream
 * agent. The client calls this with `{ agent_id, redirect_after? }`;
 * we look up the agent's connect block in the registry, mint a PKCE
 * verifier + state, persist them in the oauth_states table keyed to
 * the current user, and return the fully-formed `authorize_url` the
 * browser should navigate to.
 *
 * Returning JSON (not a 302) so the client can preserve history/back
 * behavior the way it wants — typically the marketplace uses
 *   window.location.href = body.authorize_url
 * inside the "Connect" button handler.
 *
 * Middleware guarantees a user is present before this handler runs
 * (see middleware.ts — /api/connections/* is gated).
 */

import { NextResponse, type NextRequest } from "next/server";
import { requireServerUser } from "@/lib/auth";
import { ensureRegistry } from "@/lib/agent-registry";
import {
  mintCodeVerifier,
  codeChallengeS256,
  mintOAuthState,
} from "@/lib/crypto";
import { saveOAuthState } from "@/lib/connections";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface Body {
  agent_id: string;
  redirect_after?: string;
}

export async function POST(req: NextRequest): Promise<Response> {
  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return json({ error: "invalid_json" }, 400);
  }
  if (!body.agent_id || typeof body.agent_id !== "string") {
    return json({ error: "invalid_body", detail: "agent_id is required" }, 400);
  }

  const user = await requireServerUser();

  const registry = await ensureRegistry();
  const entry = Object.values(registry.agents).find(
    (a) => a.manifest.agent_id === body.agent_id,
  );
  if (!entry) {
    return json({ error: "unknown_agent", detail: `No agent with id ${body.agent_id}` }, 404);
  }

  const connect = entry.manifest.connect;
  if (connect.model !== "oauth2") {
    return json(
      {
        error: "not_oauth2",
        detail: `Agent ${body.agent_id} uses connection model "${connect.model}", not oauth2.`,
      },
      400,
    );
  }

  const clientId = process.env[connect.client_id_env];
  if (!clientId) {
    console.error(
      `[connections/start] ${connect.client_id_env} is not set — cannot start OAuth for ${body.agent_id}.`,
    );
    return json({ error: "agent_config_missing" }, 500);
  }

  // PKCE verifier is server-side secret; challenge is what goes on the URL.
  const code_verifier = mintCodeVerifier();
  const code_challenge = codeChallengeS256(code_verifier);
  const state = mintOAuthState();

  const redirect_uri = new URL(
    "/api/connections/callback",
    process.env.LUMO_SHELL_PUBLIC_URL ?? req.nextUrl.origin,
  ).toString();

  // Store state server-side; the callback will match on it.
  try {
    await saveOAuthState({
      state,
      user_id: user.id,
      agent_id: body.agent_id,
      code_verifier,
      redirect_after: sanitizeRedirect(body.redirect_after),
      expires_at: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
    });
  } catch (err) {
    console.error("[connections/start] saveOAuthState failed:", err);
    return json({ error: "state_persist_failed" }, 500);
  }

  // Request all required scopes; the consent UI on the agent side may
  // let the user trim optional ones. We join with space per RFC 6749.
  const scopeString = connect.scopes
    .filter((s) => s.required)
    .map((s) => s.name)
    .join(" ");

  const authorizeUrl = new URL(connect.authorize_url);
  authorizeUrl.searchParams.set("response_type", "code");
  authorizeUrl.searchParams.set("client_id", clientId);
  authorizeUrl.searchParams.set("redirect_uri", redirect_uri);
  authorizeUrl.searchParams.set("scope", scopeString);
  authorizeUrl.searchParams.set("state", state);
  authorizeUrl.searchParams.set("code_challenge", code_challenge);
  authorizeUrl.searchParams.set("code_challenge_method", "S256");

  return json({ authorize_url: authorizeUrl.toString() });
}

function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/**
 * Only allow same-origin paths as `redirect_after` — avoid open redirect.
 * Absolute URLs, protocol-relative, and javascript: URIs are coerced to /.
 */
function sanitizeRedirect(input: string | undefined): string | null {
  if (!input) return null;
  if (typeof input !== "string") return null;
  if (input.startsWith("/") && !input.startsWith("//")) return input;
  return null;
}
