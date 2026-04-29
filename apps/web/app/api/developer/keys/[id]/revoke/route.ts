import type { NextRequest } from "next/server";
import { revokeDeveloperKey } from "@/lib/trust/keys";
import { json, readJson, requireDeveloperUser, stringField } from "../../../_shared";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  req: NextRequest,
  { params }: { params: { id: string } },
): Promise<Response> {
  const auth = await requireDeveloperUser();
  if (!auth.ok) return auth.response;
  const body = await readJson(req);
  if (!body) return json({ error: "invalid_json" }, 400);
  const reason = stringField(body, "reason");
  if (!reason) return json({ error: "missing_reason" }, 400);

  try {
    const result = await revokeDeveloperKey({
      userId: auth.user.id,
      keyId: decodeURIComponent(params.id),
      revokedBy: auth.user.id,
      reason,
    });
    return json({ ok: true, revocation: result });
  } catch (err) {
    return json(
      { error: err instanceof Error ? err.message : "key_revocation_failed" },
      400,
    );
  }
}
