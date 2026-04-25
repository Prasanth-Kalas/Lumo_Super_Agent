/**
 * Router. Dispatches a single Claude tool_use to the correct agent.
 *
 * Responsibilities:
 * 1. Look up the routing entry for a tool name.
 * 2. Check the circuit breaker for that agent.
 * 3. Run the confirmation gate for money-moving tools.
 * 4. Resolve the user's OAuth connection to this agent (if the manifest
 *    declares connect.model === "oauth2") and attach Authorization:
 *    Bearer <access_token>. Auto-refresh on near-expiry. If the user
 *    has no active connection, surface a `connection_required` error
 *    so the orchestrator can tell the user to hit /marketplace.
 * 5. Inject only the PII fields the agent was granted.
 * 6. Call the agent over HTTP with an idempotency key.
 * 7. Record success/failure into the breaker.
 */

import {
  evaluateConfirmation,
  LumoAgentError,
  type AgentError,
  type ConfirmationSummary,
  type ToolRoutingEntry,
} from "@lumo/agent-sdk";
import { canCall, recordFailure, recordSuccess } from "./circuit-breaker.js";
import { ensureRegistry } from "./agent-registry.js";
import {
  getDispatchableConnection,
  touchLastUsed,
  ConnectionError,
} from "./connections.js";
import { dispatchInternalTool, isInternalAgent } from "./integrations/registry.js";
import {
  evaluateRuntimePolicy,
  recordRuntimeUsage,
} from "./runtime-policy.js";

export interface DispatchContext {
  user_id: string;
  session_id: string;
  turn_id: string;
  idempotency_key: string;
  region: string;
  device_kind: "web" | "ios" | "android" | "watch";
  prior_summary: ConfirmationSummary | null;
  user_confirmed: boolean;
  /** Opaque PII bag from the shell's identity service. The router filters. */
  user_pii: Record<string, unknown>;
}

export type DispatchOutcome =
  | { ok: true; result: unknown; latency_ms: number }
  | { ok: false; error: AgentError; latency_ms: number };

export async function dispatchToolCall(
  toolName: string,
  args: Record<string, unknown>,
  ctx: DispatchContext,
): Promise<DispatchOutcome> {
  const started = Date.now();
  const registry = await ensureRegistry();
  const routing = registry.bridge.routing[toolName];

  if (!routing) {
    return failure("not_available", `Unknown tool: ${toolName}`, started);
  }

  const agent = Object.values(registry.agents).find(
    (a) => a.manifest.agent_id === routing.agent_id,
  );
  if (!agent) {
    return failure("not_available", `Agent ${routing.agent_id} not registered`, started);
  }

  if (!canCall(routing.agent_id)) {
    return failure(
      "upstream_error",
      `${agent.manifest.display_name} is temporarily unavailable`,
      started,
    );
  }

  // Confirmation gate for money-moving tools.
  if (routing.cost_tier === "money" && routing.requires_confirmation) {
    const evaluated = evaluateConfirmation({
      required_kind: routing.requires_confirmation,
      prior_summary: ctx.prior_summary,
      tool_call_summary_hash: typeof args.summary_hash === "string" ? args.summary_hash : undefined,
      user_confirmed: ctx.user_confirmed,
    });
    if (!evaluated.ok) {
      return failure(
        evaluated.reason === "summary-hash-mismatch" ||
          evaluated.reason === "summary-expired"
          ? "confirmation_mismatch"
          : "confirmation_required",
        evaluated.message ?? "Confirmation required",
        started,
      );
    }
  }

  // Inject only the PII the agent was granted.
  const piiPayload = filterPii(ctx.user_pii, routing.pii_required, agent.manifest.pii_scope);

  // ── Connection / bearer token ────────────────────────────────────
  // If the agent's manifest declares connect.model === "oauth2", the
  // user MUST have an active connection for this agent. We fetch and
  // auto-refresh the token here, then attach it as Authorization:
  // Bearer on the outbound request. For connect.model === "none"
  // (e.g., public weather agent) we skip this entirely. "lumo_id"
  // isn't supported in MVP; treat same as "none" for now.
  //
  // ctx.user_id === "anon" is the "no authenticated user" sentinel
  // used for public-only tools; those only dispatch to "none" agents.
  let authHeader: string | null = null;
  let connectionId: string | null = null;
  if (agent.manifest.connect.model === "oauth2") {
    if (!ctx.user_id || ctx.user_id === "anon") {
      return failure(
        "connection_required",
        `${agent.manifest.display_name} requires you to sign in first.`,
        started,
      );
    }
    try {
      const conn = await getDispatchableConnection({
        user_id: ctx.user_id,
        agent_id: agent.manifest.agent_id,
        oauth2_config: agent.manifest.connect,
      });
      if (!conn) {
        return failure(
          "connection_required",
          `You haven't connected ${agent.manifest.display_name} yet. Open the Marketplace and hit Connect.`,
          started,
          { agent_id: agent.manifest.agent_id, display_name: agent.manifest.display_name },
        );
      }
      authHeader = `Bearer ${conn.access_token}`;
      connectionId = conn.id;
    } catch (err) {
      if (err instanceof ConnectionError) {
        const code: AgentError["code"] =
          err.code === "refresh_failed" || err.code === "not_refreshable"
            ? "connection_refresh_failed"
            : "connection_required";
        return failure(code, err.message, started, {
          agent_id: agent.manifest.agent_id,
          display_name: agent.manifest.display_name,
        });
      }
      throw err;
    }
  }

  const runtimePolicy = await evaluateRuntimePolicy({
    user_id: ctx.user_id,
    agent_id: agent.manifest.agent_id,
    display_name: agent.manifest.display_name,
    connect_model: agent.manifest.connect.model,
    tool_name: toolName,
    cost_tier: routing.cost_tier,
    has_active_connection: connectionId !== null,
  });
  if (!runtimePolicy.ok) {
    return failure(
      mapPolicyToAgentError(runtimePolicy.code),
      runtimePolicy.message ?? "This app cannot be used right now.",
      started,
      runtimePolicy.detail,
    );
  }

  const finish = (outcome: DispatchOutcome): DispatchOutcome => {
    void recordRuntimeUsage({
      user_id: ctx.user_id,
      agent_id: agent.manifest.agent_id,
      tool_name: toolName,
      cost_tier: routing.cost_tier,
      ok: outcome.ok,
      error_code: outcome.ok ? undefined : outcome.error.code,
      latency_ms: outcome.latency_ms,
    });
    return outcome;
  };

  // ── Internal integration dispatch ──────────────────────────────
  // Gmail/Calendar/Contacts run in-process. No HTTP round-trip, no
  // PII body injection (the upstream API already has the user's
  // identity via the Bearer token). Everything else — confirmation
  // gate, circuit-breaker accounting, latency tracking — still runs.
  if (isInternalAgent(agent.manifest.agent_id)) {
    if (!authHeader) {
      return finish(
        failure(
          "connection_required",
          `Connect ${agent.manifest.display_name} before using this.`,
          started,
        ),
      );
    }
    try {
      // authHeader is "Bearer <token>"; strip the prefix.
      const access_token = authHeader.slice("Bearer ".length);
      const result = await dispatchInternalTool({
        tool_name: toolName,
        access_token,
        args,
      });
      recordSuccess(routing.agent_id);
      if (connectionId) void touchLastUsed(connectionId);
      return finish({ ok: true, result, latency_ms: Date.now() - started });
    } catch (err) {
      recordFailure(routing.agent_id);
      const status =
        typeof (err as { http_status?: number })?.http_status === "number"
          ? (err as { http_status: number }).http_status
          : 500;
      const message = err instanceof Error ? err.message : String(err);
      return finish(
        failure(
          status === 401 || status === 403
            ? "connection_refresh_failed"
            : mapHttpToCode(status),
          message,
          started,
        ),
      );
    }
  }

  const url = new URL(routing.path, agent.base_url).toString();
  const body =
    routing.http_method === "GET" || routing.http_method === "DELETE"
      ? undefined
      : JSON.stringify({ ...args, _pii: piiPayload, _ctx: { region: ctx.region, device: ctx.device_kind } });

  try {
    const res = await fetchWithTimeout(url, {
      method: routing.http_method,
      headers: {
        "content-type": "application/json",
        "x-lumo-user-id": ctx.user_id,
        "x-lumo-session-id": ctx.session_id,
        "x-lumo-turn-id": ctx.turn_id,
        "x-idempotency-key": ctx.idempotency_key,
        ...(authHeader ? { authorization: authHeader } : {}),
      },
      body,
      timeoutMs: agent.manifest.sla.p95_latency_ms * 2, // generous
    });

    const latency_ms = Date.now() - started;
    if (!res.ok) {
      recordFailure(routing.agent_id);
      const detail = await safeJson(res);
      return finish(
        {
          ok: false,
          error: {
            code: mapHttpToCode(res.status),
            message: `Agent returned ${res.status}`,
            detail: isRecord(detail) ? detail : undefined,
            at: new Date().toISOString(),
          },
          latency_ms,
        },
      );
    }

    const result = await res.json();
    recordSuccess(routing.agent_id);
    // Fire-and-forget update of the connection's last_used_at so the
    // /connections UI can render "Last used Xm ago" without the router
    // paying the DB round-trip synchronously.
    if (connectionId) void touchLastUsed(connectionId);
    return finish({ ok: true, result, latency_ms });
  } catch (err) {
    recordFailure(routing.agent_id);
    const isAbort = err instanceof Error && err.name === "AbortError";
    return finish(
      failure(
        isAbort ? "upstream_timeout" : "upstream_error",
        err instanceof Error ? err.message : String(err),
        started,
      ),
    );
  }
}

// ──────────────────────────────────────────────────────────────────────────
// Internals
// ──────────────────────────────────────────────────────────────────────────

function failure(
  code: LumoAgentError["code"],
  message: string,
  started: number,
  detail?: Record<string, unknown>,
): DispatchOutcome {
  return {
    ok: false,
    error: {
      code,
      message,
      detail,
      at: new Date().toISOString(),
    },
    latency_ms: Date.now() - started,
  };
}

function mapHttpToCode(status: number): LumoAgentError["code"] {
  if (status === 401 || status === 403) return "connection_refresh_failed";
  if (status === 429) return "rate_limited";
  if (status === 402) return "payment_failed";
  if (status === 409) return "price_changed";
  if (status === 422) return "invalid_input";
  if (status >= 500) return "upstream_error";
  return "upstream_error";
}

function mapPolicyToAgentError(
  code: Awaited<ReturnType<typeof evaluateRuntimePolicy>>["code"],
): LumoAgentError["code"] {
  if (code === "rate_limited") return "rate_limited";
  if (code === "app_not_installed") return "connection_required";
  return "not_available";
}

function filterPii(
  bag: Record<string, unknown>,
  required: string[],
  agentScope: string[],
): Record<string, unknown> {
  const allowed = new Set(required.filter((f) => agentScope.includes(f)));
  return Object.fromEntries(Object.entries(bag).filter(([k]) => allowed.has(k)));
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit & { timeoutMs: number },
): Promise<Response> {
  const { timeoutMs, ...rest } = init;
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), timeoutMs);
  try {
    return await fetch(url, { ...rest, signal: c.signal });
  } finally {
    clearTimeout(t);
  }
}

async function safeJson(res: Response): Promise<unknown> {
  try {
    return await res.json();
  } catch {
    return null;
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
