/**
 * /api/images/upload — signed-URL pipeline for CLIP image recall.
 *
 * The browser uploads image bytes directly to Supabase Storage, then calls
 * PATCH /api/images/upload/[id] to finalize and embed. Lumo Core signs a
 * short read URL for the brain; raw image bytes never go through chat.
 */

import { type NextRequest, NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { getServerUser } from "@/lib/auth";
import { getSupabase } from "@/lib/db";

export const runtime = "nodejs";

const MAX_BYTES = 25 * 1024 * 1024;
const SIGNED_URL_TTL_SECONDS = 600;
const ALLOWED_MIME = new Set<string>([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
]);

interface UploadRequestPayload {
  mime_type?: string;
  size_bytes?: number;
  sha256?: string;
  filename?: string;
  width_px?: number;
  height_px?: number;
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
    return NextResponse.json({ error: "image storage unconfigured" }, { status: 503 });
  }

  if (body.sha256) {
    const { data: existing } = await sb
      .from("image_assets")
      .select("id, storage_path, status, image_embedding_id")
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
        image_embedding_id: existing.image_embedding_id,
      });
    }
  }

  const id = `img_${randomUUID()}`;
  const bucket = "images";
  const ext = pickExtension(body.mime_type);
  const storage_path = `users/${user.id}/${id}${ext}`;
  const filename = sanitizeFilename(body.filename, ext);

  const { data: signed, error: signedErr } = await sb.storage
    .from(bucket)
    .createSignedUploadUrl(storage_path);
  if (signedErr || !signed) {
    console.error("[images/upload] signed url mint failed", signedErr);
    return NextResponse.json(
      { error: "could not mint signed upload url" },
      { status: 500 },
    );
  }

  const { error: insertErr } = await sb.from("image_assets").insert({
    id,
    user_id: user.id,
    bucket,
    storage_path,
    filename,
    mime_type: body.mime_type,
    size_bytes: body.size_bytes,
    sha256: body.sha256 ?? "pending",
    width_px: finiteInt(body.width_px),
    height_px: finiteInt(body.height_px),
    status: "pending_upload",
  });
  if (insertErr) {
    console.error("[images/upload] insert failed", insertErr);
    return NextResponse.json({ error: "could not record image upload" }, { status: 500 });
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

function pickExtension(mime: string): string {
  switch (mime) {
    case "image/jpeg":
      return ".jpg";
    case "image/png":
      return ".png";
    case "image/webp":
      return ".webp";
    case "image/gif":
      return ".gif";
    default:
      return "";
  }
}

function sanitizeFilename(value: unknown, ext: string): string {
  const fallback = `image${ext || ".jpg"}`;
  if (typeof value !== "string") return fallback;
  const cleaned = value
    .trim()
    .replace(/[\\/:\0]/g, "_")
    .replace(/\s+/g, " ")
    .slice(0, 180);
  if (!cleaned) return fallback;
  return /\.[a-z0-9]{2,5}$/i.test(cleaned) ? cleaned : `${cleaned}${ext || ".jpg"}`;
}

function finiteInt(value: unknown): number | null {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.trunc(n);
}
