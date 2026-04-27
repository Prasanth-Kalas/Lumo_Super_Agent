import { createHash, randomBytes, randomUUID } from "node:crypto";
import { getSupabase } from "../db.ts";

export type BrainSdkOutcome =
  | "ok"
  | "fallback"
  | "timeout"
  | "malformed"
  | "circuit_open"
  | "error";

export type BrainCircuitState = "closed" | "open" | "half_open";

export type BrainEndpointName =
  | "lumo_health"
  | "lumo_classify"
  | "lumo_embed"
  | "lumo_recall"
  | "lumo_rank_agents"
  | "lumo_evaluate_agent_risk"
  | "lumo_optimize_trip"
  | "lumo_transcribe"
  | "lumo_extract_pdf"
  | "lumo_embed_image"
  | "lumo_detect_anomaly"
  | "lumo_forecast_metric"
  | "lumo_unknown";

export interface BrainCallTelemetry {
  user_id?: string | null;
  user_hash?: string | null;
  request_id: string;
  endpoint: BrainEndpointName;
  outcome: BrainSdkOutcome;
  attempt: number;
  max_attempts: number;
  retry_reason?: string | null;
  fallback_reason?: string | null;
  circuit_state: BrainCircuitState;
  latency_ms: number;
  budget_ms: number;
  http_status?: number | null;
  error_class?: string | null;
  error_text?: string | null;
  caller_agent_id?: string | null;
  caller_surface?: string | null;
  payload_redacted?: Record<string, unknown>;
  response_redacted?: Record<string, unknown>;
}

export interface BrainSdkFetchOptions {
  user_id?: string | null;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  maxAttempts?: number;
  baseBackoffMs?: number;
  callerSurface?: string;
  callerAgentId?: string;
  failureThreshold?: number;
  halfOpenAfterMs?: number;
  telemetrySink?: (row: BrainCallTelemetry) => Promise<void> | void;
}

interface CircuitState {
  state: BrainCircuitState;
  failures: number;
  openedAt: number;
  lastProbeAt: number;
}

interface BrainJsonCallOptions extends BrainSdkFetchOptions {
  endpoint: BrainEndpointName;
  path: string;
  authorizationHeader?: string | null;
  headers?: HeadersInit;
}

const SDK_VERSION = "sdk-1";
const DEFAULT_TIMEOUT_MS = 8_000;
const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_BACKOFF_MS = 200;
const DEFAULT_FAILURE_THRESHOLD = 5;
const DEFAULT_HALF_OPEN_AFTER_MS = 30_000;
const LUMO_ML_AGENT_ID = "lumo-ml";
const breakerByEndpoint = new Map<string, CircuitState>();
let telemetryWarned = false;

const ENDPOINT_BY_PATH: Record<string, BrainEndpointName> = {
  "/api/health": "lumo_health",
  "/api/tools/classify": "lumo_classify",
  "/api/tools/embed": "lumo_embed",
  "/api/tools/recall": "lumo_recall",
  "/api/tools/rank_agents": "lumo_rank_agents",
  "/api/tools/evaluate_agent_risk": "lumo_evaluate_agent_risk",
  "/api/tools/optimize_trip": "lumo_optimize_trip",
  "/api/tools/transcribe": "lumo_transcribe",
  "/api/tools/extract_pdf": "lumo_extract_pdf",
  "/api/tools/embed_image": "lumo_embed_image",
  "/api/tools/detect_anomaly": "lumo_detect_anomaly",
  "/api/tools/forecast_metric": "lumo_forecast_metric",
};

export function isBrainSdkEnabled(): boolean {
  return process.env.LUMO_BRAIN_SDK_ENABLED !== "false";
}

export function resolveBrainBaseUrl(override?: string): string {
  return (
    override ??
    process.env.LUMO_ML_AGENT_URL ??
    (process.env.NODE_ENV === "development" ? "http://localhost:3010" : "")
  ).replace(/\/+$/, "");
}

export function createBrainSdkFetch(options: BrainSdkFetchOptions = {}): typeof fetch {
  if (!isBrainSdkEnabled()) return options.fetchImpl ?? fetch;
  const fetchImpl = options.fetchImpl ?? fetch;
  return async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const endpoint = endpointFromInput(input);
    return callWithResilience(input, init, endpoint, fetchImpl, options);
  };
}

export class BrainSdk {
  private options: BrainSdkFetchOptions;

  constructor(options: BrainSdkFetchOptions = {}) {
    this.options = options;
  }

  classify(payload: unknown, options: Partial<BrainJsonCallOptions> = {}) {
    return this.callJson({ ...options, endpoint: "lumo_classify", path: "/api/tools/classify" }, payload);
  }

  embed(payload: unknown, options: Partial<BrainJsonCallOptions> = {}) {
    return this.callJson({ ...options, endpoint: "lumo_embed", path: "/api/tools/embed" }, payload);
  }

  recall(payload: unknown, options: Partial<BrainJsonCallOptions> = {}) {
    return this.callJson({ ...options, endpoint: "lumo_recall", path: "/api/tools/recall" }, payload);
  }

  rankAgents(payload: unknown, options: Partial<BrainJsonCallOptions> = {}) {
    return this.callJson({ ...options, endpoint: "lumo_rank_agents", path: "/api/tools/rank_agents" }, payload);
  }

  evaluateAgentRisk(payload: unknown, options: Partial<BrainJsonCallOptions> = {}) {
    return this.callJson({
      ...options,
      endpoint: "lumo_evaluate_agent_risk",
      path: "/api/tools/evaluate_agent_risk",
    }, payload);
  }

  optimizeTrip(payload: unknown, options: Partial<BrainJsonCallOptions> = {}) {
    return this.callJson({ ...options, endpoint: "lumo_optimize_trip", path: "/api/tools/optimize_trip" }, payload);
  }

  transcribe(payload: unknown, options: Partial<BrainJsonCallOptions> = {}) {
    return this.callJson({ ...options, endpoint: "lumo_transcribe", path: "/api/tools/transcribe" }, payload);
  }

  extractPdf(payload: unknown, options: Partial<BrainJsonCallOptions> = {}) {
    return this.callJson({ ...options, endpoint: "lumo_extract_pdf", path: "/api/tools/extract_pdf" }, payload);
  }

  embedImage(payload: unknown, options: Partial<BrainJsonCallOptions> = {}) {
    return this.callJson({ ...options, endpoint: "lumo_embed_image", path: "/api/tools/embed_image" }, payload);
  }

  detectAnomaly(payload: unknown, options: Partial<BrainJsonCallOptions> = {}) {
    return this.callJson({
      ...options,
      endpoint: "lumo_detect_anomaly",
      path: "/api/tools/detect_anomaly",
    }, payload);
  }

  forecastMetric(payload: unknown, options: Partial<BrainJsonCallOptions> = {}) {
    return this.callJson({
      ...options,
      endpoint: "lumo_forecast_metric",
      path: "/api/tools/forecast_metric",
    }, payload);
  }

  health(options: Partial<BrainJsonCallOptions> = {}) {
    return this.callJson({ ...options, endpoint: "lumo_health", path: "/api/health" }, undefined, "GET");
  }

  async callJson(
    options: Partial<BrainJsonCallOptions> & { endpoint: BrainEndpointName; path: string },
    payload?: unknown,
    method = "POST",
  ): Promise<unknown> {
    const baseUrl = resolveBrainBaseUrl(options.baseUrl ?? this.options.baseUrl);
    if (!baseUrl) throw new Error("brain_not_configured");
    const headers = new Headers(options.headers);
    if (payload !== undefined) headers.set("content-type", "application/json");
    if (options.authorizationHeader) headers.set("authorization", options.authorizationHeader);
    const sdkFetch = createBrainSdkFetch({ ...this.options, ...options, baseUrl });
    const res = await sdkFetch(`${baseUrl}${options.path}`, {
      method,
      headers,
      body: payload === undefined ? undefined : JSON.stringify(payload),
    });
    if (!res.ok) throw new Error(`brain_http_${res.status}`);
    return res.json();
  }
}

export function createBrainSdk(options: BrainSdkFetchOptions = {}): BrainSdk {
  return new BrainSdk(options);
}

export function __resetBrainSdkForTesting(): void {
  breakerByEndpoint.clear();
  telemetryWarned = false;
}

async function callWithResilience(
  input: RequestInfo | URL,
  init: RequestInit,
  endpoint: BrainEndpointName,
  fetchImpl: typeof fetch,
  options: BrainSdkFetchOptions,
): Promise<Response> {
  const started = Date.now();
  const maxAttempts = clampInt(options.maxAttempts, 1, 5, DEFAULT_MAX_ATTEMPTS);
  const timeoutMs = clampInt(options.timeoutMs, 50, 300_000, DEFAULT_TIMEOUT_MS);
  const requestId = requestIdFrom(init.headers) ?? randomUUID();
  const circuit = getCircuit(endpoint);
  const circuitState = beforeCircuitCall(circuit, options);
  if (circuitState === "open") {
    const latency_ms = Date.now() - started;
    await recordBrainCall({
      user_id: safeUserId(options.user_id),
      user_hash: userHash(options.user_id),
      request_id: requestId,
      endpoint,
      outcome: "circuit_open",
      attempt: 0,
      max_attempts: maxAttempts,
      fallback_reason: "circuit_open",
      circuit_state: "open",
      latency_ms,
      budget_ms: timeoutMs,
      http_status: 503,
      caller_agent_id: options.callerAgentId ?? LUMO_ML_AGENT_ID,
      caller_surface: options.callerSurface ?? null,
      response_redacted: { status: 503 },
    }, options.telemetrySink);
    return jsonResponse({ error: "brain_sdk_circuit_open", endpoint }, 503);
  }

  let lastError: unknown;
  let lastResponse: Response | null = null;
  let retryReason: string | null = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const headers = prepareHeaders(init.headers, endpoint, requestId);
    const { signal, cleanup, timedOut } = mergedSignal(init.signal, timeoutMs);
    try {
      const res = await fetchImpl(input, { ...init, headers, signal });
      cleanup();
      lastResponse = res;
      if (res.ok || !isRetryableStatus(res.status) || attempt >= maxAttempts) {
        const latency_ms = Date.now() - started;
        const outcome: BrainSdkOutcome = res.ok ? "ok" : "error";
        if (res.ok) recordCircuitSuccess(circuit);
        else recordCircuitFailure(circuit, options);
        await recordBrainCall({
          user_id: safeUserId(options.user_id),
          user_hash: userHash(options.user_id),
          request_id: requestId,
          endpoint,
          outcome,
          attempt,
          max_attempts: maxAttempts,
          retry_reason: retryReason,
          circuit_state: circuit.state,
          latency_ms,
          budget_ms: timeoutMs,
          http_status: res.status,
          error_class: res.ok ? null : `http_${res.status}`,
          caller_agent_id: options.callerAgentId ?? LUMO_ML_AGENT_ID,
          caller_surface: options.callerSurface ?? null,
          payload_redacted: payloadMeta(input, init),
          response_redacted: { status: res.status },
        }, options.telemetrySink);
        return res;
      }
      retryReason = `http_${res.status}`;
    } catch (err) {
      cleanup();
      lastError = err;
      const externalAbort = init.signal?.aborted === true;
      const errorClass = normalizeErrorClass(err, timedOut(), externalAbort);
      retryReason = errorClass;
      if (externalAbort || attempt >= maxAttempts) {
        recordCircuitFailure(circuit, options);
        const latency_ms = Date.now() - started;
        await recordBrainCall({
          user_id: safeUserId(options.user_id),
          user_hash: userHash(options.user_id),
          request_id: requestId,
          endpoint,
          outcome: errorClass === "timeout" ? "timeout" : "error",
          attempt,
          max_attempts: maxAttempts,
          retry_reason: attempt > 1 ? retryReason : null,
          circuit_state: circuit.state,
          latency_ms,
          budget_ms: timeoutMs,
          error_class: errorClass,
          error_text: err instanceof Error ? err.message : String(err),
          caller_agent_id: options.callerAgentId ?? LUMO_ML_AGENT_ID,
          caller_surface: options.callerSurface ?? null,
          payload_redacted: payloadMeta(input, init),
        }, options.telemetrySink);
        throw err;
      }
    }
    await sleep(jitter((options.baseBackoffMs ?? DEFAULT_BACKOFF_MS) * 2 ** (attempt - 1)));
  }

  if (lastResponse) return lastResponse;
  throw lastError instanceof Error ? lastError : new Error("brain_sdk_call_failed");
}

async function recordBrainCall(
  row: BrainCallTelemetry,
  telemetrySink?: (row: BrainCallTelemetry) => Promise<void> | void,
): Promise<void> {
  if (telemetrySink) {
    await telemetrySink(row);
    return;
  }
  const db = getSupabase();
  if (!db) return;
  const { error } = await db.from("brain_call_log").insert({
    user_id: row.user_id ?? null,
    user_hash: row.user_hash ?? null,
    request_id: row.request_id,
    endpoint: row.endpoint,
    sdk_version: SDK_VERSION,
    outcome: row.outcome,
    attempt: row.attempt,
    max_attempts: row.max_attempts,
    retry_reason: row.retry_reason ?? null,
    fallback_reason: row.fallback_reason ?? null,
    circuit_state: row.circuit_state,
    latency_ms: Math.max(0, Math.round(row.latency_ms)),
    budget_ms: Math.max(0, Math.round(row.budget_ms)),
    http_status: row.http_status ?? null,
    error_class: row.error_class ?? null,
    error_text: row.error_text?.slice(0, 500) ?? null,
    caller_agent_id: row.caller_agent_id ?? LUMO_ML_AGENT_ID,
    caller_surface: row.caller_surface ?? null,
    payload_redacted: row.payload_redacted ?? {},
    response_redacted: row.response_redacted ?? {},
  });
  if (error && !telemetryWarned) {
    telemetryWarned = true;
    console.warn("[brain-sdk] brain_call_log insert failed:", error.message);
  }
}

function prepareHeaders(
  headersInit: HeadersInit | undefined,
  endpoint: BrainEndpointName,
  requestId: string,
): Headers {
  const headers = new Headers(headersInit);
  if (!headers.has("traceparent")) headers.set("traceparent", traceparent());
  headers.set("x-lumo-brain-endpoint", endpoint);
  headers.set("x-lumo-brain-sdk-version", SDK_VERSION);
  if (!headers.has("x-idempotency-key")) headers.set("x-idempotency-key", requestId);
  return headers;
}

function mergedSignal(
  external: AbortSignal | null | undefined,
  timeoutMs: number,
): { signal: AbortSignal; cleanup: () => void; timedOut: () => boolean } {
  const controller = new AbortController();
  let didTimeout = false;
  const onAbort = () => controller.abort(external?.reason);
  if (external?.aborted) controller.abort(external.reason);
  else external?.addEventListener("abort", onAbort, { once: true });
  const timer = setTimeout(() => {
    didTimeout = true;
    controller.abort(new DOMException("Brain SDK timeout", "AbortError"));
  }, timeoutMs);
  return {
    signal: controller.signal,
    cleanup: () => {
      clearTimeout(timer);
      external?.removeEventListener("abort", onAbort);
    },
    timedOut: () => didTimeout,
  };
}

function getCircuit(endpoint: BrainEndpointName): CircuitState {
  const existing = breakerByEndpoint.get(endpoint);
  if (existing) return existing;
  const state: CircuitState = { state: "closed", failures: 0, openedAt: 0, lastProbeAt: 0 };
  breakerByEndpoint.set(endpoint, state);
  return state;
}

function beforeCircuitCall(
  circuit: CircuitState,
  options: BrainSdkFetchOptions,
): BrainCircuitState {
  if (circuit.state !== "open") return circuit.state;
  const cooldown = options.halfOpenAfterMs ?? DEFAULT_HALF_OPEN_AFTER_MS;
  if (Date.now() - circuit.openedAt < cooldown) return "open";
  circuit.state = "half_open";
  circuit.lastProbeAt = Date.now();
  return "half_open";
}

function recordCircuitSuccess(circuit: CircuitState): void {
  circuit.failures = 0;
  circuit.state = "closed";
}

function recordCircuitFailure(circuit: CircuitState, options: BrainSdkFetchOptions): void {
  circuit.failures += 1;
  if (circuit.state === "half_open" || circuit.failures >= (options.failureThreshold ?? DEFAULT_FAILURE_THRESHOLD)) {
    circuit.state = "open";
    circuit.openedAt = Date.now();
  }
}

function endpointFromInput(input: RequestInfo | URL): BrainEndpointName {
  try {
    const raw = typeof input === "string" || input instanceof URL ? String(input) : input.url;
    const path = new URL(raw).pathname;
    return ENDPOINT_BY_PATH[path] ?? "lumo_unknown";
  } catch {
    return "lumo_unknown";
  }
}

function requestIdFrom(headersInit: HeadersInit | undefined): string | null {
  const headers = new Headers(headersInit);
  return headers.get("x-idempotency-key") ?? headers.get("x-request-id");
}

function payloadMeta(input: RequestInfo | URL, init: RequestInit): Record<string, unknown> {
  const method = init.method ?? "GET";
  let path = "unknown";
  try {
    const raw = typeof input === "string" || input instanceof URL ? String(input) : input.url;
    path = new URL(raw).pathname;
  } catch {
    path = "unknown";
  }
  const bodyBytes =
    typeof init.body === "string" ? init.body.length : init.body ? String(init.body).length : 0;
  return { method, path, body_bytes: bodyBytes };
}

function safeUserId(user_id: string | null | undefined): string | null {
  if (!user_id || user_id === "anon") return null;
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(user_id)
    ? user_id
    : null;
}

function userHash(user_id: string | null | undefined): string | null {
  if (!user_id || user_id === "anon") return null;
  return createHash("sha256").update(user_id).digest("hex").slice(0, 12);
}

function normalizeErrorClass(err: unknown, timedOut: boolean, externalAbort: boolean): string {
  if (timedOut || (err instanceof Error && err.name === "AbortError" && !externalAbort)) return "timeout";
  if (externalAbort) return "aborted";
  return err instanceof Error && err.name ? err.name : "error";
}

function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 409 || status === 425 || status === 429 || status >= 500;
}

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "x-lumo-brain-sdk": "true" },
  });
}

function traceparent(): string {
  return `00-${randomBytes(16).toString("hex")}-${randomBytes(8).toString("hex")}-01`;
}

function jitter(ms: number): number {
  const spread = ms * 0.2;
  return Math.max(0, Math.round(ms + (Math.random() * 2 - 1) * spread));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function clampInt(
  value: number | undefined,
  min: number,
  max: number,
  fallback: number,
): number {
  if (!Number.isFinite(value)) return fallback;
  const n = Math.trunc(Number(value));
  return Math.min(max, Math.max(min, n));
}
