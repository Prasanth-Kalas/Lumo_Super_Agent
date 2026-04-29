import { getServerUser } from "@/lib/auth";
import { getSupabase } from "@/lib/db";
import { isAdmin } from "@/lib/publisher/access";

export const dynamic = "force-dynamic";

export default async function TrustDecisionsPage() {
  const user = await getServerUser();
  if (!isAdmin(user?.email)) {
    return (
      <div className="rounded-lg border border-red-500/30 bg-red-500/5 p-4 text-[13px] text-red-300">
        Admin access is required.
      </div>
    );
  }
  const db = getSupabase();
  const decisions = db
    ? ((await db
        .from("agent_review_decisions")
        .select("*")
        .order("decided_at", { ascending: false })
        .limit(100)).data ?? [])
    : [];

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-[24px] font-semibold">Trust decisions</h1>
        <p className="mt-1 text-[13px] text-lumo-fg-mid">Append-only review history.</p>
      </div>
      <div className="space-y-2">
        {decisions.length === 0 ? (
          <div className="rounded-lg border border-dashed border-lumo-hair bg-lumo-surface/40 p-8 text-center text-[13px] text-lumo-fg-mid">
            No decisions recorded.
          </div>
        ) : decisions.map((decision: Record<string, unknown>) => (
          <div key={String(decision.id)} className="rounded-lg border border-lumo-hair bg-lumo-surface p-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="text-[13px] text-lumo-fg">{String(decision.outcome)}</div>
              <div className="text-[11.5px] text-lumo-fg-low">{String(decision.decided_at)}</div>
            </div>
            <div className="mt-2 text-[12px] text-lumo-fg-mid">
              {Array.isArray(decision.reason_codes) ? decision.reason_codes.join(", ") : "approved"}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
