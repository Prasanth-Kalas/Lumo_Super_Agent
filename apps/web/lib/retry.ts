/**
 * Retry policy for agent tool calls.
 *
 * Why it lives here and not in `router.ts`:
 *
 *   The router is a primitive — "dispatch this tool once". The policy
 *   of "when to retry, how many times, how long to back off" is a
 *   business decision that belongs above the primitive. Keeping it
 *   separate means:
 *     - Tests can drive the router without a retry loop interfering.
 *     - Callers that need single-shot semantics (e.g., the main tool-use
 *       loop, where Claude will itself re-plan on failure) skip retries.
 *     - Callers that need durable "don't rollback a whole trip because
 *       the vendor had a 502" semantics (the Saga forward pass + the
 *       rollback compensation pass) opt in.
 *
 * Classification:
 *
 *   TRANSIENT (retryable):
 *     - upstream_timeout     — fetch abort, vendor slow
 *     - upstream_error       — 5xx from the agent
 *     - rate_limited         — 429
 *     - internal_error       — generic transient-ish
 *
 *   PERMANENT (fail fast):
 *     - invalid_input        — request is wrong, retrying won't help
 *     - missing_pii          — identity bag lacks a required field
 *     - unsupported_region   — gate
 *     - confirmation_required / confirmation_mismatch — user hasn't
 *       said yes, or hash drifted; retrying still won't have consent
 *     - not_available        — tool doesn't exist / agent not registered
 *     - price_changed        — price-integrity violation; saga MUST
 *       see this and compensate, not paper over it
 *     - out_of_stock         — inventory gone; compensate
 *     - payment_failed / payment_declined — card issue; compensate
 *     - refund_failed        — rollback compensation itself failed
 *
 * Backoff: 250ms, 500ms, 1000ms (with up to +/-20% jitter so retries
 * from many concurrent sessions don't pile onto the same vendor second).
 * Three attempts total (initial + 2 retries). Idempotency key is the
 * same on every attempt so vendor-side dedupe kicks in if a retry lands
 * after a successful-but-slow first call.
 */

import type { AgentErrorCode } from "@lumo/agent-sdk";
import { dispatchToolCall, type DispatchContext, type DispatchOutcome } from "./router.js";

export interface RetryPolicy {
  /** Total attempts = 1 (initial) + retries. Default 3. */
  max_attempts: number;
  /** Base backoff in ms. Default 250. Doubles each retry. */
  base_ms: number;
  /** Cap on any single backoff. Default 2000. */
  cap_ms: number;
}

const DEFAULT_POLICY: RetryPolicy = { max_attempts: 3, base_ms: 250, cap_ms: 2000 };

const TRANSIENT_CODES: ReadonlySet<AgentErrorCode> = new Set<AgentErrorCode>([
  "upstream_timeout",
  "upstream_error",
  "rate_limited",
  "internal_error",
]);

export function isTransient(code: AgentErrorCode): boolean {
  return TRANSIENT_CODES.has(code);
}

/**
 * Dispatch with retry on transient errors. Returns the *last* outcome —
 * a success short-circuits immediately; a permanent error fails fast;
 * only transient errors drive another attempt.
 *
 * `onRetry` is called before each retry so the caller can audit (we
 * feed it into the SSE event log as `internal` frames so replay sees
 * the retry pattern).
 */
export async function dispatchWithRetry(
  toolName: string,
  args: Record<string, unknown>,
  ctx: DispatchContext,
  policy: Partial<RetryPolicy> = {},
  onRetry?: (info: {
    attempt: number;
    next_delay_ms: number;
    error_code: AgentErrorCode;
    error_message: string;
  }) => void,
): Promise<DispatchOutcome> {
  const p = { ...DEFAULT_POLICY, ...policy };
  let lastOutcome: DispatchOutcome | null = null;

  for (let attempt = 1; attempt <= p.max_attempts; attempt++) {
    const outcome = await dispatchToolCall(toolName, args, ctx);
    lastOutcome = outcome;

    if (outcome.ok) return outcome;
    if (!isTransient(outcome.error.code)) return outcome;
    if (attempt >= p.max_attempts) return outcome;

    const delay = jitter(Math.min(p.base_ms * 2 ** (attempt - 1), p.cap_ms));
    onRetry?.({
      attempt,
      next_delay_ms: delay,
      error_code: outcome.error.code,
      error_message: outcome.error.message,
    });
    await sleep(delay);
  }

  // Unreachable — the loop always returns — but TS needs a terminator.
  return lastOutcome as DispatchOutcome;
}

function jitter(ms: number): number {
  // +/- 20%
  const spread = ms * 0.2;
  return Math.round(ms + (Math.random() * 2 - 1) * spread);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
