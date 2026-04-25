export interface CoreLeadScore {
  score: number;
  reasons: string[];
  source: "heuristic" | "ml";
}

export interface CoreClassifiedItem {
  label?: string;
  score?: number;
  reasons?: string[];
  above_threshold?: boolean;
}

export interface CoreLeadClassificationResult {
  scores: CoreLeadScore[];
  source: "ml" | "heuristic";
  latency_ms: number;
  error?: string;
}

interface CoreClassifyResponse {
  classifier?: string;
  items?: CoreClassifiedItem[];
}

export async function classifyLeadItemsCore(args: {
  user_id: string;
  redactedTexts: string[];
  fallbackScores: CoreLeadScore[];
  baseUrl: string;
  authorizationHeader: string | null;
  fetchImpl: typeof fetch;
  timeoutMs: number;
  threshold: number;
  itemCap: number;
  recordUsage: (
    ok: boolean,
    error_code: string | undefined,
    latency_ms: number,
  ) => Promise<void>;
  warn?: (message: string) => void;
}): Promise<CoreLeadClassificationResult> {
  const started = Date.now();
  if (args.fallbackScores.length === 0) {
    return { scores: args.fallbackScores, source: "heuristic", latency_ms: 0 };
  }
  if (!args.baseUrl || !args.authorizationHeader) {
    return {
      scores: args.fallbackScores,
      source: "heuristic",
      latency_ms: Date.now() - started,
      error: "ml_classifier_not_configured",
    };
  }

  const texts = args.redactedTexts.slice(0, args.itemCap);
  if (args.redactedTexts.length > args.itemCap) {
    args.warn?.(
      `[workspace/inbox] lead classifier capped at ${args.itemCap}/${args.redactedTexts.length} items; tail uses heuristic fallback.`,
    );
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), args.timeoutMs);
  try {
    const res = await args.fetchImpl(`${args.baseUrl}/api/tools/classify`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: args.authorizationHeader,
        "x-lumo-user-id": args.user_id,
      },
      body: JSON.stringify({
        classifier: "lead",
        threshold: args.threshold,
        items: texts,
      }),
      signal: controller.signal,
    });
    clearTimeout(timeout);
    const latency_ms = Date.now() - started;
    if (!res.ok) {
      const error_code = `http_${res.status}`;
      await args.recordUsage(false, error_code, latency_ms);
      return {
        scores: args.fallbackScores,
        source: "heuristic",
        latency_ms,
        error: error_code,
      };
    }
    const body = (await res.json()) as CoreClassifyResponse;
    const mlItems = Array.isArray(body.items) ? body.items : [];
    const scores = args.fallbackScores.map((score, index) => {
      if (index >= texts.length) return score;
      return mergeCoreLeadScore(score, mlItems[index]);
    });
    await args.recordUsage(true, undefined, latency_ms);
    return { scores, source: "ml", latency_ms };
  } catch (err) {
    clearTimeout(timeout);
    const latency_ms = Date.now() - started;
    const error_code = err instanceof Error && err.name === "AbortError" ? "timeout" : "upstream_error";
    await args.recordUsage(false, error_code, latency_ms);
    return {
      scores: args.fallbackScores,
      source: "heuristic",
      latency_ms,
      error: error_code,
    };
  }
}

function mergeCoreLeadScore(
  fallback: CoreLeadScore,
  item: CoreClassifiedItem | undefined,
): CoreLeadScore {
  if (!item || typeof item.score !== "number" || !Number.isFinite(item.score)) {
    return fallback;
  }
  const reasons = Array.isArray(item.reasons)
    ? item.reasons.filter((reason): reason is string => typeof reason === "string" && reason.length > 0)
    : [];
  return {
    score: clampScore(item.score),
    reasons: reasons.length > 0 ? reasons : fallback.reasons,
    source: "ml",
  };
}

function clampScore(score: number): number {
  return Math.max(0, Math.min(1, Number(score.toFixed(3))));
}
