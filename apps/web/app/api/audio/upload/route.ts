/**
 * /api/audio/upload — signed-URL pipeline for audio transcripts.
 *
 * The browser uploads audio directly to Supabase Storage, then calls
 * PATCH /api/audio/upload/[id] to finalize and transcribe. Lumo Core
 * signs a short read URL for the brain; raw audio never goes through
 * the chat/orchestrator path.
 */

import { type NextRequest, NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { getServerUser } from "@/lib/auth";
import { getSupabase } from "@/lib/db";

export const runtime = "nodejs";

const MAX_BYTES = 200 * 1024 * 1024;
const SIGNED_URL_TTL_SECONDS = 600;

const ALLOWED_MIME = new Set<string>([
  "audio/mpeg",
  "audio/mp4",
  "audio/wav",
  "audio/x-wav",
  "audio/webm",
  "audio/ogg",
  "audio/aac",
  "audio/flac",
  "audio/x-m4a",
  "video/mp4",
  "video/quicktime",
  "video/webm",
]);

interface UploadRequestPayload {
  mime_type?: string;
  size_bytes?: number;
  sha256?: string;
  duration_ms?: number;
  language?: string;
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
      { error: "audio storage unconfigured" },
      { status: 503 },
    );
  }

  if (body.sha256) {
    const { data: existing } = await sb
      .from("audio_uploads")
      .select("id, storage_path, status, transcript_id")
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
        transcript_id: existing.transcript_id,
      });
    }
  }

  const id = `audio_${randomUUID()}`;
  const bucket = "audio";
  const ext = pickExtension(body.mime_type);
  const storage_path = `users/${user.id}/${id}${ext}`;

  const { data: signed, error: signedErr } = await sb.storage
    .from(bucket)
    .createSignedUploadUrl(storage_path);
  if (signedErr || !signed) {
    console.error("[audio/upload] signed url mint failed", signedErr);
    return NextResponse.json(
      { error: "could not mint signed upload url" },
      { status: 500 },
    );
  }

  const { error: insertErr } = await sb.from("audio_uploads").insert({
    id,
    user_id: user.id,
    bucket,
    storage_path,
    mime_type: body.mime_type,
    size_bytes: body.size_bytes,
    sha256: body.sha256 ?? "pending",
    duration_ms: body.duration_ms ?? null,
    language: normalizeLanguage(body.language),
    status: "pending_upload",
  });
  if (insertErr) {
    console.error("[audio/upload] insert failed", insertErr);
    return NextResponse.json({ error: "could not record audio upload" }, { status: 500 });
  }

  return NextResponse.json({
    id,
    upload_url: signed.signedUrl,
    upload_token: signed.token ?? null,
    storage_path,
    bucket,
    status: "pending_upload",
    expires_in_seconds: SIGNED_URL_TTL_SECONDS,
    max_bytes: MAX_BYTES,
  });
}

function normalizeLanguage(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim().slice(0, 16);
  return trimmed || null;
}

function pickExtension(mime: string): string {
  switch (mime) {
    case "audio/mpeg":
      return ".mp3";
    case "audio/mp4":
    case "audio/x-m4a":
      return ".m4a";
    case "audio/wav":
    case "audio/x-wav":
      return ".wav";
    case "audio/webm":
    case "video/webm":
      return ".webm";
    case "audio/ogg":
      return ".ogg";
    case "audio/aac":
      return ".aac";
    case "audio/flac":
      return ".flac";
    case "video/mp4":
      return ".mp4";
    case "video/quicktime":
      return ".mov";
    default:
      return "";
  }
}
