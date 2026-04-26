/**
 * /api/cron/index-archive — Day 3 Intelligence Layer indexer.
 *
 * Lumo Core owns this cron because it owns connector_responses_archive,
 * cron auth, and ops visibility. It redacts raw connector payloads before
 * calling Lumo_ML_Service's system-agent /embed tool, then stores 384-dim
 * pgvector rows in content_embeddings for recall.
 */

import { type NextRequest, NextResponse } from "next/server";
import {
  indexImageEmbeddings,
  indexAudioTranscripts,
  indexConnectorArchive,
  indexPdfDocuments,
} from "@/lib/content-indexer";
import { recordCronRun } from "@/lib/ops";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const ENDPOINT = "/api/cron/index-archive";

export async function GET(req: NextRequest) {
  const auth = authorizeCron(req);
  if (!auth.ok) {
    return NextResponse.json({ error: auth.error }, { status: auth.status });
  }

  const startedAt = new Date();
  const enabled = process.env.LUMO_ARCHIVE_INDEXER_ENABLED === "true";
  if (!enabled) {
    const counts = {
      disabled: 1,
      rows_scanned: 0,
      rows_embedded: 0,
      chunks_embedded: 0,
    };
    await recordCronRun({
      endpoint: ENDPOINT,
      started_at: startedAt,
      finished_at: new Date(),
      ok: true,
      counts,
      errors: [],
    });
    return NextResponse.json({
      ok: true,
      skipped: "disabled",
      message: "Set LUMO_ARCHIVE_INDEXER_ENABLED=true to run archive embeddings.",
      counts,
    });
  }

  const url = new URL(req.url);
  const dryRun = url.searchParams.get("dry_run") === "1";
  const rowLimit = intFromEnv("LUMO_ARCHIVE_INDEXER_ROW_LIMIT", 100);
  const embedBatchSize = intFromEnv("LUMO_ARCHIVE_INDEXER_BATCH_SIZE", 32);
  const concurrency = intFromEnv("LUMO_ARCHIVE_INDEXER_CONCURRENCY", 8);

  const [archiveResult, audioResult, pdfResult, imageResult] = await Promise.all([
    indexConnectorArchive({
      rowLimit,
      embedBatchSize,
      concurrency,
      dryRun,
    }),
    indexAudioTranscripts({
      rowLimit,
      embedBatchSize,
      concurrency: Math.min(concurrency, 2),
      dryRun,
    }),
    indexPdfDocuments({
      rowLimit,
      embedBatchSize,
      concurrency: Math.min(concurrency, 2),
      dryRun,
    }),
    indexImageEmbeddings({
      rowLimit,
      embedBatchSize,
      concurrency: Math.min(concurrency, 2),
      dryRun,
    }),
  ]);

  const result = {
    ok: archiveResult.ok && audioResult.ok && pdfResult.ok && imageResult.ok,
    skipped:
      archiveResult.skipped === "no_rows" &&
      audioResult.skipped === "no_rows" &&
      pdfResult.skipped === "no_rows" &&
      imageResult.skipped === "no_rows"
        ? "no_rows"
        : undefined,
    counts: {
      ...prefixCounts("archive", archiveResult.counts),
      ...prefixCounts("audio_transcripts", audioResult.counts),
      ...prefixCounts("pdf_documents", pdfResult.counts),
      ...prefixCounts("image_embeddings", imageResult.counts),
    },
    errors: [
      ...archiveResult.errors,
      ...audioResult.errors,
      ...pdfResult.errors,
      ...imageResult.errors,
    ].slice(0, 20),
  };

  await recordCronRun({
    endpoint: ENDPOINT,
    started_at: startedAt,
    finished_at: new Date(),
    ok: result.ok,
    counts: result.counts,
    errors: result.errors,
  });

  return NextResponse.json(result, { status: result.ok ? 200 : 500 });
}

function authorizeCron(req: NextRequest):
  | { ok: true }
  | { ok: false; status: number; error: string } {
  const expected = process.env.CRON_SECRET ?? process.env.LUMO_CRON_SECRET;
  if (!expected) {
    return { ok: false, status: 503, error: "cron_secret_missing" };
  }
  const bearer = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
  const provided = bearer ?? req.headers.get("x-vercel-cron") ?? "";
  if (provided !== expected) {
    return { ok: false, status: 401, error: "unauthorized" };
  }
  return { ok: true };
}

function intFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : fallback;
}

function prefixCounts(
  prefix: string,
  counts: Record<string, number>,
): Record<string, number> {
  return Object.fromEntries(
    Object.entries(counts).map(([key, value]) => [`${prefix}_${key}`, value]),
  );
}
