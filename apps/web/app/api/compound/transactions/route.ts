import { AuthError, requireServerUser } from "@/lib/auth";
import { getSupabase } from "@/lib/db";
import {
  CompoundPersistenceError,
  createCompoundTransaction,
} from "@/lib/compound/persistence";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request): Promise<Response> {
  try {
    const user = await requireServerUser();
    const db = getSupabase();
    if (!db) return json({ error: "persistence_disabled" }, 503);

    let payload: unknown;
    try {
      payload = await req.json();
    } catch {
      return json({ error: "invalid_json" }, 400);
    }

    const result = await createCompoundTransaction({
      db,
      userId: user.id,
      payload,
    });

    return json(
      {
        compound_transaction_id: result.compound_transaction_id,
        status: result.status,
        graph_hash: result.graph_hash,
      },
      result.existing ? 200 : 201,
    );
  } catch (error) {
    return errorResponse(error);
  }
}

function errorResponse(error: unknown): Response {
  if (error instanceof AuthError) {
    return json({ error: error.code }, error.code === "not_authenticated" ? 401 : 403);
  }
  if (error instanceof CompoundPersistenceError) {
    if (error.code === "idempotency_key_conflict") {
      return json(
        {
          error: error.code,
          existing_compound_id: error.details?.existing_compound_id ?? null,
        },
        error.status,
      );
    }
    if (error.code === "cyclic_dependency_graph") {
      return json(
        {
          error: error.code,
          offending_edge: error.details?.offending_edge ?? null,
          cycle: error.details?.cycle ?? null,
        },
        error.status,
      );
    }
    return json({ error: error.code, message: error.message }, error.status);
  }
  console.error("[compound] create failed", error);
  return json({ error: "internal_error" }, 500);
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
