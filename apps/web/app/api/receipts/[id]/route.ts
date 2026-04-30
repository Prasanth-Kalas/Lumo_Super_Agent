/**
 * GET /api/receipts/[id]
 *
 * Real reader. Returns one transaction + its legs, scoped to the
 * authed user. 404 if the id isn't owned by the requester.
 */

import { requireServerUser } from "@/lib/auth";
import { getForUser, listLegsFor } from "@/lib/transactions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  _req: Request,
  ctx: { params: { id: string } },
): Promise<Response> {
  const user = await requireServerUser();
  const { id } = ctx.params;
  if (!id) {
    return json({ error: "missing_id" }, 400);
  }
  const tx = await getForUser(user.id, id);
  if (!tx) {
    return json({ error: "receipt_not_found" }, 404);
  }
  const legs = await listLegsFor(tx.id);
  return json({ transaction: tx, legs });
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
    },
  });
}
