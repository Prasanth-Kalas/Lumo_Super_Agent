export interface ExtractPdfInput {
  pdf_url: string;
  source_metadata?: Record<string, unknown>;
}

export type PdfBlockType = "heading" | "paragraph" | "table" | "list";

export interface PdfBlock {
  type: PdfBlockType;
  text: string;
  bbox?: [number, number, number, number];
}

export interface PdfPage {
  page_number: number;
  blocks: PdfBlock[];
}

export interface ExtractPdfResult {
  status: "ok" | "not_configured" | "error";
  pages: PdfPage[];
  total_pages: number;
  language: string | null;
  source: "ml" | "fallback";
  latency_ms: number;
  error?: string;
}

interface ExtractPdfResponseBody {
  status?: unknown;
  pages?: unknown;
  total_pages?: unknown;
  language?: unknown;
  _lumo_summary?: unknown;
}

export async function extractPdfCore(args: {
  input: ExtractPdfInput;
  baseUrl: string;
  authorizationHeader: string | null;
  fetchImpl: typeof fetch;
  timeoutMs: number;
  recordUsage: (
    ok: boolean,
    error_code: string | undefined,
    latency_ms: number,
  ) => Promise<void>;
}): Promise<ExtractPdfResult> {
  const started = Date.now();
  const fallback = (error: string, status: "not_configured" | "error" = "error") => ({
    status,
    pages: [],
    total_pages: 0,
    language: null,
    source: "fallback" as const,
    latency_ms: Date.now() - started,
    error,
  });

  if (!args.baseUrl || !args.authorizationHeader) {
    return fallback("ml_extract_pdf_not_configured", "not_configured");
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), args.timeoutMs);
  try {
    const res = await args.fetchImpl(`${args.baseUrl}/api/tools/extract_pdf`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: args.authorizationHeader,
      },
      body: JSON.stringify(args.input),
      signal: controller.signal,
    });
    clearTimeout(timeout);
    const latency_ms = Date.now() - started;
    if (!res.ok) {
      const error_code = `http_${res.status}`;
      await args.recordUsage(false, error_code, latency_ms);
      return fallback(error_code);
    }

    const body = (await res.json()) as ExtractPdfResponseBody;
    const normalized = normalizeExtractPdfResponse(body, latency_ms);
    if (!normalized) {
      await args.recordUsage(false, "malformed_response", latency_ms);
      return fallback("malformed_response");
    }
    await args.recordUsage(normalized.status === "ok", normalized.error, latency_ms);
    return normalized;
  } catch (err) {
    clearTimeout(timeout);
    const latency_ms = Date.now() - started;
    const error_code =
      err instanceof Error && err.name === "AbortError" ? "timeout" : "upstream_error";
    await args.recordUsage(false, error_code, latency_ms);
    return fallback(error_code);
  }
}

export function normalizeExtractPdfResponse(
  body: ExtractPdfResponseBody,
  latency_ms = 0,
): ExtractPdfResult | null {
  const status =
    body.status === "ok" || body.status === "not_configured" || body.status === "error"
      ? body.status
      : null;
  if (!status) return null;

  const pages = normalizePages(body.pages);
  const total_pages = finiteNonNegativeInt(body.total_pages) || inferTotalPages(pages);
  const language = typeof body.language === "string" && body.language ? body.language : null;
  return {
    status,
    pages,
    total_pages,
    language,
    source: "ml",
    latency_ms,
    error: status === "ok" ? undefined : status,
  };
}

function normalizePages(value: unknown): PdfPage[] {
  if (!Array.isArray(value)) return [];
  const pages: PdfPage[] = [];
  for (const raw of value) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const item = raw as Record<string, unknown>;
    const page_number = finitePositiveInt(item.page_number);
    if (!page_number) continue;
    const blocks = normalizeBlocks(item.blocks);
    if (blocks.length === 0) continue;
    pages.push({ page_number, blocks });
  }
  return pages.sort((a, b) => a.page_number - b.page_number);
}

function normalizeBlocks(value: unknown): PdfBlock[] {
  if (!Array.isArray(value)) return [];
  const blocks: PdfBlock[] = [];
  for (const raw of value) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const item = raw as Record<string, unknown>;
    const text = typeof item.text === "string" ? item.text.trim() : "";
    if (!text) continue;
    const bbox = normalizeBbox(item.bbox);
    blocks.push({
      type: normalizeBlockType(item.type),
      text,
      ...(bbox ? { bbox } : {}),
    });
  }
  return blocks;
}

function normalizeBlockType(value: unknown): PdfBlockType {
  return value === "heading" || value === "table" || value === "list"
    ? value
    : "paragraph";
}

function normalizeBbox(value: unknown): [number, number, number, number] | null {
  if (!Array.isArray(value) || value.length !== 4) return null;
  const box: [number, number, number, number] = [
    Number(value[0]),
    Number(value[1]),
    Number(value[2]),
    Number(value[3]),
  ];
  if (box.some((n) => !Number.isFinite(n))) return null;
  return box;
}

function inferTotalPages(pages: PdfPage[]): number {
  return pages.reduce((max, page) => Math.max(max, page.page_number), 0);
}

function finitePositiveInt(value: unknown): number | null {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 1) return null;
  return Math.trunc(n);
}

function finiteNonNegativeInt(value: unknown): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.trunc(n);
}
