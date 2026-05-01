/**
 * POST /api/chat — streaming orchestrator endpoint.
 *
 * Body: { session_id, messages: ChatMessage[], device_kind?, region? }
 * Response: text/event-stream (SSE) emitting frames of these types:
 *   - { type: "text",       value: string }
 *   - { type: "mission",    value: LumoMissionPlan }       (app install gate)
 *   - { type: "tool",       value: ToolCallTrace }           (debug only)
 *   - { type: "selection",  value: { kind, payload } }       (rich UI)
 *   - { type: "assistant_suggestions", value: { kind, turn_id, suggestions } }
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
 *     TripSummary. If the user's latest message is affirmative AND a
 *     draft trip exists for this session, we skip the Claude loop and
 *     hand off to `dispatchConfirmedTrip`, which walks legs in DAG
 *     order and streams `leg_status` frames — plus Saga rollback on
 *     any leg failure.
 *
 * Audit (task #71):
 *
 *   Every frame that leaves this handler is ALSO written to the
 *   `events` table in Postgres (see `lib/events.ts`). Plus we record
 *   the inbound user message as a `request` event. This is the replay
 *   source — given a session_id we can reconstruct the exact stream
 *   the shell consumed, which in turn reproduces tool calls, card
 *   state, and commit/rollback outcomes. Writes are fire-and-forget;
 *   they never block an SSE frame.
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
  type OrchestratorFrame,
} from "@/lib/orchestrator";
import { recordEvent, type EventFrameType } from "@/lib/events";
import { getServerUser } from "@/lib/auth";
import { resolveCardOutcome } from "@/lib/mission-execution";
import { resolveLatestInputGateForSession } from "@/lib/mission-gate-resolution";
import {
  bookingProfileSnapshotForSession,
  bookingProfileSnapshotToPii,
} from "@/lib/booking-profile";

export const runtime = "nodejs"; // orchestrator uses Anthropic SDK + node:crypto
export const dynamic = "force-dynamic";

interface Body {
  session_id: string;
  messages: ChatMessage[];
  device_kind?: "web" | "ios" | "android" | "watch";
  region?: string;
  /**
   * Deprecated — the server now derives the user's first name from
   * the auth user's metadata. Kept optional for client-side
   * compatibility but any value passed is ignored in favor of the
   * server-side derivation.
   */
  user_first_name?: string;
  /**
   * "voice" when the user is hearing responses (driving, hands-busy).
   * Forwarded to the orchestrator where the system prompt adapts
   * output length and formatting for ears. Defaults to text.
   */
  mode?: "text" | "voice";
  /**
   * Ephemeral right-now signals from the browser. NOT persisted here —
   * threaded into the system prompt for this turn and forgotten. If the
   * user wants Lumo to remember their location as "home", they'll say so
   * and Claude will emit a profile_update.
   */
  ambient?: {
    local_time?: string;
    timezone?: string;
    coords?: { lat: number; lng: number; accuracy_m?: number };
    location_label?: string;
  };
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

  // Resolve the real Lumo user from the Supabase session cookie. When
  // Supabase Auth isn't configured (local dev without envs), we fall
  // back to the legacy x-lumo-user-id header so curl-driven dev still
  // works; the router will reject any tool call that requires a
  // connection unless the dev has also seeded a connection for that
  // user_id in the DB.
  const authedUser = await getServerUser();
  const user_id =
    authedUser?.id ??
    req.headers.get("x-lumo-user-id") ??
    "anon";
  const user_region = body.region ?? "US";
  const device_kind = body.device_kind ?? "web";

  const bookingProfile = user_id !== "anon"
    ? await bookingProfileSnapshotForSession(user_id, body.session_id)
    : null;

  // user_pii starts with auth name/email, then adds booking details the
  // user already approved for this session (default payment method,
  // traveler profile, etc.). The router still intersects this with each
  // agent's pii_scope before sending anything.
  const user_pii: Record<string, unknown> = authedUser
    ? {
        email: authedUser.email,
        name:
          (authedUser.user_metadata as { full_name?: string } | null)
            ?.full_name ?? authedUser.email,
        ...bookingProfileSnapshotToPii(bookingProfile),
      }
    : bookingProfileSnapshotToPii(bookingProfile);

  // Record the inbound user message as an audit event. We record the
  // WHOLE last user message so replay can re-feed the orchestrator
  // without guessing what the user typed. Fire-and-forget.
  const lastUserMessage =
    body.messages.findLast((m) => m.role === "user")?.content ?? "";
  void recordEvent({
    session_id: body.session_id,
    frame_type: "request",
    frame_value: {
      user_id,
      user_region,
      device_kind,
      last_user_message: lastUserMessage,
      turn_count: body.messages.length,
    },
  });
  if (user_id !== "anon" && lastUserMessage.trim()) {
    await resolveLatestInputGateForSession(user_id, body.session_id, {
      answer_text: lastUserMessage,
    }).catch((err) => {
      console.warn("[/api/chat] mission input gate resolution failed", {
        session_id: body.session_id,
        error: err instanceof Error ? err.message : String(err),
      });
    });
  }

  const stream = new ReadableStream({
    async start(controller) {
      const encoder = new TextEncoder();
      let closed = false;
      // trip_id gets set if the turn produces/consumes a compound trip.
      // Used to tag audit events with the trip so the replay path can
      // rebuild per-trip timelines.
      let activeTripId: string | null = null;

      const send = (frame: unknown) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(frame)}\n\n`));
        } catch {
          // Client disconnected mid-stream. Swallow — nothing to do.
        }
      };

      // Outgoing frames — go to BOTH the SSE stream and the audit log.
      // The audit write is fire-and-forget; it must never block the
      // client from seeing the frame.
      const emit: EmitFrame = (frame: OrchestratorFrame) => {
        send(frame);
        if (frame.type === "summary" && isTripSummaryFrame(frame)) {
          const tid = extractTripIdFromSummary(frame.value);
          if (tid) activeTripId = tid;
        }
        void recordEvent({
          session_id: body.session_id,
          trip_id: activeTripId,
          frame_type: frame.type as EventFrameType,
          frame_value: frame,
        });
      };

      try {
        // ─── Compound-trip confirm turn ──────────────────────────────
        // If the prior turn drafted a TripSummary for this session AND
        // the user just said yes, we bypass the Claude loop and go
        // straight to leg dispatch + Saga.
        const draft = await getTripBySession(body.session_id);
        if (draft && draft.status === "draft" && isAffirmative(lastUserMessage)) {
          activeTripId = draft.trip_id;
          await resolveCardOutcome(draft.hash, "approved").catch((err) => {
            console.warn("[/api/chat] mission card outcome resolution failed", {
              confirmation_card_id: draft.hash,
              outcome: "approved",
              error: err instanceof Error ? err.message : String(err),
            });
          });
          // Promote draft → confirmed. Hash is canonical on the trip
          // record; passing it back is the equality check (payload
          // mutation would change the hash and trip-state would reject).
          await confirmTrip(draft.trip_id, draft.hash);
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
          void recordEvent({
            session_id: body.session_id,
            trip_id: activeTripId,
            frame_type: "done",
            frame_value: { type: "done" },
          });
          return;
        }

        // ─── Normal turn ─────────────────────────────────────────────
        const priorCardHash = findPriorSummaryHash(body.messages);
        const cardOutcome = resolveUserCardOutcome(lastUserMessage);
        if (priorCardHash && cardOutcome) {
          await resolveCardOutcome(priorCardHash, cardOutcome).catch((err) => {
            console.warn("[/api/chat] mission card outcome resolution failed", {
              confirmation_card_id: priorCardHash,
              outcome: cardOutcome,
              error: err instanceof Error ? err.message : String(err),
            });
          });
        }

        const turn = await runTurn(
          {
            session_id: body.session_id,
            user_id,
            // Source-of-truth for the user's first name is the auth
            // metadata, not the client. We split on whitespace so
            // "Alex Rivera" → "Alex" for the system prompt's USER:
            // line. Falls back to null if no full_name exists.
            user_first_name:
              (() => {
                const full =
                  (authedUser?.user_metadata as { full_name?: string } | null)
                    ?.full_name ?? null;
                if (!full) return null;
                const first = full.trim().split(/\s+/)[0];
                return first && first.length > 0 ? first : null;
              })(),
            user_region,
            device_kind,
            messages: body.messages,
            user_pii,
            mode: body.mode === "voice" ? "voice" : "text",
            ambient: body.ambient
              ? {
                  local_time: body.ambient.local_time,
                  timezone: body.ambient.timezone,
                  coords: body.ambient.coords,
                  location_label: body.ambient.location_label,
                  device_kind,
                }
              : { device_kind },
          },
          emit,
        );
        if (turn.draft_trip_id) activeTripId = turn.draft_trip_id;

        send({ type: "done" });
        void recordEvent({
          session_id: body.session_id,
          trip_id: activeTripId,
          frame_type: "done",
          frame_value: { type: "done" },
        });
      } catch (err) {
        console.error("[/api/chat] error:", err);
        const message = err instanceof Error ? err.message : String(err);
        send({ type: "error", value: { message } });
        void recordEvent({
          session_id: body.session_id,
          trip_id: activeTripId,
          frame_type: "error",
          frame_value: { type: "error", value: { message } },
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

// Narrow `OrchestratorFrame` → "summary whose payload is a trip". The
// orchestrator emits exactly one summary per turn; if it's a
// structured-trip we use the payload's trip_id (if present) to tag
// every subsequent leg_status/text/done frame for replay.
function isTripSummaryFrame(
  frame: OrchestratorFrame,
): frame is Extract<OrchestratorFrame, { type: "summary" }> {
  return frame.type === "summary";
}

function extractTripIdFromSummary(summary: unknown): string | null {
  if (
    summary &&
    typeof summary === "object" &&
    "kind" in summary &&
    (summary as { kind?: string }).kind === "structured-trip"
  ) {
    const payload = (summary as { payload?: unknown }).payload;
    if (
      payload &&
      typeof payload === "object" &&
      "trip_id" in payload &&
      typeof (payload as { trip_id?: unknown }).trip_id === "string"
    ) {
      return (payload as { trip_id: string }).trip_id;
    }
  }
  return null;
}

function findPriorSummaryHash(messages: ChatMessage[]): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg?.role !== "assistant") continue;
    const hash = msg.summary?.hash;
    if (typeof hash === "string" && hash.trim()) return hash.trim();
  }
  return null;
}

function resolveUserCardOutcome(
  text: string,
): "approved" | "dismissed" | null {
  if (isAffirmative(text)) return "approved";
  if (
    /^\s*(cancel|no|nope|don't|do not|stop|skip|dismiss|never mind|nevermind)\b/i
      .test(text)
  ) {
    return "dismissed";
  }
  return null;
}
