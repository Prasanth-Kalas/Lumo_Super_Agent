/**
 * POST /api/chat — streaming orchestrator endpoint.
 *
 * Body: { session_id, messages: ChatMessage[], device_kind?, region? }
 * Response: text/event-stream (SSE) emitting frames of these types:
 *   - { type: "text",       value: string }
 *   - { type: "tool",       value: ToolCallTrace }           (debug only)
 *   - { type: "selection",  value: { kind, payload } }       (rich UI)
 *   - { type: "summary",    value: ConfirmationSummary }     (money gate)
 *   - { type: "leg_status", value: { order, status } }       (compound trip)
 *   - { type: "error",      value: { message } }
 *   Terminates with { type: "done" }.
 *
 * Two turn shapes are handled here:
 *
 *  1. Normal turn — call `runTurn` with a live emit closure. Frames stream
 *     out as Claude produces them (text deltas, tool traces, selection
 *     cards, and — last — the summary).
 *
 *  2. Compound-trip confirm turn — the previous turn produced a draft
 *     TripSummary (via `orchestrator`'s post-loop assembly). If the user's
 *     latest message is affirmative AND a draft trip exists for this
 *     session, we skip the Claude loop entirely and hand off to
 *     `dispatchConfirmedTrip`, which walks the legs in DAG order and
 *     streams `leg_status` frames — plus Saga rollback on any leg failure.
 *
 * Auth is stubbed — wire Clerk in a follow-up PR.
 */

import { NextRequest } from "next/server";
import { isAffirmative } from "@lumo/agent-sdk";
import {
  confirmTrip,
  dispatchConfirmedTrip,
  getTripBySession,
  runTurn,
  type ChatMessage,
  type EmitFrame,
} from "@/lib/orchestrator";

export const runtime = "nodejs"; // orchestrator uses Anthropic SDK + node:crypto
export const dynamic = "force-dynamic";

interface Body {
  session_id: string;
  messages: ChatMessage[];
  device_kind?: "web" | "ios" | "android" | "watch";
  region?: string;
  user_first_name?: string;
}

export async function POST(req: NextRequest): Promise<Response> {
  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return new Response(JSON.stringify({ error: "invalid_json" }), { status: 400 });
  }

  if (!body.session_id || !Array.isArray(body.messages) || body.messages.length === 0) {
    return new Response(JSON.stringify({ error: "invalid_body" }), { status: 400 });
  }

  // TODO(auth): replace with Clerk-derived user
  const user_id = req.headers.get("x-lumo-user-id") ?? "dev-user";
  const user_region = body.region ?? "US";
  const device_kind = body.device_kind ?? "web";

  // TODO(identity): pull from identity service. For now, a bare minimum.
  const user_pii: Record<string, unknown> = {};

  const stream = new ReadableStream({
    async start(controller) {
      const encoder = new TextEncoder();
      let closed = false;
      const send = (frame: unknown) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(frame)}\n\n`));
        } catch {
          // Client disconnected mid-stream. Swallow — nothing to do.
        }
      };

      // Emit closure the orchestrator uses to stream frames live. The
      // orchestrator owns the frame types (see OrchestratorFrame); we
      // just forward them over SSE.
      const emit: EmitFrame = (frame) => send(frame);

      try {
        // ─── Compound-trip confirm turn ──────────────────────────────
        // If the prior turn drafted a TripSummary for this session AND
        // the user just said yes, we bypass the Claude loop and go
        // straight to leg dispatch + Saga.
        const lastUserMessage =
          body.messages.findLast((m) => m.role === "user")?.content ?? "";
        const draft = getTripBySession(body.session_id);
        if (draft && draft.status === "draft" && isAffirmative(lastUserMessage)) {
          // Promote draft → confirmed. Hash is already canonical on the
          // trip record; we pass it back as the equality check (any future
          // payload mutation would change the hash and trip.ts would reject).
          confirmTrip(draft.trip_id, draft.hash);
          await dispatchConfirmedTrip(
            {
              trip_id: draft.trip_id,
              session_id: body.session_id,
              user_id,
              user_region,
              device_kind,
              user_pii,
            },
            emit,
          );
          send({ type: "done" });
          return;
        }

        // ─── Normal turn ─────────────────────────────────────────────
        // runTurn now streams frames via `emit` as they arrive.
        await runTurn(
          {
            session_id: body.session_id,
            user_id,
            user_first_name: body.user_first_name ?? null,
            user_region,
            device_kind,
            messages: body.messages,
            user_pii,
          },
          emit,
        );

        send({ type: "done" });
      } catch (err) {
        console.error("[/api/chat] error:", err);
        send({
          type: "error",
          value: { message: err instanceof Error ? err.message : String(err) },
        });
      } finally {
        closed = true;
        try {
          controller.close();
        } catch {
          // already closed
        }
      }
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
    },
  });
}
