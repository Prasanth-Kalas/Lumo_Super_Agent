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
    };
  }

  return {
    bucket,
    model: fastModel,
    fallbackModel: defaultModel,
    toolsEnabled: bucket !== "fast_path",
    confidence: classification.confidence,
    classifierProvider: classification.provider,
    reason: classification.reasoning,
  };
}

export function toolsForModelRoute<T extends Anthropic.Tool>(
  route: Pick<ModelRoute, "toolsEnabled">,
  tools: T[],
): T[] {
  return route.toolsEnabled ? tools : [];
}
