import { type NextRequest, NextResponse } from "next/server";
import { getServerUser } from "@/lib/auth";
import { resolveInputGate } from "@/lib/mission-gate-resolution";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function PATCH(req: NextRequest, context: { params: { id: string } }) {
  const user = await getServerUser();
  if (!user) return NextResponse.json({ error: "not_authenticated" }, { status: 401 });

  const body = await readBody(req);
  if (!body || !isRecord(body.inputs)) {
    return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  }

  const result = await resolveInputGate(context.params.id, body.inputs, user.id);
  return NextResponse.json(result, { status: result.reason === "mission_not_found" ? 404 : 200 });
}

async function readBody(req: NextRequest): Promise<{ inputs?: unknown } | null> {
  try {
    return (await req.json()) as { inputs?: unknown };
  } catch {
    return null;
  }
}

function isRecord(input: unknown): input is Record<string, unknown> {
  return typeof input === "object" && input !== null && !Array.isArray(input);
}
