/**
 * Router. Dispatches a single Claude tool_use to the correct agent.
 *
 * Responsibilities:
 * 1. Look up the routing entry for a tool name.
 * 2. Check the circuit breaker for that agent.
 * 3. Run the confirmation gate for money-moving tools.
 * 4. Inject only the PII fields the agent was granted.
 * 5. Call the agent over HTTP with an idempotency key.
 * 6. Record success/failure into the breaker.
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
      },
      body,
      timeoutMs: agent.manifest.sla.p95_latency_ms * 2, // generous
    });

    const latency_ms = Date.now() - started;
    if (!res.ok) {
      recordFailure(routing.agent_id);
      const detail = await safeJson(res);
      return {
        ok: false,
        error: {
          code: mapHttpToCode(res.status),
          message: `Agent returned ${res.status}`,
          detail: isRecord(detail) ? detail : undefined,
          at: new Date().toISOString(),
        },
        latency_ms,
      };
    }

    const result = await res.json();
    recordSuccess(routing.agent_id);
    return { ok: true, result, latency_ms };
  } catch (err) {
    recordFailure(routing.agent_id);
    const isAbort = err instanceof Error && err.name === "AbortError";
    return failure(
      isAbort ? "upstream_timeout" : "upstream_error",
      err instanceof Error ? err.message : String(err),
      started,
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
): DispatchOutcome {
  return {
    ok: false,
    error: {
      code,
      message,
      at: new Date().toISOString(),
    },
    latency_ms: Date.now() - started,
  };
}

function mapHttpToCode(status: number): LumoAgentError["code"] {
  if (status === 429) return "rate_limited";
  if (status === 402) return "payment_failed";
  if (status === 409) return "price_changed";
  if (status === 422) return "invalid_input";
  if (status >= 500) return "upstream_error";
  return "upstream_error";
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
