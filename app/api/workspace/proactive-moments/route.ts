import { type NextRequest, NextResponse } from "next/server";
import { AuthError, requireServerUser } from "@/lib/auth";
import { getSupabase } from "@/lib/db";
import {
  getCachedProactiveMoments,
  setCachedProactiveMoments,
} from "@/lib/proactive-moments-cache";
import {
  normalizeProactiveMomentRows,
  type ProactiveMomentsEnvelope,
} from "@/lib/proactive-moments-core";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_req: NextRequest) {
  let user_id: string;
  try {
    const user = await requireServerUser();
    user_id = user.id;
  } catch (err) {
    if (err instanceof AuthError) {
      return NextResponse.json(
        { error: err.code },
        { status: err.code === "not_authenticated" ? 401 : 403 },
      );
    }
    throw err;
  }

  const cached = getCachedProactiveMoments(user_id);
  if (cached) {
    return NextResponse.json(cached, {
      headers: { "cache-control": "no-store" },
    });
  }

  const db = getSupabase();
  if (!db) {
    const envelope: ProactiveMomentsEnvelope = {
      generated_at: new Date().toISOString(),
      moments: [],
    };
    return NextResponse.json(envelope);
  }

  const { data, error } = await db.rpc("next_proactive_moment_for_user", {
    target_user: user_id,
    requested_limit: 5,
  });
  if (error) {
    console.error("[workspace/proactive-moments] read failed", error);
    return NextResponse.json({ error: "proactive_moments_read_failed" }, { status: 500 });
  }

  const envelope: ProactiveMomentsEnvelope = {
    generated_at: new Date().toISOString(),
    moments: normalizeProactiveMomentRows(data),
  };
  setCachedProactiveMoments(user_id, envelope);
  return NextResponse.json(envelope, {
    headers: { "cache-control": "no-store" },
  });
}
