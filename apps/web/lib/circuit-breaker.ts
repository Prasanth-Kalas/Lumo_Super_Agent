/**
 * Circuit breaker.
 *
 * The breaker wraps every outbound call from the shell to an agent. It trips
 * after a burst of failures, stays open for a cool-down, then half-opens to
 * probe. While open, the corresponding agent's tools are filtered out of the
 * LLM's tool list (see agent-registry.ts → healthyBridge).
 */

export type BreakerState = "closed" | "open" | "half-open";

interface Stats {
  rolling_errors: number;
  rolling_total: number;
  opened_at: number;
  last_probe_at: number;
  state: BreakerState;
}

const breakers = new Map<string, Stats>();

const ERROR_THRESHOLD = 0.5; // 50% error rate over the window
const MIN_SAMPLE = 5;
const COOL_DOWN_MS = 30_000;
const WINDOW_MS = 60_000;

function fresh(): Stats {
  return {
    rolling_errors: 0,
    rolling_total: 0,
    opened_at: 0,
    last_probe_at: 0,
    state: "closed",
  };
}

function get(agentId: string): Stats {
  let s = breakers.get(agentId);
  if (!s) {
    s = fresh();
    breakers.set(agentId, s);
  }
  return s;
}

export function canCall(agentId: string): boolean {
  const s = get(agentId);
  if (s.state === "closed") return true;
  if (s.state === "open") {
    if (Date.now() - s.opened_at >= COOL_DOWN_MS) {
      s.state = "half-open";
      return true;
    }
    return false;
  }
  // half-open: allow one probe at a time
  if (Date.now() - s.last_probe_at < 2_000) return false;
  s.last_probe_at = Date.now();
  return true;
}

export function recordSuccess(agentId: string): void {
  const s = get(agentId);
  s.rolling_total++;
  // Drift the error count down
  s.rolling_errors = Math.max(0, s.rolling_errors - 1);
  if (s.state === "half-open") s.state = "closed";
}

export function recordFailure(agentId: string): void {
  const s = get(agentId);
  s.rolling_total++;
  s.rolling_errors++;
  if (s.state === "half-open") {
    s.state = "open";
    s.opened_at = Date.now();
    return;
  }
  if (
    s.rolling_total >= MIN_SAMPLE &&
    s.rolling_errors / s.rolling_total >= ERROR_THRESHOLD
  ) {
    s.state = "open";
    s.opened_at = Date.now();
  }
}

export function snapshot(): Record<string, Stats> {
  // Decay counts older than the window. Good enough; precision is not critical
  // because the registry's health probe is the other signal.
  const now = Date.now();
  for (const [k, s] of breakers) {
    if (s.state === "closed" && now - (s.opened_at || now) > WINDOW_MS) {
      s.rolling_errors = Math.max(0, s.rolling_errors - 1);
    }
  }
  return Object.fromEntries(breakers.entries());
}

export function reset(agentId: string): void {
  breakers.set(agentId, fresh());
}
