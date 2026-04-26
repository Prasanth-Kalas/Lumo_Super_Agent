/**
 * GET /api/history/sessions/[session_id]/messages
 *
 * Replays the current user's stored chat messages for a session.
 * The events table is append-only and does not have a top-level
 * user_id column, so ownership is checked against the inbound
 * `request` events whose frame_value carries user_id. Sessions with
 * no durable events return an empty list for local/dev resilience;
 * sessions with events that belong to another user return 404.
 */

import { NextRequest } from "next/server";
import { getServerUser } from "@/lib/auth";
import { readSessionEvents } from "@/lib/events";
import {
  replayEventsToMessages,
  sessionEventsBelongToUser,
} from "@/lib/history-replay";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  req: NextRequest,
  { params }: { params: { session_id: string } },
): Promise<Response> {
  const session_id = params.session_id;
  if (!/^[0-9a-fA-F-]{8,}$/.test(session_id)) {
    return json({ error: "invalid_session_id" }, 400);
  }

  const authed = await getServerUser();
  const user_id =
    authed?.id ?? req.headers.get("x-lumo-user-id") ?? "dev-user";

  const events = await readSessionEvents(session_id);
  if (events.length > 0 && !sessionEventsBelongToUser(events, user_id)) {
    return json({ error: "not_found" }, 404);
  }

  return json(
    {
      session_id,
      messages: replayEventsToMessages(events),
    },
    200,
  );
}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
    },
  });
}
