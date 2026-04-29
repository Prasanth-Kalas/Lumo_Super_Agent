import type { NextRequest } from "next/server";
import { getSupabase } from "@/lib/db";
import { json, requireAdminUser } from "../_shared";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_req: NextRequest): Promise<Response> {
  const auth = await requireAdminUser();
  if (!auth.ok) return auth.response;
  const db = getSupabase();
  if (!db) return json({ decisions: [] });
  const { data, error } = await db
    .from("agent_review_decisions")
    .select("*")
    .order("decided_at", { ascending: false })
    .limit(100);
  if (error) return json({ error: error.message }, 500);
  return json({ decisions: data ?? [] });
}
