export type ArchiveRecallSource = "ml" | "fallback";
export type ArchiveRecallStatus = "ok" | "empty_index" | "partial" | "disabled";

export interface ArchiveRecallDocument {
  id: string;
  text: string;
  source?: string | null;
  metadata: Record<string, unknown>;
}

export interface ArchiveRecallHit {
  id: string;
  score: number;
  snippet: string;
  source?: string | null;
  metadata: Record<string, unknown>;
}

export interface ArchiveRecallResult {
  hits: ArchiveRecallHit[];
  status: ArchiveRecallStatus;
  source: ArchiveRecallSource;
  latency_ms: number;
  summary: string;
  error?: string;
}

interface RecallResponseBody {
  hits?: Array<Partial<ArchiveRecallHit>>;
  status?: unknown;
  _lumo_summary?: unknown;
}

const RECALL_TRIGGERS = [
  "where did",
  "who mentioned",
  "who said",
  "what did",
  "find where",
  "find the",
  "remember when",
  "recall",
  "search my",
  "in my email",
  "in my emails",
  "in my dm",
  "in my dms",
  "in my messages",
  "in my comments",
  "in my transcripts",
];

export async function recallArchiveCore(args: {
  query: string;
  documents: ArchiveRecallDocument[];
  baseUrl: string;
  authorizationHeader: string | null;
  fetchImpl: typeof fetch;
  timeoutMs: number;
  topK: number;
  recordUsage: (
    ok: boolean,
    error_code: string | undefined,
    latency_ms: number,
  ) => Promise<void>;
}): Promise<ArchiveRecallResult> {
  const started = Date.now();
  const fallback = (error?: string): ArchiveRecallResult => ({
    ...recallArchiveFallback(args.query, args.documents, args.topK),
    source: "fallback",
    latency_ms: Date.now() - started,
    error,
  });

  if (args.documents.length === 0) {
    return {
      hits: [],
      status: "empty_index",
      source: "fallback",
      latency_ms: 0,
      summary: "I do not have indexed archive content to search yet.",
    };
  }

  if (!args.baseUrl || !args.authorizationHeader) {
    return fallback("ml_recall_not_configured");
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), args.timeoutMs);
  try {
    const res = await args.fetchImpl(`${args.baseUrl}/api/tools/recall`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: args.authorizationHeader,
      },
      body: JSON.stringify({
        query: args.query,
        documents: args.documents,
        top_k: args.topK,
      }),
      signal: controller.signal,
    });
    clearTimeout(timeout);
    const latency_ms = Date.now() - started;
    if (!res.ok) {
      const error_code = `http_${res.status}`;
      await args.recordUsage(false, error_code, latency_ms);
      return fallback(error_code);
    }
    const body = (await res.json()) as RecallResponseBody;
    const hits = normalizeRecallHits(body.hits, args.documents, args.topK);
    if (!Array.isArray(body.hits)) {
      await args.recordUsage(false, "malformed_response", latency_ms);
      return fallback("malformed_response");
    }
    await args.recordUsage(true, undefined, latency_ms);
    return {
      hits,
      status: normalizeStatus(body.status, hits),
      source: "ml",
      latency_ms,
      summary:
        typeof body._lumo_summary === "string"
          ? body._lumo_summary
          : summaryForHits(hits),
    };
  } catch (err) {
    clearTimeout(timeout);
    const latency_ms = Date.now() - started;
    const error_code =
      err instanceof Error && err.name === "AbortError" ? "timeout" : "upstream_error";
    await args.recordUsage(false, error_code, latency_ms);
    return fallback(error_code);
  }
}

export function recallArchiveFallback(
  query: string,
  documents: ArchiveRecallDocument[],
  topK = 5,
): Omit<ArchiveRecallResult, "source" | "latency_ms" | "error"> {
  if (documents.length === 0) {
    return {
      hits: [],
      status: "empty_index",
      summary: "I do not have indexed archive content to search yet.",
    };
  }
  const queryTerms = terms(query);
  const hits = documents
    .map((doc) => scoreDocument(doc, queryTerms))
    .filter((hit) => hit.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, Math.max(1, topK));
  return {
    hits,
    status: hits.length > 0 ? "partial" : "ok",
    summary: summaryForHits(hits),
  };
}

export function shouldRunArchiveRecall(input: string): boolean {
  const normalized = normalize(input);
  if (!normalized) return false;
  return RECALL_TRIGGERS.some((trigger) => normalized.includes(trigger));
}

export function formatArchiveRecallAnswer(
  query: string,
  result: ArchiveRecallResult,
): string {
  if (result.status === "disabled") {
    return "Archive recall is not available in this environment yet.";
  }
  if (result.hits.length === 0) {
    return `I searched your indexed archive for "${query.trim()}" but did not find a matching memory yet.`;
  }
  const lines = result.hits.slice(0, 5).map((hit, index) => {
    const source = [hit.source, metadataString(hit.metadata, "endpoint")]
      .filter(Boolean)
      .join(" · ");
    const prefix = source ? `${index + 1}. ${source}:` : `${index + 1}.`;
    return `${prefix} ${hit.snippet}`;
  });
  return [
    `I found ${result.hits.length} indexed archive match${result.hits.length === 1 ? "" : "es"} for "${query.trim()}":`,
    ...lines,
  ].join("\n");
}

function normalizeRecallHits(
  hits: Array<Partial<ArchiveRecallHit>> | undefined,
  documents: ArchiveRecallDocument[],
  topK: number,
): ArchiveRecallHit[] {
  if (!Array.isArray(hits)) return [];
  const byId = new Map(documents.map((doc) => [doc.id, doc]));
  const normalized: Array<ArchiveRecallHit | null> = hits.map((hit) => {
      const id = typeof hit.id === "string" ? hit.id : "";
      const doc = byId.get(id);
      if (!id || !doc) return null;
      return {
        id,
        score: clampScore(hit.score),
        snippet:
          typeof hit.snippet === "string" && hit.snippet.trim()
            ? hit.snippet.trim()
            : doc.text.slice(0, 240),
        source: typeof hit.source === "string" ? hit.source : doc.source,
        metadata:
          hit.metadata && typeof hit.metadata === "object" && !Array.isArray(hit.metadata)
            ? hit.metadata
            : doc.metadata,
      };
    });
  return normalized
    .filter((hit): hit is ArchiveRecallHit => hit !== null)
    .sort((a, b) => b.score - a.score)
    .slice(0, Math.max(1, topK));
}

function normalizeStatus(status: unknown, hits: ArchiveRecallHit[]): ArchiveRecallStatus {
  if (status === "empty_index") return "empty_index";
  if (status === "partial") return "partial";
  return hits.length > 0 ? "ok" : "empty_index";
}

function scoreDocument(
  doc: ArchiveRecallDocument,
  queryTerms: Set<string>,
): ArchiveRecallHit {
  const docTerms = terms(doc.text);
  const overlap = [...queryTerms].filter((term) => docTerms.has(term));
  const score = queryTerms.size === 0 ? 0 : overlap.length / queryTerms.size;
  return {
    id: doc.id,
    score: clampScore(score),
    snippet: snippetFor(doc.text, overlap),
    source: doc.source,
    metadata: doc.metadata,
  };
}

function snippetFor(text: string, matchedTerms: string[]): string {
  const trimmed = text.trim();
  if (!trimmed) return "";
  const lower = trimmed.toLowerCase();
  const first = Math.min(
    ...matchedTerms
      .map((term) => lower.indexOf(term.toLowerCase()))
      .filter((index) => index >= 0),
  );
  const anchor = Number.isFinite(first) ? first : 0;
  const start = Math.max(0, anchor - 80);
  const end = Math.min(trimmed.length, anchor + 220);
  return trimmed.slice(start, end).trim();
}

function summaryForHits(hits: ArchiveRecallHit[]): string {
  return hits.length > 0
    ? `Found ${hits.length} relevant archive memory hit${hits.length === 1 ? "" : "s"}.`
    : "No matching archive memories found.";
}

function terms(input: string): Set<string> {
  return new Set(normalize(input).match(/[a-z0-9]+/g) ?? []);
}

function normalize(input: string): string {
  return input.toLowerCase().replace(/\s+/g, " ").trim();
}

function clampScore(value: unknown): number {
  return Math.max(0, Math.min(1, typeof value === "number" && Number.isFinite(value) ? value : 0));
}

function metadataString(metadata: Record<string, unknown>, key: string): string | null {
  const value = metadata[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}
