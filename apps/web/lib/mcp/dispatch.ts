/**
 * Dispatch a single Claude tool_use whose name is in the MCP
 * namespace. Parallel surface to lib/router.ts::dispatchToolCall
 * but simpler — no confirmation gate (MCP is read-heavy for now),
 * no compound-trip integration, no circuit breaker. If/when MCP
 * grows side-effectful tools we care about, those pieces can
 * migrate in.
 *
 * Input: the namespaced tool name (mcp__<server>__<tool>), args
 * from Claude, and the user context from the orchestrator.
 * Output: a shape that looks enough like the native agent
 * response that the orchestrator's tool_result construction can
 * treat it uniformly — specifically, a JSON-able object with the
 * MCP content blocks preserved so Claude can see them.
 */

import { createMcpClient, McpClientError } from "./client.js";
import {
  getMcpServer,
  listMcpConnectionsForUser,
  type McpRoutingEntry,
} from "./registry.js";

export interface McpDispatchContext {
  user_id: string;
}

export interface McpDispatchResult {
  ok: boolean;
  /** Pass-through of content blocks (text/image/resource refs). */
  content: Array<{
    type: string;
    text?: string;
    data?: string;
    mimeType?: string;
    uri?: string;
  }>;
  /** Server-signaled tool error (isError flag) or our own transport error. */
  error?: { code: string; message: string };
}

/**
 * Check whether a tool name belongs to an MCP server. Cheap string
 * check; callers use it to branch before doing full routing lookup.
 */
export function isMcpToolName(name: string): boolean {
  return typeof name === "string" && name.startsWith("mcp__");
}

/**
 * Run the tool call. The routing entry is looked up from the
 * per-turn MCP bridge (orchestrator caches it). Caller is expected
 * to have resolved it; passing null means "unknown tool", which we
 * surface as an error rather than crashing.
 */
export async function dispatchMcpTool(
  toolName: string,
  routing: McpRoutingEntry | null,
  args: Record<string, unknown>,
  ctx: McpDispatchContext,
): Promise<McpDispatchResult> {
  if (!routing) {
    return {
      ok: false,
      content: [],
      error: { code: "not_available", message: `Unknown MCP tool: ${toolName}` },
    };
  }
  const server = await getMcpServer(routing.server_id);
  if (!server) {
    return {
      ok: false,
      content: [],
      error: {
        code: "not_available",
        message: `MCP server ${routing.server_id} is not configured`,
      },
    };
  }

  // Resolve the bearer token for this user. For public (auth_model =
  // "none") servers we don't attach one; for "bearer" we look up
  // the active connection; for "oauth2" (not yet supported in Phase 1)
  // we bail out.
  let bearerToken: string | undefined;
  if (server.auth_model === "bearer") {
    const conns = await listMcpConnectionsForUser(ctx.user_id);
    const row = conns.find((c) => c.server_id === server.server_id);
    if (!row?.access_token) {
      return {
        ok: false,
        content: [],
        error: {
          code: "connection_required",
          message: `Connect ${server.display_name} before using this.`,
        },
      };
    }
    bearerToken = row.access_token;
  } else if (server.auth_model === "oauth2") {
    return {
      ok: false,
      content: [],
      error: {
        code: "not_available",
        message: `OAuth for ${server.display_name} is not wired yet.`,
      },
    };
  }

  const client = createMcpClient({
    url: server.url,
    bearerToken,
    label: server.server_id,
  });

  try {
    const res = await client.callTool(routing.real_tool_name, args);
    return {
      ok: !res.isError,
      content: Array.isArray(res.content) ? res.content : [],
      error: res.isError
        ? { code: "upstream_error", message: "Tool reported an error" }
        : undefined,
    };
  } catch (err) {
    if (err instanceof McpClientError) {
      return {
        ok: false,
        content: [],
        error: {
          code:
            err.cause_detail?.kind === "auth"
              ? "connection_refresh_failed"
              : err.cause_detail?.kind === "timeout"
                ? "timeout"
                : "upstream_error",
          message: err.message,
        },
      };
    }
    return {
      ok: false,
      content: [],
      error: {
        code: "upstream_error",
        message: err instanceof Error ? err.message : String(err),
      },
    };
  }
}
