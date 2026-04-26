/**
 * /api/documents/upload — signed-URL pipeline for PDF recall.
 *
 * The browser uploads PDFs directly to Supabase Storage, then calls
 * PATCH /api/documents/upload/[id] to finalize and extract layout.
 * Lumo Core signs a short read URL for the brain; raw PDFs never pass
 * through the chat/orchestrator path.
 */

import { type NextRequest, NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { getServerUser } from "@/lib/auth";
import { getSupabase } from "@/lib/db";

export const runtime = "nodejs";

const MAX_BYTES = 100 * 1024 * 1024;
const SIGNED_URL_TTL_SECONDS = 600;
const ALLOWED_MIME = new Set<string>(["application/pdf"]);

interface UploadRequestPayload {
  mime_type?: string;
  size_bytes?: number;
  sha256?: string;
  filename?: string;
}

export async function POST(req: NextRequest) {
  const user = await getServerUser();
  if (!user?.id) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  let body: UploadRequestPayload;
  try {
    body = (await req.json()) as UploadRequestPayload;
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }

  if (!body.mime_type || !ALLOWED_MIME.has(body.mime_type)) {
    return NextResponse.json(
      { error: "mime_type not allowed", allowed: [...ALLOWED_MIME] },
      { status: 400 },
    );
  }
  if (
    typeof body.size_bytes !== "number" ||
    body.size_bytes <= 0 ||
    body.size_bytes > MAX_BYTES
  ) {
    return NextResponse.json(
      { error: `size_bytes must be 1..${MAX_BYTES}` },
      { status: 400 },
    );
  }

  const sb = getSupabase();
  if (!sb) {
    return NextResponse.json(
      { error: "document storage unconfigured" },
      { status: 503 },
    );
  }

  if (body.sha256) {
    const { data: existing } = await sb
      .from("document_assets")
      .select("id, storage_path, status, pdf_document_id")
      .eq("user_id", user.id)
      .eq("sha256", body.sha256)
      .is("deleted_at", null)
      .limit(1)
      .maybeSingle();
    if (existing) {
      return NextResponse.json({
        id: existing.id,
        already_uploaded: true,
        storage_path: existing.storage_path,
        status: existing.status,
        pdf_document_id: existing.pdf_document_id,
      });
    }
  }

  const id = `doc_${randomUUID()}`;
  const bucket = "documents";
  const storage_path = `users/${user.id}/${id}.pdf`;
  const filename = sanitizeFilename(body.filename);

  const { data: signed, error: signedErr } = await sb.storage
    .from(bucket)
    .createSignedUploadUrl(storage_path);
  if (signedErr || !signed) {
    console.error("[documents/upload] signed url mint failed", signedErr);
    return NextResponse.json(
      { error: "could not mint signed upload url" },
      { status: 500 },
    );
  }

  const { error: insertErr } = await sb.from("document_assets").insert({
    id,
    user_id: user.id,
    bucket,
    storage_path,
    filename,
    mime_type: body.mime_type,
    size_bytes: body.size_bytes,
    sha256: body.sha256 ?? "pending",
    status: "pending_upload",
  });
  if (insertErr) {
    console.error("[documents/upload] insert failed", insertErr);
    return NextResponse.json({ error: "could not record document upload" }, { status: 500 });
  }

  return NextResponse.json({
    id,
    upload_url: signed.signedUrl,
    upload_token: signed.token ?? null,
    storage_path,
    bucket,
    filename,
    status: "pending_upload",
    expires_in_seconds: SIGNED_URL_TTL_SECONDS,
    max_bytes: MAX_BYTES,
  });
}

function sanitizeFilename(value: unknown): string {
  if (typeof value !== "string") return "document.pdf";
  const cleaned = value
    .trim()
    .replace(/[\\/:\0]/g, "_")
    .replace(/\s+/g, " ")
    .slice(0, 180);
  if (!cleaned) return "document.pdf";
  return cleaned.toLowerCase().endsWith(".pdf") ? cleaned : `${cleaned}.pdf`;
}
