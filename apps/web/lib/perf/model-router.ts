import type Anthropic from "@anthropic-ai/sdk";
import type { IntentClassification } from "./intent-classifier.ts";
import type { AgentTimingBucket } from "./timing-spans.ts";

export interface ModelRoute {
  bucket: AgentTimingBucket;
  model: string;
  fallbackModel: string | null;
  toolsEnabled: boolean;
  confidence: number;
  classifierProvider: IntentClassification["provider"];
  reason: string;
  /**
   * True when the orchestrator should serve this turn through the
   * Groq/Cerebras fast-turn helper rather than Anthropic. The
   * orchestrator falls through to Anthropic (using `fallbackModel`)
   * if the fast-turn call fails. Always false for `tool_path` and
   * `reasoning_path` — those need Anthropic's tool-call envelope.
   */
  useFastProvider: boolean;
}

export function routeModelForIntent({
  classification,
  defaultModel,
  fastModel = process.env.LUMO_ANTHROPIC_FAST_MODEL ?? "claude-haiku-4-6",
}: {
  classification: IntentClassification;
  defaultModel: string;
  fastModel?: string;
}): ModelRoute {
  const bucket =
    classification.confidence < 0.7 ? "reasoning_path" : classification.bucket;
  if (bucket === "reasoning_path") {
    return {
      bucket,
      model: defaultModel,
      fallbackModel: null,
      toolsEnabled: true,
      confidence: classification.confidence,
      classifierProvider: classification.provider,
      reason: classification.reasoning,
      useFastProvider: false,
    };
  }

  // fast_path: fully Groq-eligible (no tools, just text). The
  // orchestrator picks the actual fast-provider model from
  // LUMO_GROQ_FAST_TURN_MODEL via fast-turn.ts.
  // tool_path: stays on Anthropic Haiku — Groq's tool-call envelope
  // is OpenAI-shaped and the orchestrator's tool loop expects
  // Anthropic's tool_use blocks; bridging is its own lane.
  const fastEligible =
    bucket === "fast_path" &&
    Boolean(process.env.LUMO_GROQ_API_KEY ?? process.env.LUMO_CEREBRAS_API_KEY);

  return {
    bucket,
    model: fastModel,
    fallbackModel: defaultModel,
    toolsEnabled: bucket !== "fast_path",
    confidence: classification.confidence,
    classifierProvider: classification.provider,
    reason: classification.reasoning,
    useFastProvider: fastEligible,
  };
}

export function toolsForModelRoute<T extends Anthropic.Tool>(
  route: Pick<ModelRoute, "toolsEnabled">,
  tools: T[],
): T[] {
  return route.toolsEnabled ? tools : [];
}
