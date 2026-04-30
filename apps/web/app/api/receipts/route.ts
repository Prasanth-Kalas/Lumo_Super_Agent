/**
 * GET /api/receipts
 *
 * Real reader against MERCHANT-1's transactions table.
 * Middleware gates this route.
 *
 * Response: { transactions: TransactionRow[] }
 */

import type { NextRequest } from "next/server";
import { requireServerUser } from "@/lib/auth";
import { listForUser } from "@/lib/transactions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest): Promise<Response> {
  const user = await requireServerUser();
  const { searchParams } = new URL(req.url);
  const limit = clampInt(searchParams.get("limit"), 50, 1, 200);
  const transactions = await listForUser(user.id, limit);
  return new Response(JSON.stringify({ transactions }), {
    status: 200,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
    },
  });
}

function clampInt(raw: string | null, def: number, min: number, max: number): number {
  const n = Number(raw ?? def);
  if (!Number.isFinite(n)) return def;
  return Math.max(min, Math.min(max, Math.floor(n)));
}
