/**
 * POST /api/chat — streaming orchestrator endpoint.
 *
 * Body: { session_id, messages: ChatMessage[], device_kind?, region? }
 * Response: text/event-stream (SSE) emitting frames of these types:
 *   - { type: "text",      value: string }
 *   - { type: "tool",      value: ToolCallTrace }             (debug only)
 *   - { type: "selection", value: { kind, payload } }         (rich UI)
 *   - { type: "summary",   value: ConfirmationSummary }       (money gate)
 *   - { type: "error",     value: { message } }
 *   Terminates with { type: "done" }.
 *
 * Auth is stubbed — wire Clerk in a follow-up PR.
 */

import { NextRequest } from "next/server";
import { runTurn, type ChatMessage } from "@/lib/orchestrator";

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
      const send = (frame: unknown) =>
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(frame)}\n\n`));

      try {
        const turn = await runTurn({
          session_id: body.session_id,
          user_id,
          user_first_name: body.user_first_name ?? null,
          user_region,
          device_kind,
          messages: body.messages,
          user_pii,
        });

        // For v0 we return the full assistant text as one frame. Real streaming
        // from Anthropic (messages.stream) is wired in the next PR.
        send({ type: "text", value: turn.assistant_text });
        for (const tc of turn.tool_calls) {
          send({ type: "tool", value: tc });
        }
        for (const s of turn.selections) {
          send({ type: "selection", value: s });
        }
        if (turn.summary) send({ type: "summary", value: turn.summary });
        send({ type: "done" });
      } catch (err) {
        console.error("[/api/chat] error:", err);
        send({
          type: "error",
          value: { message: err instanceof Error ? err.message : String(err) },
        });
      } finally {
        controller.close();
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
