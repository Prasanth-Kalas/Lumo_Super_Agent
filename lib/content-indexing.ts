import { createHash } from "node:crypto";

export interface ArchiveContentRow {
  id: string | number;
  user_id: string;
  agent_id: string;
  external_account_id?: string | null;
  endpoint: string;
  request_hash: string;
  response_status: number;
  response_body: unknown;
  fetched_at: string;
}

export interface RedactionResult {
  text: string;
  counts: RedactionCounts;
}

export interface RedactionCounts extends Record<string, number> {
  email: number;
  phone: number;
  credit_card: number;
  ssn: number;
  secret: number;
}

export interface ArchiveTextChunk {
  source_row_id: string;
  source_etag: string;
  chunk_index: number;
  text: string;
  content_hash: string;
  metadata: Record<string, unknown>;
}

export interface AudioTranscriptContentRow {
  id: string | number;
  user_id: string;
  audio_upload_id: string;
  storage_path: string;
  transcript: string;
  segments: unknown;
  language?: string | null;
  duration_s?: number | null;
  model?: string | null;
  created_at: string;
}

export interface PdfDocumentContentRow {
  id: string | number;
  user_id: string;
  document_asset_id: string;
  storage_path: string;
  filename: string;
  pages: unknown;
  total_pages?: number | null;
  language?: string | null;
  created_at: string;
}

export interface ImageEmbeddingContentRow {
  id: string | number;
  user_id: string;
  image_asset_id: string;
  storage_path: string;
  filename: string;
  mime_type: string;
  model: string;
  dimensions: number;
  labels: unknown;
  summary_text: string;
  content_hash: string;
  created_at: string;
}

const INCLUDE_KEY_RE =
  /(^|[_-])(text|title|body|description|summary|snippet|subject|message|name|comment|comments|caption|transcript|content|note|notes|location)([_-]|$)/i;
const EXCLUDE_KEY_RE =
  /(token|secret|password|authorization|cookie|credential|refresh|access[_-]?token|id[_-]?token|api[_-]?key|client[_-]?secret)/i;

const DEFAULT_CHUNK_CHARS = 1200;
const DEFAULT_MAX_CHUNKS = 8;
const DEFAULT_PDF_MAX_CHUNKS = 64;
const MAX_TEXT_PER_ROW = 12_000;
const MAX_TEXT_PER_PDF_PAGE = 16_000;

export function buildArchiveTextChunks(
  row: ArchiveContentRow,
  options: { chunkChars?: number; maxChunks?: number } = {},
): ArchiveTextChunk[] {
  const extracted = extractUsefulStrings(row.response_body);
  if (extracted.length === 0) return [];

  const joined = extracted.join("\n").slice(0, MAX_TEXT_PER_ROW);
  const redacted = redactForEmbedding(joined);
  const normalized = normalizeText(redacted.text);
  if (normalized.length < 24) return [];

  const source_etag = sourceEtag(row);
  const chunkChars = clampInt(options.chunkChars, 400, 4000, DEFAULT_CHUNK_CHARS);
  const maxChunks = clampInt(options.maxChunks, 1, 24, DEFAULT_MAX_CHUNKS);
  return splitIntoChunks(normalized, chunkChars)
    .slice(0, maxChunks)
    .map((text, chunk_index) => ({
      source_row_id: String(row.id),
      source_etag,
      chunk_index,
      text,
      content_hash: sha256(text),
      metadata: {
        source: "connector_responses_archive",
        agent_id: row.agent_id,
        endpoint: row.endpoint,
        request_hash: row.request_hash,
        response_status: row.response_status,
        fetched_at: row.fetched_at,
        external_account_hash: row.external_account_id
          ? sha256(row.external_account_id)
          : null,
        redacted: true,
        redaction_counts: redacted.counts,
      },
    }));
}

export function buildAudioTranscriptTextChunks(
  row: AudioTranscriptContentRow,
  options: { chunkChars?: number; maxChunks?: number } = {},
): ArchiveTextChunk[] {
  const redacted = redactForEmbedding(row.transcript);
  const normalized = normalizeText(redacted.text).slice(0, MAX_TEXT_PER_ROW);
  if (normalized.length < 24) return [];

  const source_etag = audioTranscriptSourceEtag(row);
  const chunkChars = clampInt(options.chunkChars, 400, 4000, DEFAULT_CHUNK_CHARS);
  const maxChunks = clampInt(options.maxChunks, 1, 24, DEFAULT_MAX_CHUNKS);
  return splitIntoChunks(normalized, chunkChars)
    .slice(0, maxChunks)
    .map((text, chunk_index) => ({
      source_row_id: String(row.id),
      source_etag,
      chunk_index,
      text,
      content_hash: sha256(text),
      metadata: {
        source: "audio_transcripts",
        audio_upload_id: row.audio_upload_id,
        storage_path_hash: sha256(row.storage_path),
        language: row.language ?? null,
        duration_s: row.duration_s ?? null,
        model: row.model ?? null,
        segment_count: Array.isArray(row.segments) ? row.segments.length : null,
        created_at: row.created_at,
        redacted: true,
        redaction_counts: redacted.counts,
      },
    }));
}

export function buildPdfDocumentTextChunks(
  row: PdfDocumentContentRow,
  options: { chunkChars?: number; maxChunks?: number } = {},
): ArchiveTextChunk[] {
  const pages = normalizePdfPages(row.pages);
  if (pages.length === 0) return [];

  const source_etag = pdfDocumentSourceEtag(row);
  const chunkChars = clampInt(options.chunkChars, 400, 4000, DEFAULT_CHUNK_CHARS);
  const maxChunks = clampInt(options.maxChunks, 1, 96, DEFAULT_PDF_MAX_CHUNKS);
  const out: ArchiveTextChunk[] = [];

  for (const page of pages) {
    if (out.length >= maxChunks) break;
    const joined = page.texts.join("\n").slice(0, MAX_TEXT_PER_PDF_PAGE);
    const redacted = redactForEmbedding(joined);
    const normalized = normalizeText(redacted.text);
    if (normalized.length < 24) continue;

    for (const text of splitIntoChunks(normalized, chunkChars)) {
      if (out.length >= maxChunks) break;
      out.push({
        source_row_id: String(row.id),
        source_etag,
        chunk_index: out.length,
        text,
        content_hash: sha256(text),
        metadata: {
          source: "pdf_documents",
          document_asset_id: row.document_asset_id,
          filename: row.filename,
          storage_path_hash: sha256(row.storage_path),
          page_number: page.page_number,
          total_pages: finitePositiveInt(row.total_pages) ?? pages.length,
          language: row.language ?? null,
          block_count: page.block_count,
          created_at: row.created_at,
          redacted: true,
          redaction_counts: redacted.counts,
        },
      });
    }
  }

  return out;
}

export function buildImageEmbeddingTextChunks(
  row: ImageEmbeddingContentRow,
  options: { chunkChars?: number; maxChunks?: number } = {},
): ArchiveTextChunk[] {
  const labelText = normalizeImageLabels(row.labels)
    .map((label) => `${label.label} (${Math.round(label.score * 100)}%)`)
    .join(", ");
  const joined = [row.summary_text, labelText ? `Labels: ${labelText}` : ""]
    .filter(Boolean)
    .join("\n")
    .slice(0, MAX_TEXT_PER_ROW);
  const redacted = redactForEmbedding(joined);
  const normalized = normalizeText(redacted.text);
  if (normalized.length < 24) return [];

  const source_etag = imageEmbeddingSourceEtag(row);
  const chunkChars = clampInt(options.chunkChars, 400, 4000, DEFAULT_CHUNK_CHARS);
  const maxChunks = clampInt(options.maxChunks, 1, 8, DEFAULT_MAX_CHUNKS);
  return splitIntoChunks(normalized, chunkChars)
    .slice(0, maxChunks)
    .map((text, chunk_index) => ({
      source_row_id: String(row.id),
      source_etag,
      chunk_index,
      text,
      content_hash: sha256(text),
      metadata: {
        source: "image_embeddings",
        image_asset_id: row.image_asset_id,
        filename: row.filename,
        mime_type: row.mime_type,
        storage_path_hash: sha256(row.storage_path),
        labels: normalizeImageLabels(row.labels),
        model: row.model,
        dimensions: row.dimensions,
        image_content_hash: row.content_hash,
        created_at: row.created_at,
        redacted: true,
        redaction_counts: redacted.counts,
      },
    }));
}

export function sourceEtag(row: ArchiveContentRow): string {
  return sha256(
    stableJson({
      agent_id: row.agent_id,
      endpoint: row.endpoint,
      request_hash: row.request_hash,
      response_status: row.response_status,
      response_body: row.response_body,
    }),
  );
}

export function audioTranscriptSourceEtag(row: AudioTranscriptContentRow): string {
  return sha256(
    stableJson({
      audio_upload_id: row.audio_upload_id,
      transcript: row.transcript,
      segments: row.segments,
      language: row.language ?? null,
      duration_s: row.duration_s ?? null,
      model: row.model ?? null,
    }),
  );
}

export function pdfDocumentSourceEtag(row: PdfDocumentContentRow): string {
  return sha256(
    stableJson({
      document_asset_id: row.document_asset_id,
      filename: row.filename,
      pages: row.pages,
      total_pages: row.total_pages ?? null,
      language: row.language ?? null,
    }),
  );
}

export function imageEmbeddingSourceEtag(row: ImageEmbeddingContentRow): string {
  return sha256(
    stableJson({
      image_asset_id: row.image_asset_id,
      labels: row.labels,
      summary_text: row.summary_text,
      content_hash: row.content_hash,
      model: row.model,
      dimensions: row.dimensions,
    }),
  );
}

export function redactForEmbedding(input: string): RedactionResult {
  const counts: RedactionCounts = {
    email: 0,
    phone: 0,
    credit_card: 0,
    ssn: 0,
    secret: 0,
  };

  let text = input.replace(
    /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi,
    () => {
      counts.email += 1;
      return "[EMAIL]";
    },
  );

  text = text.replace(
    /(^|[^\p{L}\p{N}_])((?:aadhaar|आधार)\s*[:：#-]?\s*\d{4}\s?\d{4}\s?\d{4})(?!\p{L}|\p{N}|_)/giu,
    (_match, prefix) => {
      counts.secret += 1;
      return `${prefix}[SECRET]`;
    },
  );

  text = text.replace(
    /(^|[^\p{L}\p{N}_])((?:passport|passeport|pasaporte|पासपोर्ट)\s*[:：#-]?\s*[A-Z0-9][A-Z0-9 -]{5,14}[A-Z0-9])(?!\p{L}|\p{N}|_)/giu,
    (_match, prefix) => {
      counts.secret += 1;
      return `${prefix}[SECRET]`;
    },
  );

  text = text.replace(/\b[A-Z]{2}\d{2}(?:[ -]?[A-Z0-9]){11,30}\b/g, () => {
    counts.secret += 1;
    return "[SECRET]";
  });

  text = text.replace(/\b\d{3}-\d{2}-\d{4}\b/g, () => {
    counts.ssn += 1;
    return "[SSN]";
  });

  text = text.replace(
    /\b(?:access_token|refresh_token|id_token|api_key|client_secret|password|authorization)\b\s*[:=]\s*["']?[^"',}\s]+/gi,
    (match) => {
      counts.secret += 1;
      const key = match.split(/[:=]/)[0]?.trim() ?? "secret";
      return `${key}=[SECRET]`;
    },
  );

  text = text.replace(
    /\b(?:github_pat|ghp|xox[baprs])[_A-Za-z0-9-]{16,}\b|\b(?:sk|pk)_(?:live|test)_[A-Za-z0-9]{16,}\b/g,
    () => {
      counts.secret += 1;
      return "[SECRET]";
    },
  );

  text = text.replace(/\b(?:\d[ -]*?){13,19}\b/g, (candidate) => {
    const digits = candidate.replace(/\D/g, "");
    if (!passesLuhn(digits)) return candidate;
    counts.credit_card += 1;
    return "[CREDIT_CARD]";
  });

  text = text.replace(
    /(?<![A-Za-z0-9])(?:\+?\d[\d\s().-]{7,}\d)(?![A-Za-z0-9])/g,
    (candidate) => {
      const digits = candidate.replace(/\D/g, "");
      if (digits.length < 10 || digits.length > 15 || passesLuhn(digits)) {
        return candidate;
      }
      counts.phone += 1;
      return "[PHONE]";
    },
  );

  return { text, counts };
}

function normalizeImageLabels(value: unknown): Array<{ label: string; score: number }> {
  if (!Array.isArray(value)) return [];
  const out: Array<{ label: string; score: number }> = [];
  for (const raw of value.slice(0, 12)) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const item = raw as Record<string, unknown>;
    const label = typeof item.label === "string" ? item.label.trim() : "";
    if (!label) continue;
    const score = Number(item.score);
    out.push({
      label: label.slice(0, 120),
      score: Number.isFinite(score) ? Math.max(0, Math.min(1, score)) : 0,
    });
  }
  return out;
}

function normalizePdfPages(value: unknown): Array<{
  page_number: number;
  block_count: number;
  texts: string[];
}> {
  if (!Array.isArray(value)) return [];
  const out: Array<{ page_number: number; block_count: number; texts: string[] }> = [];

  for (const rawPage of value) {
    if (!rawPage || typeof rawPage !== "object" || Array.isArray(rawPage)) continue;
    const page = rawPage as Record<string, unknown>;
    const pageNumber = finitePositiveInt(page.page_number);
    if (!pageNumber || !Array.isArray(page.blocks)) continue;

    const texts: string[] = [];
    for (const rawBlock of page.blocks) {
      if (!rawBlock || typeof rawBlock !== "object" || Array.isArray(rawBlock)) continue;
      const block = rawBlock as Record<string, unknown>;
      const text = typeof block.text === "string" ? normalizeText(block.text) : "";
      if (!text) continue;
      const type = normalizePdfBlockType(block.type);
      texts.push(prefixPdfBlock(type, text));
    }

    if (texts.length > 0) {
      out.push({ page_number: pageNumber, block_count: texts.length, texts });
    }
  }

  return out.sort((a, b) => a.page_number - b.page_number);
}

function normalizePdfBlockType(value: unknown): "heading" | "paragraph" | "table" | "list" {
  return value === "heading" || value === "table" || value === "list"
    ? value
    : "paragraph";
}

function prefixPdfBlock(
  type: "heading" | "paragraph" | "table" | "list",
  text: string,
): string {
  switch (type) {
    case "heading":
      return `Heading: ${text}`;
    case "table":
      return `Table: ${text}`;
    case "list":
      return `List: ${text}`;
    default:
      return text;
  }
}

function extractUsefulStrings(value: unknown): string[] {
  const out: string[] = [];
  walk(value, [], out);
  return unique(out).slice(0, 80);
}

function walk(value: unknown, path: string[], out: string[]): void {
  if (value === null || value === undefined) return;
  const key = path[path.length - 1] ?? "";
  if (EXCLUDE_KEY_RE.test(key)) return;

  if (typeof value === "string") {
    const trimmed = normalizeText(value);
    if (!trimmed || looksMachineOnly(trimmed)) return;
    if (INCLUDE_KEY_RE.test(key) || trimmed.length >= 80) {
      out.push(trimmed);
    }
    return;
  }

  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      walk(value[i], path.concat(String(i)), out);
    }
    return;
  }

  if (typeof value === "object") {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      walk(v, path.concat(k), out);
    }
  }
}

function splitIntoChunks(text: string, chunkChars: number): string[] {
  const chunks: string[] = [];
  let rest = text.trim();
  while (rest.length > 0) {
    if (rest.length <= chunkChars) {
      chunks.push(rest);
      break;
    }
    const slice = rest.slice(0, chunkChars);
    const breakAt = Math.max(
      slice.lastIndexOf("\n"),
      slice.lastIndexOf(". "),
      slice.lastIndexOf("? "),
      slice.lastIndexOf("! "),
      slice.lastIndexOf("; "),
      slice.lastIndexOf(", "),
      slice.lastIndexOf(" "),
    );
    const idx = breakAt >= Math.floor(chunkChars * 0.55) ? breakAt + 1 : chunkChars;
    chunks.push(rest.slice(0, idx).trim());
    rest = rest.slice(idx).trim();
  }
  return chunks.filter((chunk) => chunk.length >= 24);
}

function normalizeText(input: string): string {
  return input.replace(/\s+/g, " ").trim();
}

function looksMachineOnly(input: string): boolean {
  if (/^https?:\/\//i.test(input)) return true;
  if (/^[A-Za-z0-9_-]{24,}$/.test(input)) return true;
  if (/^[0-9a-f]{16,}$/i.test(input)) return true;
  return false;
}

function unique(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const key = value.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(value);
  }
  return out;
}

function passesLuhn(digits: string): boolean {
  if (!/^\d{13,19}$/.test(digits)) return false;
  let sum = 0;
  let alternate = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let n = Number(digits[i]);
    if (alternate) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
    alternate = !alternate;
  }
  return sum % 10 === 0;
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${JSON.stringify(k)}:${stableJson(v)}`);
  return `{${entries.join(",")}}`;
}

function sha256(input: string): string {
  return createHash("sha256").update(input).digest("hex");
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

function finitePositiveInt(value: unknown): number | null {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 1) return null;
  return Math.trunc(n);
}
