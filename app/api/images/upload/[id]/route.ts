import { type NextRequest, NextResponse } from "next/server";
import { getServerUser } from "@/lib/auth";
import { getSupabase } from "@/lib/db";
import { embedImage } from "@/lib/image-embedding";
import { indexImageEmbeddings } from "@/lib/content-indexer";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

const DEFAULT_LABELS = [
  "travel document",
  "receipt",
  "restaurant food",
  "hotel room",
  "flight itinerary",
  "event ticket",
  "tourist attraction",
  "map or route",
  "electric vehicle charger",
  "calendar screenshot",
  "business chart",
  "contract document",
  "product photo",
  "landmark",
];

interface ImageAssetRow {
  id: string;
  user_id: string;
  bucket: string;
  storage_path: string;
  filename: string;
  mime_type: string;
  size_bytes: number;
  sha256: string;
  width_px: number | null;
  height_px: number | null;
  status: "pending_upload" | "uploaded" | "embedding" | "embedded" | "failed";
  image_embedding_id: number | null;
  error_text: string | null;
  created_at: string;
  uploaded_at: string | null;
  embedded_at: string | null;
}

interface FinalizePayload {
  filename?: string;
  width_px?: number;
  height_px?: number;
  candidate_labels?: string[];
}

export async function GET(
  _req: NextRequest,
  { params }: { params: { id: string } },
) {
  const user = await getServerUser();
  if (!user?.id) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const row = await readUpload(params.id, user.id);
  if (!row) return NextResponse.json({ error: "not_found" }, { status: 404 });
  return NextResponse.json(toPublicImage(row));
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: { id: string } },
) {
  const user = await getServerUser();
  if (!user?.id) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const sb = getSupabase();
  if (!sb) {
    return NextResponse.json({ error: "image storage unconfigured" }, { status: 503 });
  }

  const row = await readUpload(params.id, user.id);
  if (!row) return NextResponse.json({ error: "not_found" }, { status: 404 });
  if (row.status === "embedded" && row.image_embedding_id) {
    return NextResponse.json(toPublicImage(row));
  }

  let body: FinalizePayload = {};
  try {
    body = (await req.json()) as FinalizePayload;
  } catch {
    body = {};
  }

  const filename = sanitizeFilename(body.filename) ?? row.filename;
  await sb
    .from("image_assets")
    .update({
      status: "embedding",
      uploaded_at: row.uploaded_at ?? new Date().toISOString(),
      filename,
      width_px: finiteInt(body.width_px) ?? row.width_px,
      height_px: finiteInt(body.height_px) ?? row.height_px,
      error_text: null,
    })
    .eq("id", row.id)
    .eq("user_id", user.id);

  const { data: signed, error: signedErr } = await sb.storage
    .from(row.bucket || "images")
    .createSignedUrl(row.storage_path, 60 * 60);
  if (signedErr || !signed?.signedUrl) {
    await markFailed(row.id, user.id, "could_not_sign_image_read_url");
    return NextResponse.json({ error: "could not sign image read url" }, { status: 500 });
  }

  const result = await embedImage({
    user_id: user.id,
    input: {
      image_url: signed.signedUrl,
      candidate_labels: normalizeCandidateLabels(body.candidate_labels),
      source_metadata: {
        image_asset_id: row.id,
        filename,
      },
    },
  });

  if (result.status !== "ok" || result.embedding.length === 0) {
    const error = result.error ?? result.status;
    await markFailed(row.id, user.id, error);
    return NextResponse.json(
      { ...toPublicImage({ ...row, status: "failed", error_text: error }), error },
      { status: result.status === "not_configured" ? 503 : 502 },
    );
  }

  const { data: embedding, error: embeddingErr } = await sb
    .from("image_embeddings")
    .upsert(
      {
        user_id: user.id,
        image_asset_id: row.id,
        storage_path: row.storage_path,
        filename,
        mime_type: row.mime_type,
        model: result.model,
        dimensions: result.dimensions,
        embedding: toPgVector(result.embedding),
        labels: result.labels,
        summary_text: result.summary_text,
        content_hash: result.content_hash,
      },
      { onConflict: "image_asset_id" },
    )
    .select("id")
    .single();
  if (embeddingErr || !embedding?.id) {
    console.error("[images/upload] image embedding insert failed", embeddingErr);
    await markFailed(row.id, user.id, "could_not_store_image_embedding");
    return NextResponse.json({ error: "could not store image embedding" }, { status: 500 });
  }

  const now = new Date().toISOString();
  const { data: updated, error: updateErr } = await sb
    .from("image_assets")
    .update({
      status: "embedded",
      image_embedding_id: embedding.id,
      embedded_at: now,
      uploaded_at: row.uploaded_at ?? now,
      filename,
      error_text: null,
    })
    .eq("id", row.id)
    .eq("user_id", user.id)
    .select("id, user_id, bucket, storage_path, filename, mime_type, size_bytes, sha256, width_px, height_px, status, image_embedding_id, error_text, created_at, uploaded_at, embedded_at")
    .single();
  if (updateErr || !updated) {
    console.error("[images/upload] upload update failed", updateErr);
    return NextResponse.json({ error: "could not finalize image embedding" }, { status: 500 });
  }

  const indexResult = await indexImageEmbeddings({
    rowLimit: 10,
    embedBatchSize: 8,
    concurrency: 1,
  });

  return NextResponse.json({
    ...toPublicImage(updated as ImageAssetRow),
    image_embedding_id: embedding.id,
    embedding: {
      model: result.model,
      dimensions: result.dimensions,
      labels: result.labels,
      summary_text: result.summary_text,
      latency_ms: result.latency_ms,
    },
    indexing: {
      ok: indexResult.ok,
      skipped: indexResult.skipped ?? null,
      counts: indexResult.counts,
      errors: indexResult.errors,
    },
  });
}

async function readUpload(id: string, user_id: string): Promise<ImageAssetRow | null> {
  const sb = getSupabase();
  if (!sb) return null;
  const { data, error } = await sb
    .from("image_assets")
    .select("id, user_id, bucket, storage_path, filename, mime_type, size_bytes, sha256, width_px, height_px, status, image_embedding_id, error_text, created_at, uploaded_at, embedded_at")
    .eq("id", id)
    .eq("user_id", user_id)
    .is("deleted_at", null)
    .limit(1)
    .maybeSingle();
  if (error) {
    console.error("[images/upload] read failed", error);
    return null;
  }
  return (data as ImageAssetRow | null) ?? null;
}

async function markFailed(id: string, user_id: string, error_text: string): Promise<void> {
  const sb = getSupabase();
  if (!sb) return;
  await sb
    .from("image_assets")
    .update({
      status: "failed",
      error_text: error_text.slice(0, 500),
    })
    .eq("id", id)
    .eq("user_id", user_id);
}

function toPublicImage(row: ImageAssetRow) {
  return {
    id: row.id,
    status: row.status,
    image_embedding_id: row.image_embedding_id,
    filename: row.filename,
    mime_type: row.mime_type,
    size_bytes: row.size_bytes,
    width_px: row.width_px,
    height_px: row.height_px,
    error_text: row.error_text,
    created_at: row.created_at,
    uploaded_at: row.uploaded_at,
    embedded_at: row.embedded_at,
  };
}

function normalizeCandidateLabels(value: unknown): string[] {
  if (!Array.isArray(value)) return DEFAULT_LABELS;
  const labels = value
    .map((item) => (typeof item === "string" ? item.trim().slice(0, 80) : ""))
    .filter(Boolean);
  return labels.length > 0 ? Array.from(new Set(labels)).slice(0, 64) : DEFAULT_LABELS;
}

function sanitizeFilename(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const cleaned = value
    .trim()
    .replace(/[\\/:\0]/g, "_")
    .replace(/\s+/g, " ")
    .slice(0, 180);
  return cleaned || null;
}

function finiteInt(value: unknown): number | null {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.trunc(n);
}

function toPgVector(v: number[]): string {
  return `[${v.join(",")}]`;
}
