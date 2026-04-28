import { type NextRequest, NextResponse } from "next/server";
import { getServerUser } from "@/lib/auth";
import { initiateMissionRollback } from "@/lib/mission-rollback";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest, context: { params: { id: string } }) {
  const user = await getServerUser();
  if (!user) return NextResponse.json({ error: "not_authenticated" }, { status: 401 });

  const reason = await readReason(req);
  const result = await initiateMissionRollback({
    mission_id: context.params.id,
    trigger: "user",
    reason: reason ?? "user_cancel",
    actor_user_id: user.id,
    user_id: user.id,
  });
  return NextResponse.json(result, { status: result.ok ? 200 : 409 });
}

async function readReason(req: NextRequest): Promise<string | null> {
  try {
    const body = (await req.json()) as { reason?: unknown };
    return typeof body.reason === "string" && body.reason.trim()
      ? body.reason.trim().slice(0, 200)
      : null;
  } catch {
    return null;
  }
}
