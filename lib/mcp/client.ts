/**
 * Thin MCP (Model Context Protocol) client.
 *
 * Implements the two JSON-RPC methods we need to be useful inside the
 * Super Agent:
 *
 *   tools/list   — discover what a server exposes
 *   tools/call   — invoke a tool and get back content blocks
 *
 * Scope deliberately narrow for Phase 1 of the external-agents plan:
 *
 *   - HTTP transport only (no stdio — doesn't fit multi-tenant web).
 *   - Bearer-token auth only (per-user tokens stored in Supabase;
 *     OAuth 2.1 Dynamic Client Registration can follow).
 *   - Lazy initialize: the spec says every session must begin with
 *     an `initialize` call. We do that on the first `tools/list` and
 *     cache the session capabilities per server URL.
 *   - No resources/prompts support. They're real MCP primitives but
 *     Claude's tool API is a tool-only surface — resources would need
 *     orchestrator-level support we're not building yet.
 *
 * Security: this module does NOT trust server output. The caller
 * (lib/mcp/registry.ts) sanitizes tool names/descriptions before they
 * flow into the system prompt. Assume any string returned here could
 * be hostile and never blindly interpolate into Claude context.
 */

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: number | string;
  method: string;
  params?: unknown;
}

interface JsonRpcResponse<T = unknown> {
  jsonrpc: "2.0";
  id: number | string | null;
  result?: T;
  error?: { code: number; message: string; data?: unknown };
}

export interface McpTool {
  name: string;
  description?: string;
  /** Standard JSON Schema for tool inputs. Passed through to Claude. */
  inputSchema?: Record<string, unknown>;
}

export interface McpToolsListResult {
  tools: McpTool[];
  /** Servers that paginate return a cursor; we follow it until exhausted. */
  nextCursor?: string;
}

export interface McpContentBlock {
  type: "text" | "image" | "resource";
  text?: string;
  /** For image blocks — base64-encoded data + mime type. */
  data?: string;
  mimeType?: string;
  /** For resource blocks — URI reference back to the server. */
  uri?: string;
}

export interface McpToolCallResult {
  content: McpContentBlock[];
  /** Spec says servers MAY indicate the call itself errored vs. returned. */
  isError?: boolean;
}

export interface McpClientOptions {
  /** Full URL to the MCP server's JSON-RPC endpoint. */
  url: string;
  /** Bearer token to attach as Authorization header. Optional. */
  bearerToken?: string;
  /** Opaque identifier for logs / telemetry. Typically the server id. */
  label?: string;
  /** Fetch timeout per request, ms. Defaults to 15s. */
  timeoutMs?: number;
}

/**
 * Error thrown on transport or protocol-level failures. Tool-level
 * errors (result.isError === true) come back through the normal
 * return path so the orchestrator can surface them as tool errors
 * to Claude without needing try/catch.
 */
export class McpClientError extends Error {
  constructor(
    message: string,
    public readonly cause_detail?: {
      kind: "transport" | "protocol" | "timeout" | "auth";
      status?: number;
      rpc_code?: number;
    },
  ) {
    super(message);
    this.name = "McpClientError";
  }
}

/**
 * Create a client for one MCP server. Clients are cheap to construct;
 * the registry keeps them per-user-per-server for the life of a
 * request. Don't cache across requests — bearer tokens expire and we
 * re-fetch per dispatch anyway.
 */
export function createMcpClient(opts: McpClientOptions): McpClient {
  return new McpClient(opts);
}

export class McpClient {
  private nextId = 1;
  private initialized = false;
  private readonly timeoutMs: number;

  constructor(private readonly opts: McpClientOptions) {
    this.timeoutMs = opts.timeoutMs ?? 15_000;
  }

  /** One-shot tool discovery, including pagination. Initializes if needed. */
  async listTools(): Promise<McpTool[]> {
    await this.ensureInitialized();
    const out: McpTool[] = [];
    let cursor: string | undefined;
    // Guard against a pathological server paginating forever.
    for (let page = 0; page < 50; page++) {
      const res = await this.rpc<McpToolsListResult>(
        "tools/list",
        cursor ? { cursor } : undefined,
      );
      if (Array.isArray(res.tools)) out.push(...res.tools);
      if (!res.nextCursor) break;
      cursor = res.nextCursor;
    }
    return out;
  }

  /** Invoke a tool and return the raw content blocks. */
  async callTool(
    name: string,
    args: Record<string, unknown>,
  ): Promise<McpToolCallResult> {
    await this.ensureInitialized();
    return this.rpc<McpToolCallResult>("tools/call", {
      name,
      arguments: args,
    });
  }

  // ────────────────────────────────────────────────────────────────
  // Internals
  // ────────────────────────────────────────────────────────────────

  private async ensureInitialized(): Promise<void> {
    if (this.initialized) return;
    // The MCP spec says every session begins with `initialize`. We
    // don't actually use the result (capabilities negotiation is for
    // advanced features like resources/prompts); we just need to send
    // it so servers that enforce the protocol don't reject us. Many
    // public MCP servers are lenient here, but we do this anyway for
    // correctness.
    await this.rpc("initialize", {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: {
        name: "lumo-super-agent",
        version: "0.1.0",
      },
    });
    // The spec also requires us to send `notifications/initialized`
    // after. It's a notification (no response expected); we fire it
    // but don't await the RPC semantics.
    try {
      await this.notify("notifications/initialized");
    } catch {
      // Ignore — some servers accept it, some don't. Harmless either way.
    }
    this.initialized = true;
  }

  private async rpc<T>(method: string, params?: unknown): Promise<T> {
    const id = this.nextId++;
    const body: JsonRpcRequest = {
      jsonrpc: "2.0",
      id,
      method,
      ...(params !== undefined ? { params } : {}),
    };
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), this.timeoutMs);
    let res: Response;
    try {
      res = await fetch(this.opts.url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          // Accept both JSON and SSE — the streamable HTTP transport
          // from the spec upgrades long-running calls to SSE. We only
          // read the first JSON-RPC response we can parse; streaming
          // support is a later enhancement.
          accept: "application/json, text/event-stream",
          ...(this.opts.bearerToken
            ? { authorization: `Bearer ${this.opts.bearerToken}` }
            : {}),
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (err) {
      if ((err as Error).name === "AbortError") {
        throw new McpClientError(
          `MCP ${this.opts.label ?? "server"} timed out after ${this.timeoutMs}ms`,
          { kind: "timeout" },
        );
      }
      throw new McpClientError(
        `MCP ${this.opts.label ?? "server"} network error: ${(err as Error).message}`,
        { kind: "transport" },
      );
    } finally {
      clearTimeout(t);
    }

    if (res.status === 401 || res.status === 403) {
      throw new McpClientError(
        `MCP ${this.opts.label ?? "server"} rejected auth (${res.status})`,
        { kind: "auth", status: res.status },
      );
    }
    if (!res.ok) {
      throw new McpClientError(
        `MCP ${this.opts.label ?? "server"} HTTP ${res.status}`,
        { kind: "transport", status: res.status },
      );
    }

    // Streamable HTTP servers return text/event-stream for calls the
    // server wants to report progress on. Per the spec the FINAL SSE
    // event carries the JSON-RPC response. We consume until we find it.
    const contentType = res.headers.get("content-type") ?? "";
    if (contentType.includes("text/event-stream")) {
      const final = (await readFinalSseMessage(res)) as JsonRpcResponse<T>;
      return assertResult<T>(final, id);
    }

    const json = (await res.json()) as JsonRpcResponse<T>;
    return assertResult<T>(json, id);
  }

  /** Fire-and-forget JSON-RPC notification (no id, no response). */
  private async notify(method: string, params?: unknown): Promise<void> {
    const body = {
      jsonrpc: "2.0" as const,
      method,
      ...(params !== undefined ? { params } : {}),
    };
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      await fetch(this.opts.url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          ...(this.opts.bearerToken
            ? { authorization: `Bearer ${this.opts.bearerToken}` }
            : {}),
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch {
      // Notifications are best-effort. A dropped initialized-notify
      // on a lenient server doesn't break us.
    } finally {
      clearTimeout(t);
    }
  }
}

function assertResult<T>(
  res: JsonRpcResponse<T>,
  expectedId: number | string,
): T {
  if (res.id !== expectedId) {
    throw new McpClientError(
      `MCP response id mismatch: expected ${expectedId}, got ${res.id ?? "null"}`,
      { kind: "protocol" },
    );
  }
  if (res.error) {
    throw new McpClientError(res.error.message, {
      kind: "protocol",
      rpc_code: res.error.code,
    });
  }
  if (res.result === undefined) {
    throw new McpClientError("MCP response missing result", {
      kind: "protocol",
    });
  }
  return res.result;
}

/**
 * Minimal SSE reader: consumes the stream until it sees the last
 * `data:` payload that parses as a JSON-RPC response. The streamable
 * HTTP spec is more nuanced than this (notifications, progress
 * events) but for tools/call we only care about the terminal
 * response object.
 */
async function readFinalSseMessage(
  res: Response,
): Promise<JsonRpcResponse<unknown>> {
  if (!res.body) {
    throw new McpClientError("SSE response had no body", { kind: "protocol" });
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let lastParsed: JsonRpcResponse<unknown> | null = null;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    // SSE events end in \n\n; split out any complete events.
    let sep = buffer.indexOf("\n\n");
    while (sep !== -1) {
      const raw = buffer.slice(0, sep);
      buffer = buffer.slice(sep + 2);
      const dataLine = raw
        .split("\n")
        .map((l) => l.trim())
        .find((l) => l.startsWith("data:"));
      if (dataLine) {
        const payload = dataLine.slice("data:".length).trim();
        try {
          const parsed = JSON.parse(payload) as JsonRpcResponse<unknown>;
          // Only the response we care about has an "id" that matches
          // our request — progress notifications don't. Keep the
          // latest id-bearing one.
          if (parsed.id !== null && parsed.id !== undefined) {
            lastParsed = parsed;
          }
        } catch {
          // Not JSON; ignore.
        }
      }
      sep = buffer.indexOf("\n\n");
    }
  }
  if (!lastParsed) {
    throw new McpClientError("SSE stream ended without a JSON-RPC response", {
      kind: "protocol",
    });
  }
  return lastParsed;
}
