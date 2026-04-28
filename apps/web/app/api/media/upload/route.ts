/**
 * /api/media/upload — signed-URL pipeline for post media.
 *
 * Two-phase upload:
 *   1. POST /api/media/upload with { mime_type, size_bytes, sha256? }
 *      → returns { id, upload_url, storage_path, expires_in_seconds }
 *   2. Client PUTs the file directly to upload_url (Supabase Storage
 *      signed-upload). On success, the row is finalized server-side
 *      via PATCH /api/media/upload/[id]/finalize.
 *
 * Why two phases: keeps large payloads off Vercel's serverless 4.5MB
 * body cap and lets us cap per-asset size at 100MB without inflating
 * function memory. The finalize endpoint records width/height/duration
 * after the upload completes.
 *
 * Security:
 *   - Auth required.
 *   - mime_type allowlist (image + video).
 *   - size_bytes cap enforced both at signed-URL mint AND at finalize
 *     (Supabase enforces too).
 *   - sha256 dedupes — same hash for same user returns existing row.
 */

import { type NextRequest, NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { getServerUser } from "@/lib/auth";
import { getSupabase } from "@/lib/db";

export const runtime = "nodejs";

const MAX_BYTES = 100 * 1024 * 1024; // 100 MB
const SIGNED_URL_TTL_SECONDS = 600; // 10 min

const ALLOWED_MIME = new Set<string>([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
  "video/mp4",
  "video/quicktime",
  "video/webm",
]);

interface UploadRequestPayload {
  mime_type?: string;
  size_bytes?: number;
  sha256?: string;
  width_px?: number;
  height_px?: number;
  duration_ms?: number;
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
      { error: "media storage unconfigured" },
      { status: 503 },
    );
  }

  // Dedupe: same user + same sha256 + still alive → return existing row.
  if (body.sha256) {
    const { data: existing } = await sb
      .from("media_assets")
      .select("id, storage_path, mime_type, size_bytes")
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
      });
    }
  }

  const id = `media_${randomUUID()}`;
  const ext = pickExtension(body.mime_type);
  const storage_path = `users/${user.id}/${id}${ext}`;
  const bucket = "media";

  // Mint signed-upload URL via Supabase Storage. The client PUTs the
  // file body directly to this URL within SIGNED_URL_TTL_SECONDS.
  let upload_url: string | null = null;
  let token: string | null = null;
  try {
    const { data: signed, error: signedErr } = await sb.storage
      .from(bucket)
      .createSignedUploadUrl(storage_path);
    if (signedErr || !signed) {
      console.error("[media/upload] signed url mint failed", signedErr);
      return NextResponse.json(
        { error: "could not mint signed upload url" },
        { status: 500 },
      );
    }
    upload_url = signed.signedUrl;
    token = signed.token ?? null;
  } catch (err) {
    console.error("[media/upload] signed url threw", err);
    return NextResponse.json(
      { error: "could not mint signed upload url" },
      { status: 500 },
    );
  }

  // Insert pending row. The finalize endpoint flips this when the
  // client-side upload succeeds. If the upload never happens, the row
  // remains and a sweep (future task) prunes pending older than 1h.
  const { error: insertErr } = await sb.from("media_assets").insert({
    id,
    user_id: user.id,
    storage_path,
    mime_type: body.mime_type,
    size_bytes: body.size_bytes,
    sha256: body.sha256 ?? "pending",
    width_px: body.width_px ?? null,
    height_px: body.height_px ?? null,
    duration_ms: body.duration_ms ?? null,
  });
  if (insertErr) {
    console.error("[media/upload] insert failed", insertErr);
    return NextResponse.json({ error: "could not record asset" }, { status: 500 });
  }

  return NextResponse.json({
    id,
    upload_url,
    upload_token: token,
    storage_path,
    bucket,
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
    case "video/mp4":
      return ".mp4";
    case "video/quicktime":
      return ".mov";
    case "video/webm":
      return ".webm";
    default:
      return "";
  }
}
