import type { AgentTimingBucket } from "./timing-spans.ts";
import type { SubagentDispatchPlan } from "../mesh/types.ts";

export interface IntentClassifierMessage {
  role: "user" | "assistant";
  content: string;
}

export interface ClassifyIntentInput {
  messages: IntentClassifierMessage[];
  toolCount: number;
  installedAgentCount: number;
  connectedAgentCount: number;
  hasPriorSummary: boolean;
  mode: "text" | "voice";
}

export interface IntentClassification {
  bucket: AgentTimingBucket;
  isCompoundTrip: boolean;
  confidence: number;
  reasoning: string;
  provider: "groq" | "cerebras" | "fallback";
  model: string | null;
  latencyMs: number;
  source: "provider" | "provider_unavailable" | "parse_error";
  errorCode?: string;
  subagentDispatchPlan?: SubagentDispatchPlan;
}

interface ProviderConfig {
  provider: "groq" | "cerebras";
  baseUrl: string;
  apiKey?: string;
  model?: string;
}

interface ClassifierOptions {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  providers?: ProviderConfig[];
}

const DEFAULT_TIMEOUT_MS = 1_200;
const MIN_CONFIDENCE = 0.7;
const FALLBACK_CLASSIFICATION: IntentClassification = {
  bucket: "reasoning_path",
  isCompoundTrip: false,
  confidence: 1,
  reasoning: "Fast-path classifier unavailable; defaulted to safest reasoning route.",
  provider: "fallback",
  model: null,
  latencyMs: 0,
  source: "provider_unavailable",
};

export async function classifyIntent(
  input: ClassifyIntentInput,
  options: ClassifierOptions = {},
): Promise<IntentClassification> {
  const providers = options.providers ?? defaultProviders();
  const fetchImpl = options.fetchImpl ?? fetch;
  const started = Date.now();

  for (const provider of providers) {
    if (!provider.apiKey || !provider.model) continue;
    try {
      const raw = await callClassifierProvider({
        provider,
        input,
        fetchImpl,
        timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      });
      const parsed = normalizeClassifierPayload(raw, {
        provider: provider.provider,
        model: provider.model,
        latencyMs: Date.now() - started,
      });
      const withCompoundHint = applyCompoundTripHeuristic(parsed, input);
      return withCompoundHint.confidence < MIN_CONFIDENCE
        ? {
            ...withCompoundHint,
            bucket: "reasoning_path",
            reasoning: `${withCompoundHint.reasoning} Low confidence defaulted to reasoning path.`,
          }
        : withCompoundHint;
    } catch (error) {
      const isLast = provider === providers[providers.length - 1];
      if (isLast) {
        return applyCompoundTripHeuristic({
          ...FALLBACK_CLASSIFICATION,
          latencyMs: Date.now() - started,
          errorCode: error instanceof Error ? error.name : "classifier_error",
        }, input);
      }
    }
  }

  return applyCompoundTripHeuristic(
    { ...FALLBACK_CLASSIFICATION, latencyMs: Date.now() - started },
    input,
  );
}

export function normalizeClassifierPayload(
  raw: unknown,
  context: {
    provider: "groq" | "cerebras";
    model: string;
    latencyMs: number;
  },
): IntentClassification {
  const payload = typeof raw === "string" ? parseJsonObject(raw) : raw;
  if (!payload || typeof payload !== "object") {
    return parseError(context, "Classifier returned non-object JSON.");
  }
  const record = payload as Record<string, unknown>;
  const bucket = normalizeBucket(record.bucket);
  const isCompoundTrip =
    normalizeCompoundFlag(record.is_compound_trip) ||
    normalizeCompoundFlag(record.compound_trip) ||
    record.bucket === "compound_trip";
  const confidence = clampConfidence(record.confidence);
  const reasoning =
    typeof record.reasoning === "string"
      ? record.reasoning.slice(0, 240)
      : "Classifier did not provide reasoning.";
  return {
    bucket: isCompoundTrip ? "reasoning_path" : bucket,
    isCompoundTrip,
    confidence,
    reasoning,
    provider: context.provider,
    model: context.model,
    latencyMs: context.latencyMs,
    source: "provider",
  };
}

function defaultProviders(): ProviderConfig[] {
  return [
    {
      provider: "groq",
      baseUrl: "https://api.groq.com/openai/v1/chat/completions",
      apiKey: process.env.LUMO_GROQ_API_KEY,
      model: process.env.LUMO_GROQ_REFLEX_MODEL ?? "llama-3.1-8b-instant",
    },
    {
      provider: "cerebras",
      baseUrl: "https://api.cerebras.ai/v1/chat/completions",
      apiKey: process.env.LUMO_CEREBRAS_API_KEY,
      model: process.env.LUMO_CEREBRAS_REFLEX_MODEL ?? "llama-3.1-8b",
    },
  ];
}

async function callClassifierProvider({
  provider,
  input,
  fetchImpl,
  timeoutMs,
}: {
  provider: ProviderConfig;
  input: ClassifyIntentInput;
  fetchImpl: typeof fetch;
  timeoutMs: number;
}): Promise<string> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(provider.baseUrl, {
      method: "POST",
      headers: {
        authorization: `Bearer ${provider.apiKey}`,
        "content-type": "application/json",
      },
      signal: controller.signal,
      body: JSON.stringify({
        model: provider.model,
        temperature: 0,
        max_tokens: 120,
        messages: [
          {
            role: "system",
            content: classifierSystemPrompt(),
          },
          {
            role: "user",
            content: JSON.stringify(buildClassifierFeatures(input)),
          },
        ],
      }),
    });
    if (!response.ok) {
      throw new Error(`classifier_${provider.provider}_${response.status}`);
    }
    const data = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const content = data.choices?.[0]?.message?.content;
    if (!content) throw new Error(`classifier_${provider.provider}_empty`);
    return content;
  } finally {
    clearTimeout(timeout);
  }
}

function classifierSystemPrompt(): string {
  return [
    "Classify a single Lumo assistant turn into one route bucket.",
    "Return JSON only: {\"bucket\":\"fast_path|tool_path|reasoning_path|compound_trip\",\"is_compound_trip\":true|false,\"confidence\":0-1,\"reasoning\":\"short\"}.",
    "fast_path: simple Q&A, status, rewrite, greeting, no private data, no purchases, no multi-step planning.",
    "tool_path: likely needs 1-3 tools or installed agent calls but light reasoning.",
    "compound_trip: the user wants a coordinated travel plan with 2+ legs such as flight + hotel, hotel + dinner, full weekend itinerary, or travel plus ground transport.",
    "reasoning_path: money movement, single-agent travel booking, ambiguous or high-stakes requests, permission/card confirmations, or low confidence.",
  ].join(" ");
}

function buildClassifierFeatures(input: ClassifyIntentInput): Record<string, unknown> {
  const lastUser =
    input.messages
      .slice()
      .reverse()
      .find((message) => message.role === "user")?.content ?? "";
  return {
    last_user_message: lastUser.slice(0, 800),
    turn_count: input.messages.length,
    tool_count: input.toolCount,
    installed_agent_count: input.installedAgentCount,
    connected_agent_count: input.connectedAgentCount,
    has_prior_summary: input.hasPriorSummary,
    mode: input.mode,
  };
}

function parseJsonObject(raw: string): unknown {
  const trimmed = raw.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    const match = trimmed.match(/\{[\s\S]*\}/);
    if (!match) return null;
    try {
      return JSON.parse(match[0]);
    } catch {
      return null;
    }
  }
}

function normalizeBucket(value: unknown): AgentTimingBucket {
  if (value === "fast_path" || value === "tool_path" || value === "reasoning_path") {
    return value;
  }
  if (value === "simple") return "fast_path";
  if (value === "tool_call") return "tool_path";
  if (value === "reasoning" || value === "compound_trip") return "reasoning_path";
  return "reasoning_path";
}

function normalizeCompoundFlag(value: unknown): boolean {
  if (value === true) return true;
  if (typeof value === "string") return /^(true|yes|compound_trip)$/i.test(value.trim());
  return false;
}

function applyCompoundTripHeuristic(
  classification: IntentClassification,
  input: ClassifyIntentInput,
): IntentClassification {
  const lastUser =
    input.messages
      .slice()
      .reverse()
      .find((message) => message.role === "user")?.content ?? "";
  if (!detectCompoundTripIntent(lastUser)) return classification;
  return {
    ...classification,
    bucket: "reasoning_path",
    isCompoundTrip: true,
    reasoning: classification.reasoning.includes("compound")
      ? classification.reasoning
      : `${classification.reasoning} Compound trip intent detected from travel-leg context.`,
  };
}

export function detectCompoundTripIntent(message: string): boolean {
  const text = message.toLowerCase();
  if (!text.trim()) return false;
  const hasTravelAnchor =
    /\b(trip|travel|itinerary|weekend|vacation|vegas|las vegas|hotel|flight|fly|airport|dinner|restaurant|ride|transport|ground)\b/.test(text);
  if (!hasTravelAnchor) return false;

  const categories = new Set<string>();
  if (/\b(flight|flights|fly|airport|airline|ord|las|lax|jfk|sfo|nyc)\b/.test(text)) {
    categories.add("flight");
  }
  if (/\b(hotel|hotels|stay|lodging|room|resort)\b/.test(text)) {
    categories.add("hotel");
  }
  if (/\b(dinner|restaurant|restaurants|reservation|table|food|meal)\b/.test(text)) {
    categories.add("restaurant");
  }
  if (/\b(ride|rideshare|uber|cab|taxi|transport|ground|car)\b/.test(text)) {
    categories.add("ground");
  }
  if (categories.size >= 2) return true;

  const broadPlanner =
    /\b(plan|organize|handle|book|arrange|put together)\b/.test(text) &&
    /\b(trip|weekend|itinerary|vacation)\b/.test(text);
  const hasDestination =
    /\b(vegas|las vegas|chicago|new york|nyc|miami|la|los angeles|san francisco|sfo)\b/.test(text);
  return broadPlanner && hasDestination;
}

function clampConfidence(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

function parseError(
  context: {
    provider: "groq" | "cerebras";
    model: string;
    latencyMs: number;
  },
  reasoning: string,
): IntentClassification {
  return {
    bucket: "reasoning_path",
    isCompoundTrip: false,
    confidence: 1,
    reasoning,
    provider: context.provider,
    model: context.model,
    latencyMs: context.latencyMs,
    source: "parse_error",
  };
}
