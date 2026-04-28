/**
 * /api/mcp/connections — manage the current user's MCP server
 * connections.
 *
 *   GET    → list active connections (id, server_id, connected_at,
 *            last_used_at). Never returns the access token.
 *   POST   → upsert a connection. Body: { server_id, access_token }.
 *            Used by the token-paste flow in /marketplace.
 *   DELETE → revoke a connection. Query: ?server_id=<id>.
 *
 * Token-paste is Phase 1's connect model. Servers that support
 * OAuth 2.1 Dynamic Client Registration will get a proper browser
 * redirect flow in Phase 1c — until then, a user who wants to use
 * (say) Google Calendar generates a personal token in their own
 * console and pastes it here. Clearly marked "developer preview"
 * in the UI so we don't mislead normies.
 *
 * Security:
 *   - All routes require an authenticated user. Middleware
 *     (PROTECTED_API_PREFIXES) enforces that.
 *   - Token body is sealed via lib/crypto.ts before it is written to
 *     user_mcp_connections. The table stores ciphertext, IV, and tag only.
 *   - server_id is validated against the static catalog so a
 *     malicious client can't register a token against a server
 *     slug we don't know.
 */

import type { NextRequest } from "next/server";
import { requireServerUser } from "@/lib/auth";
import { getSupabase } from "@/lib/db";
import { getMcpServer } from "@/lib/mcp/registry";
import { sealToPgColumns } from "@/lib/sealed-token-columns";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface ConnectionRowOut {
  id: string;
  server_id: string;
  status: "active" | "revoked";
  connected_at: string;
  last_used_at: string | null;
}

export async function GET(_req: NextRequest): Promise<Response> {
  const user = await requireServerUser();
  const sb = getSupabase();
  if (!sb) return json({ connections: [] });
  const { data, error } = await sb
    .from("user_mcp_connections")
    .select("id, server_id, status, connected_at, last_used_at")
    .eq("user_id", user.id)
    .order("connected_at", { ascending: false });
  if (error) {
    return json({ error: error.message }, 500);
  }
  const connections: ConnectionRowOut[] = (data ?? []) as ConnectionRowOut[];
  return json({ connections });
}

export async function POST(req: NextRequest): Promise<Response> {
  const user = await requireServerUser();
  let body: { server_id?: unknown; access_token?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return json({ error: "invalid_json" }, 400);
  }

  const server_id =
    typeof body.server_id === "string" ? body.server_id.trim() : "";
  const access_token =
    typeof body.access_token === "string" ? body.access_token.trim() : "";
  if (!server_id) return json({ error: "missing_server_id" }, 400);
  if (!access_token) return json({ error: "missing_token" }, 400);

  // Validate against the static catalog. Prevents a client from
  // writing a row for a server slug we don't actually support,
  // which would be dead data and an attack vector for manifest
  // impersonation later.
  const server = await getMcpServer(server_id);
  if (!server) return json({ error: "unknown_server" }, 400);
  if (server.auth_model !== "bearer") {
    return json(
      {
        error: "auth_model_mismatch",
        detail:
          "This server doesn't use bearer-token auth. Use the OAuth flow once it ships.",
      },
      400,
    );
  }

  const sb = getSupabase();
  if (!sb) return json({ error: "db_unavailable" }, 503);

  // Upsert so re-connecting after a revoke (or rotating a token)
  // doesn't create duplicate rows. unique(user_id, server_id) in
  // the migration backs this.
  const { data, error } = await sb
    .from("user_mcp_connections")
    .upsert(
      {
        user_id: user.id,
        server_id,
        ...sealToPgColumns(access_token, "access_token"),
        status: "active",
        connected_at: new Date().toISOString(),
      },
      { onConflict: "user_id,server_id" },
    )
    .select("id, server_id, status, connected_at, last_used_at")
    .single();

  if (error) return json({ error: error.message }, 500);

  return json({ connection: data });
}

export async function DELETE(req: NextRequest): Promise<Response> {
  const user = await requireServerUser();
  const url = new URL(req.url);
  const server_id = url.searchParams.get("server_id");
  if (!server_id) return json({ error: "missing_server_id" }, 400);

  const sb = getSupabase();
  if (!sb) return json({ error: "db_unavailable" }, 503);

  // Prefer revoke over delete so audit trails survive. If we later
  // want a hard-delete path (GDPR), add a separate route.
  const { error } = await sb
    .from("user_mcp_connections")
    .update({ status: "revoked" })
    .eq("user_id", user.id)
    .eq("server_id", server_id);

  if (error) return json({ error: error.message }, 500);
  return json({ revoked: true });
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}
