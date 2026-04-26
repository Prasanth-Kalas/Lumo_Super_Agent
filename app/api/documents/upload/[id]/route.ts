import { type NextRequest, NextResponse } from "next/server";
import { getServerUser } from "@/lib/auth";
import { getSupabase } from "@/lib/db";
import { indexPdfDocuments } from "@/lib/content-indexer";
import { extractPdf } from "@/lib/pdf-extraction";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

interface DocumentAssetRow {
  id: string;
  user_id: string;
  bucket: string;
  storage_path: string;
  filename: string;
  mime_type: string;
  size_bytes: number;
  sha256: string;
  status: "pending_upload" | "uploaded" | "extracting" | "extracted" | "failed";
  pdf_document_id: number | null;
  error_text: string | null;
  created_at: string;
  uploaded_at: string | null;
  extracted_at: string | null;
}

interface FinalizePayload {
  filename?: string;
}

export async function GET(
  _req: NextRequest,
  { params }: { params: { id: string } },
) {
  const user = await getServerUser();
  if (!user?.id) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const row = await readUpload(params.id, user.id);
  if (!row) return NextResponse.json({ error: "not_found" }, { status: 404 });
  return NextResponse.json(toPublicDocument(row));
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: { id: string } },
) {
  const user = await getServerUser();
  if (!user?.id) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const sb = getSupabase();
  if (!sb) {
    return NextResponse.json({ error: "document storage unconfigured" }, { status: 503 });
  }

  const row = await readUpload(params.id, user.id);
  if (!row) return NextResponse.json({ error: "not_found" }, { status: 404 });
  if (row.status === "extracted" && row.pdf_document_id) {
    return NextResponse.json(toPublicDocument(row));
  }

  let body: FinalizePayload = {};
  try {
    body = (await req.json()) as FinalizePayload;
  } catch {
    body = {};
  }

  const filename = sanitizeFilename(body.filename) ?? row.filename;
  await sb
    .from("document_assets")
    .update({
      status: "extracting",
      uploaded_at: row.uploaded_at ?? new Date().toISOString(),
      filename,
      error_text: null,
    })
    .eq("id", row.id)
    .eq("user_id", user.id);

  const { data: signed, error: signedErr } = await sb.storage
    .from(row.bucket || "documents")
    .createSignedUrl(row.storage_path, 60 * 60);
  if (signedErr || !signed?.signedUrl) {
    await markFailed(row.id, user.id, "could_not_sign_document_read_url");
    return NextResponse.json({ error: "could not sign document read url" }, { status: 500 });
  }

  const result = await extractPdf({
    user_id: user.id,
    input: {
      pdf_url: signed.signedUrl,
      source_metadata: {
        document_asset_id: row.id,
        filename,
      },
    },
  });

  if (result.status !== "ok" || result.pages.length === 0) {
    const error =
      result.status === "ok" ? "no_extractable_pdf_text" : result.error ?? result.status;
    await markFailed(row.id, user.id, error);
    return NextResponse.json(
      { ...toPublicDocument({ ...row, status: "failed", error_text: error }), error },
      { status: result.status === "not_configured" ? 503 : 502 },
    );
  }

  const { data: document, error: documentErr } = await sb
    .from("pdf_documents")
    .upsert(
      {
        user_id: user.id,
        document_asset_id: row.id,
        storage_path: row.storage_path,
        filename,
        pages: result.pages,
        total_pages: Math.max(result.total_pages, result.pages.length),
        language: result.language,
      },
      { onConflict: "document_asset_id" },
    )
    .select("id")
    .single();
  if (documentErr || !document?.id) {
    console.error("[documents/upload] pdf document insert failed", documentErr);
    await markFailed(row.id, user.id, "could_not_store_pdf_document");
    return NextResponse.json({ error: "could not store pdf document" }, { status: 500 });
  }

  const now = new Date().toISOString();
  const { data: updated, error: updateErr } = await sb
    .from("document_assets")
    .update({
      status: "extracted",
      pdf_document_id: document.id,
      extracted_at: now,
      uploaded_at: row.uploaded_at ?? now,
      filename,
      error_text: null,
    })
    .eq("id", row.id)
    .eq("user_id", user.id)
    .select("id, user_id, bucket, storage_path, filename, mime_type, size_bytes, sha256, status, pdf_document_id, error_text, created_at, uploaded_at, extracted_at")
    .single();
  if (updateErr || !updated) {
    console.error("[documents/upload] upload update failed", updateErr);
    return NextResponse.json({ error: "could not finalize pdf document" }, { status: 500 });
  }

  const indexResult = await indexPdfDocuments({
    rowLimit: 10,
    embedBatchSize: 8,
    concurrency: 1,
  });

  return NextResponse.json({
    ...toPublicDocument(updated as DocumentAssetRow),
    pdf_document_id: document.id,
    extraction: {
      total_pages: Math.max(result.total_pages, result.pages.length),
      language: result.language,
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

async function readUpload(id: string, user_id: string): Promise<DocumentAssetRow | null> {
  const sb = getSupabase();
  if (!sb) return null;
  const { data, error } = await sb
    .from("document_assets")
    .select("id, user_id, bucket, storage_path, filename, mime_type, size_bytes, sha256, status, pdf_document_id, error_text, created_at, uploaded_at, extracted_at")
    .eq("id", id)
    .eq("user_id", user_id)
    .is("deleted_at", null)
    .limit(1)
    .maybeSingle();
  if (error) {
    console.error("[documents/upload] read failed", error);
    return null;
  }
  return (data as DocumentAssetRow | null) ?? null;
}

async function markFailed(id: string, user_id: string, error_text: string): Promise<void> {
  const sb = getSupabase();
  if (!sb) return;
  await sb
    .from("document_assets")
    .update({
      status: "failed",
      error_text: error_text.slice(0, 500),
    })
    .eq("id", id)
    .eq("user_id", user_id);
}

function toPublicDocument(row: DocumentAssetRow) {
  return {
    id: row.id,
    status: row.status,
    pdf_document_id: row.pdf_document_id,
    filename: row.filename,
    mime_type: row.mime_type,
    size_bytes: row.size_bytes,
    error_text: row.error_text,
    created_at: row.created_at,
    uploaded_at: row.uploaded_at,
    extracted_at: row.extracted_at,
  };
}

function sanitizeFilename(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const cleaned = value
    .trim()
    .replace(/[\\/:\0]/g, "_")
    .replace(/\s+/g, " ")
    .slice(0, 180);
  if (!cleaned) return null;
  return cleaned.toLowerCase().endsWith(".pdf") ? cleaned : `${cleaned}.pdf`;
}
