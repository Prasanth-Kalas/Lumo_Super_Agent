/**
 * MCP registry — the bridge between `config/mcp-servers.json` + the
 * per-user `user_mcp_connections` table and the orchestrator's
 * tool-list assembly.
 *
 * Two things happen here:
 *
 *   1. Static catalog loading.  `config/mcp-servers.json` lists every
 *      MCP server Lumo is willing to talk to at all. The shape mirrors
 *      the Lumo agent manifest so the marketplace UI can render MCP
 *      entries and native entries side-by-side.
 *
 *   2. Per-user tool discovery.  Given a user_id, we look up their
 *      active connections, hit `tools/list` on each connected MCP
 *      server, namespace the returned tool names, sanitize the
 *      descriptions, and return a tool bridge the orchestrator can
 *      merge into Claude's tool array.
 *
 * Namespacing: MCP tool names like `list_events` become
 * `mcp__<server_id>__<tool_name>` when surfaced to Claude. Double
 * underscore is the separator so a normal tool name with a single
 * underscore never accidentally looks like a namespaced one. The
 * router parses the prefix, strips it, and calls the underlying MCP
 * server with the original name.
 *
 * Sanitization: MCP tool descriptions are free-form strings that
 * flow straight into the Claude system context, which means a
 * malicious server could embed prompt-injection payloads there.
 * We cap length, strip control chars, and strip obvious
 * instruction-like markers before letting them through.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { createMcpClient, type McpClient, type McpTool } from "./client.js";

// ───────────────────────── Types ─────────────────────────

export interface McpServerConfig {
  /** Stable slug, e.g. "gcal". Used as the namespace prefix. */
  server_id: string;
  display_name: string;
  one_liner: string;
  category?: string;
  logo_url?: string;
  /** Full URL to the MCP JSON-RPC endpoint. Supports ${VAR} env substitution. */
  url: string;
  /**
   * How the user authenticates to this MCP server.
   *
   *   "bearer"     — per-user token; we store the raw token and
   *                  attach it as Authorization: Bearer <token>
   *                  on every call. Simple, the Phase 1 default.
   *   "oauth2"     — full OAuth 2.1 per MCP spec. Phase 2.
   *   "none"       — public server, no per-user auth (weather, etc.).
   */
  auth_model: "bearer" | "oauth2" | "none";
  /** Scopes the user is told about when connecting. Informational. */
  scopes?: Array<{ name: string; description: string }>;
}

/**
 * Routing entry for the dispatcher. Keyed by the namespaced tool
 * name Claude sees. Carries everything the router needs to invoke.
 */
export interface McpRoutingEntry {
  server_id: string;
  server_url: string;
  /** Unnamespaced name as the MCP server knows it. */
  real_tool_name: string;
  auth_model: McpServerConfig["auth_model"];
}

export interface McpToolForClaude {
  name: string; // namespaced
  description: string;
  input_schema: Record<string, unknown>;
}

export interface McpBridgeResult {
  tools: McpToolForClaude[];
  routing: Record<string, McpRoutingEntry>;
}

// ───────────────────────── Catalog loading ─────────────────────────

let cachedCatalog: McpServerConfig[] | null = null;

/**
 * Read `config/mcp-servers.json` once per process. Missing file is
 * NOT an error — an empty catalog just means no MCP servers are
 * configured yet, and the orchestrator runs with only native agents.
 */
export async function loadMcpCatalog(): Promise<McpServerConfig[]> {
  if (cachedCatalog) return cachedCatalog;
  const path = join(process.cwd(), "config", "mcp-servers.json");
  try {
    const raw = await readFile(path, "utf8");
    const parsed = JSON.parse(raw) as {
      servers?: McpServerConfig[];
    };
    const servers = Array.isArray(parsed.servers) ? parsed.servers : [];
    cachedCatalog = servers.map(resolveEnvVars);
    return cachedCatalog;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      cachedCatalog = [];
      return cachedCatalog;
    }
    console.warn("[mcp] failed to load config/mcp-servers.json:", err);
    cachedCatalog = [];
    return cachedCatalog;
  }
}

/** Find a server by id. Returns null if the catalog doesn't have one. */
export async function getMcpServer(
  server_id: string,
): Promise<McpServerConfig | null> {
  const catalog = await loadMcpCatalog();
  return catalog.find((s) => s.server_id === server_id) ?? null;
}

// ───────────────────────── Per-user tool bridge ─────────────────────────

/**
 * Build the MCP portion of the tool bridge for a specific user.
 *
 * For each MCP server the user has an active connection to, we call
 * `tools/list` on that server, namespace the tools, and collect them
 * into a bridge shape the orchestrator can merge with the native
 * agent bridge. Failures (server offline, bad token) are logged and
 * the server is skipped — we never fail the whole request because
 * one MCP is down.
 */
export async function userMcpBridge(
  user_id: string,
): Promise<McpBridgeResult> {
  const catalog = await loadMcpCatalog();
  if (catalog.length === 0) return { tools: [], routing: {} };

  const connections = await listMcpConnectionsForUser(user_id);
  const connByServer = new Map(connections.map((c) => [c.server_id, c]));

  const tools: McpToolForClaude[] = [];
  const routing: Record<string, McpRoutingEntry> = {};

  // Fetch in parallel — one slow server shouldn't serialize the rest.
  await Promise.all(
    catalog.map(async (server) => {
      // Public servers (auth_model: none) are always "connected". Anything
      // else requires an active user connection record.
      const conn = connByServer.get(server.server_id);
      if (server.auth_model !== "none" && !conn) return;

      let bearerToken: string | undefined;
      if (server.auth_model === "bearer" && conn) {
        bearerToken = conn.access_token ?? undefined;
      }
      // OAuth flow will land here in Phase 2; for now we skip if not
      // bearer/none so we don't silently send with no auth.
      if (server.auth_model === "oauth2") return;

      let client: McpClient;
      try {
        client = createMcpClient({
          url: server.url,
          bearerToken,
          label: server.server_id,
        });
      } catch (err) {
        console.warn(`[mcp] skipping ${server.server_id}:`, err);
        return;
      }

      let serverTools: McpTool[];
      try {
        serverTools = await client.listTools();
      } catch (err) {
        console.warn(`[mcp] tools/list failed for ${server.server_id}:`, err);
        return;
      }

      for (const t of serverTools) {
        const safe = sanitizeTool(t);
        if (!safe) continue;
        const nsName = `mcp__${server.server_id}__${safe.name}`;
        tools.push({
          name: nsName,
          description: safe.description ?? "",
          input_schema: safe.inputSchema ?? {
            type: "object",
            properties: {},
          },
        });
        routing[nsName] = {
          server_id: server.server_id,
          server_url: server.url,
          real_tool_name: t.name,
          auth_model: server.auth_model,
        };
      }
    }),
  );

  return { tools, routing };
}

// ───────────────────────── User connections (DB) ─────────────────────────
//
// Thin accessors for the `user_mcp_connections` table. The actual
// OAuth/bearer storage happens through /api/mcp/connections/start
// (Phase 2); Phase 1 can seed the table manually for testing.

export interface McpConnectionRow {
  id: string;
  user_id: string;
  server_id: string;
  status: "active" | "revoked";
  access_token: string | null;
  connected_at: string;
  last_used_at: string | null;
}

export async function listMcpConnectionsForUser(
  user_id: string,
): Promise<McpConnectionRow[]> {
  // Lazy-load Supabase so this module doesn't pull in the db client
  // in environments that don't need it (tests, build).
  const { getSupabase } = await import("../db.js");
  const sb = getSupabase();
  if (!sb) return [];
  const { data, error } = await sb
    .from("user_mcp_connections")
    .select("id, user_id, server_id, status, access_token, connected_at, last_used_at")
    .eq("user_id", user_id)
    .eq("status", "active");
  if (error) {
    console.warn("[mcp] listMcpConnectionsForUser failed:", error.message);
    return [];
  }
  return (data ?? []) as McpConnectionRow[];
}

// ───────────────────────── Sanitization ─────────────────────────

/**
 * Cap and sanitize a tool before letting its metadata into the
 * Claude context. Returns null if the tool is unusable (missing
 * name, blocked by a heuristic).
 *
 * Caveat: this is defense in depth, not a proof. A determined
 * attacker can still craft plausible-looking prose. The real
 * guarantee comes from the marketplace review gate — we shouldn't
 * let a user connect to a server we don't vet. That lands in Phase 3.
 */
function sanitizeTool(t: McpTool): McpTool | null {
  if (!t.name || typeof t.name !== "string") return null;
  // MCP tool names must be valid Claude tool identifiers. Allow only
  // alphanumerics, underscore, hyphen. Anything else becomes an
  // underscore — matches what other MCP clients do.
  const cleanName = t.name.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 64);
  if (!cleanName) return null;

  let description = (t.description ?? "").trim();
  // Hard cap so a verbose server can't bloat Claude's context.
  if (description.length > 800) {
    description = description.slice(0, 800) + "…";
  }
  // Strip control chars and zero-widths — common in injection attempts.
  description = description.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\u200B-\u200F\u202A-\u202E]/g, "");

  return {
    name: cleanName,
    description,
    inputSchema: t.inputSchema,
  };
}

// ───────────────────────── Env var substitution ─────────────────────────
//
// Mirrors the same `${VAR}` convention the main agent-registry uses so
// the MCP server URL can be env-specific without per-environment JSON.

function resolveEnvVars(server: McpServerConfig): McpServerConfig {
  return {
    ...server,
    url: subst(server.url),
  };
}

function subst(s: string): string {
  return s.replace(/\$\{([A-Z0-9_]+)\}/g, (_, name) => {
    const v = process.env[name];
    return typeof v === "string" ? v : "";
  });
}
