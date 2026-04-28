import { type NextRequest, NextResponse } from "next/server";
import { getServerUser } from "@/lib/auth";
import { getSupabase } from "@/lib/db";
import { indexAudioTranscripts } from "@/lib/content-indexer";
import { transcribeAudio } from "@/lib/audio-transcription";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

interface AudioUploadRow {
  id: string;
  user_id: string;
  bucket: string;
  storage_path: string;
  mime_type: string;
  size_bytes: number;
  sha256: string;
  duration_ms: number | null;
  language: string | null;
  status: "pending_upload" | "uploaded" | "transcribing" | "transcribed" | "failed";
  transcript_id: number | null;
  error_text: string | null;
  created_at: string;
  uploaded_at: string | null;
  transcribed_at: string | null;
}

interface FinalizePayload {
  language?: string;
  duration_ms?: number;
  speaker_diarization?: boolean;
}

export async function GET(
  _req: NextRequest,
  { params }: { params: { id: string } },
) {
  const user = await getServerUser();
  if (!user?.id) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const row = await readUpload(params.id, user.id);
  if (!row) return NextResponse.json({ error: "not_found" }, { status: 404 });
  return NextResponse.json(toPublicUpload(row));
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: { id: string } },
) {
  const user = await getServerUser();
  if (!user?.id) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const sb = getSupabase();
  if (!sb) {
    return NextResponse.json({ error: "audio storage unconfigured" }, { status: 503 });
  }

  const row = await readUpload(params.id, user.id);
  if (!row) return NextResponse.json({ error: "not_found" }, { status: 404 });
  if (row.status === "transcribed" && row.transcript_id) {
    return NextResponse.json(toPublicUpload(row));
  }

  let body: FinalizePayload = {};
  try {
    body = (await req.json()) as FinalizePayload;
  } catch {
    body = {};
  }

  await sb
    .from("audio_uploads")
    .update({
      status: "transcribing",
      uploaded_at: row.uploaded_at ?? new Date().toISOString(),
      duration_ms: Number.isFinite(body.duration_ms) ? Math.trunc(Number(body.duration_ms)) : row.duration_ms,
      language: normalizeLanguage(body.language) ?? row.language,
      error_text: null,
    })
    .eq("id", row.id)
    .eq("user_id", user.id);

  const { data: signed, error: signedErr } = await sb.storage
    .from(row.bucket || "audio")
    .createSignedUrl(row.storage_path, 60 * 60);
  if (signedErr || !signed?.signedUrl) {
    await markFailed(row.id, user.id, "could_not_sign_audio_read_url");
    return NextResponse.json({ error: "could not sign audio read url" }, { status: 500 });
  }

  const result = await transcribeAudio({
    user_id: user.id,
    input: {
      audio_url: signed.signedUrl,
      language: normalizeLanguage(body.language) ?? row.language ?? undefined,
      speaker_diarization: body.speaker_diarization === true,
    },
  });

  if (result.status !== "ok" || !result.transcript.trim()) {
    const error = result.error ?? result.status;
    await markFailed(row.id, user.id, error);
    return NextResponse.json(
      { ...toPublicUpload({ ...row, status: "failed", error_text: error }), error },
      { status: result.status === "not_configured" ? 503 : 502 },
    );
  }

  const { data: transcript, error: transcriptErr } = await sb
    .from("audio_transcripts")
    .upsert(
      {
        user_id: user.id,
        audio_upload_id: row.id,
        storage_path: row.storage_path,
        transcript: result.transcript,
        segments: result.segments,
        language: result.language,
        duration_s: result.duration_s,
        model: result.model,
      },
      { onConflict: "audio_upload_id" },
    )
    .select("id")
    .single();
  if (transcriptErr || !transcript?.id) {
    console.error("[audio/upload] transcript insert failed", transcriptErr);
    await markFailed(row.id, user.id, "could_not_store_transcript");
    return NextResponse.json({ error: "could not store transcript" }, { status: 500 });
  }

  const now = new Date().toISOString();
  const { data: updated, error: updateErr } = await sb
    .from("audio_uploads")
    .update({
      status: "transcribed",
      transcript_id: transcript.id,
      transcribed_at: now,
      uploaded_at: row.uploaded_at ?? now,
      duration_ms: result.duration_s ? Math.round(result.duration_s * 1000) : row.duration_ms,
      language: result.language,
      error_text: null,
    })
    .eq("id", row.id)
    .eq("user_id", user.id)
    .select("id, user_id, bucket, storage_path, mime_type, size_bytes, sha256, duration_ms, language, status, transcript_id, error_text, created_at, uploaded_at, transcribed_at")
    .single();
  if (updateErr || !updated) {
    console.error("[audio/upload] upload update failed", updateErr);
    return NextResponse.json({ error: "could not finalize transcript" }, { status: 500 });
  }

  const indexResult = await indexAudioTranscripts({
    rowLimit: 10,
    embedBatchSize: 8,
    concurrency: 1,
  });

  return NextResponse.json({
    ...toPublicUpload(updated as AudioUploadRow),
    transcript_id: transcript.id,
    transcription: {
      diarization: result.diarization,
      language: result.language,
      duration_s: result.duration_s,
      segment_count: result.segments.length,
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

async function readUpload(id: string, user_id: string): Promise<AudioUploadRow | null> {
  const sb = getSupabase();
  if (!sb) return null;
  const { data, error } = await sb
    .from("audio_uploads")
    .select("id, user_id, bucket, storage_path, mime_type, size_bytes, sha256, duration_ms, language, status, transcript_id, error_text, created_at, uploaded_at, transcribed_at")
    .eq("id", id)
    .eq("user_id", user_id)
    .is("deleted_at", null)
    .limit(1)
    .maybeSingle();
  if (error) {
    console.error("[audio/upload] read failed", error);
    return null;
  }
  return (data as AudioUploadRow | null) ?? null;
}

async function markFailed(id: string, user_id: string, error_text: string): Promise<void> {
  const sb = getSupabase();
  if (!sb) return;
  await sb
    .from("audio_uploads")
    .update({
      status: "failed",
      error_text: error_text.slice(0, 500),
    })
    .eq("id", id)
    .eq("user_id", user_id);
}

function toPublicUpload(row: AudioUploadRow) {
  return {
    id: row.id,
    status: row.status,
    transcript_id: row.transcript_id,
    mime_type: row.mime_type,
    size_bytes: row.size_bytes,
    duration_ms: row.duration_ms,
    language: row.language,
    error_text: row.error_text,
    created_at: row.created_at,
    uploaded_at: row.uploaded_at,
    transcribed_at: row.transcribed_at,
  };
}

function normalizeLanguage(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim().slice(0, 16);
  return trimmed || null;
}
