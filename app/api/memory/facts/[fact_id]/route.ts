/**
 * DELETE /api/memory/facts/[fact_id]
 *
 * Soft-delete a fact. Recoverable for 30 days (we don't yet have an
 * "undo" surface, but the DB keeps the row).
 */

import type { NextRequest } from "next/server";
import { requireServerUser } from "@/lib/auth";
import { forgetFact } from "@/lib/memory";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function DELETE(
  _req: NextRequest,
  ctx: { params: { fact_id: string } },
): Promise<Response> {
  const user = await requireServerUser();
  const factId = ctx.params.fact_id;
  if (!factId) return json({ error: "missing_fact_id" }, 400);
  try {
    await forgetFact(user.id, factId);
    return json({ ok: true });
  } catch (err) {
    return json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}
