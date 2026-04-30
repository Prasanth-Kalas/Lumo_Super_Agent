import { AuthError, requireServerUser } from "@/lib/auth";
import { getSupabase } from "@/lib/db";
import {
  CompoundPersistenceError,
  isTerminalCompoundStatus,
  legStatusFramesFromEvents,
  loadLegStatusEvents,
  readCompoundStatusForUser,
} from "@/lib/compound/persistence";
import { serializeLegStatusSse } from "@/lib/sse/leg-status";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const POLL_INTERVAL_MS = 1_500;
const HEARTBEAT_INTERVAL_MS = 25_000;

interface RouteContext {
  params: { id: string };
}

/**
 * SSE v2 stream for compound leg status.
 *
 * Implementation note: v1 uses a polling cursor (`id > last_seen_id`) rather
 * than LISTEN/NOTIFY. Polling works reliably in Vercel serverless functions,
 * needs no long-lived Postgres socket, and still replays the canonical
 * `occurred_at asc, id asc` history on every connection.
 */
export async function GET(req: Request, ctx: RouteContext): Promise<Response> {
  try {
    const user = await requireServerUser();
    const db = getSupabase();
    if (!db) return json({ error: "persistence_disabled" }, 503);
    const compoundId = ctx.params.id;
    if (!compoundId) return json({ error: "missing_compound_transaction_id" }, 400);

    const status = await readCompoundStatusForUser(db, compoundId, user.id);
    if (!status) return json({ error: "compound_transaction_not_found" }, 404);

    const encoder = new TextEncoder();
    let cancelled = false;
    req.signal.addEventListener("abort", () => {
      cancelled = true;
    });

    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        let lastEventId = 0;
        let lastHeartbeatAt = Date.now();

        const sendEvents = async () => {
          const rows = await loadLegStatusEvents(db, compoundId, lastEventId);
          for (const row of rows) {
            lastEventId = Math.max(lastEventId, row.id);
            for (const frame of legStatusFramesFromEvents([row])) {
              controller.enqueue(encoder.encode(serializeLegStatusSse(frame)));
            }
          }
        };

        try {
          await sendEvents();
          while (!cancelled) {
            const latestStatus = await readCompoundStatusForUser(db, compoundId, user.id);
            if (!latestStatus || isTerminalCompoundStatus(latestStatus)) break;
            await sleep(POLL_INTERVAL_MS);
            await sendEvents();
            if (Date.now() - lastHeartbeatAt >= HEARTBEAT_INTERVAL_MS) {
              controller.enqueue(encoder.encode(": heartbeat\n\n"));
              lastHeartbeatAt = Date.now();
            }
          }
        } catch (error) {
          controller.enqueue(
            encoder.encode(
              `event: error\ndata: ${JSON.stringify({ error: error instanceof Error ? error.message : "stream_failed" })}\n\n`,
            ),
          );
        } finally {
          controller.close();
        }
      },
      cancel() {
        cancelled = true;
      },
    });

    return new Response(stream, {
      status: 200,
      headers: {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-store, no-transform",
        connection: "keep-alive",
        "x-accel-buffering": "no",
      },
    });
  } catch (error) {
    return errorResponse(error);
  }
}

function errorResponse(error: unknown): Response {
  if (error instanceof AuthError) {
    return json({ error: error.code }, error.code === "not_authenticated" ? 401 : 403);
  }
  if (error instanceof CompoundPersistenceError) {
    return json({ error: error.code, message: error.message }, error.status);
  }
  console.error("[compound] stream failed", error);
  return json({ error: "internal_error" }, 500);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
    },
  });
}
