import { type NextRequest, NextResponse } from "next/server";
import { AuthError, requireServerUser } from "@/lib/auth";
import { getSupabase } from "@/lib/db";
import { invalidateCachedProactiveMoments } from "@/lib/proactive-moments-cache";
import { normalizeMomentActionBody } from "@/lib/proactive-moments-core";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function PATCH(
  req: NextRequest,
  { params }: { params: { id: string } },
) {
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

  const id = params.id;
  if (!id) return NextResponse.json({ error: "missing_moment_id" }, { status: 400 });

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  const status = normalizeMomentActionBody(body);
  if (!status) return NextResponse.json({ error: "invalid_status" }, { status: 400 });

  const db = getSupabase();
  if (!db) {
    return NextResponse.json({ error: "persistence_disabled" }, { status: 503 });
  }

  const update: Record<string, string> = { status };
  if (status === "acted_on") update.acted_on_at = new Date().toISOString();

  const { data, error } = await db
    .from("proactive_moments")
    .update(update)
    .eq("id", id)
    .eq("user_id", user_id)
    .in("status", ["pending", "surfaced"])
    .select("id, status")
    .maybeSingle();

  if (error) {
    console.error("[proactive-moments] update failed", error);
    return NextResponse.json({ error: "proactive_moment_update_failed" }, { status: 500 });
  }
  if (!data?.id) return NextResponse.json({ error: "not_found" }, { status: 404 });

  invalidateCachedProactiveMoments(user_id);
  return NextResponse.json({ ok: true, id: data.id, status: data.status });
}
