import { type NextRequest, NextResponse } from "next/server";
import { requireServerUser } from "@/lib/auth";
import { isAdmin } from "@/lib/publisher/access";
import { initiateMissionRollback } from "@/lib/mission-rollback";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest, context: { params: { id: string } }) {
  const user = await requireServerUser();
  if (!isAdmin(user.email ?? null)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const reason = await readReason(req);
  const result = await initiateMissionRollback({
    mission_id: context.params.id,
    trigger: "admin",
    reason: reason ?? "admin_force",
    actor_user_id: user.id,
    force: true,
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
