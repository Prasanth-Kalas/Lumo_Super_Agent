import Link from "next/link";
import { getServerUser } from "@/lib/auth";
import { isAdmin } from "@/lib/publisher/access";
import { listReviewQueue } from "@/lib/trust/queue";

export const dynamic = "force-dynamic";

export default async function TrustQueuePage() {
  const user = await getServerUser();
  if (!isAdmin(user?.email)) return <Forbidden />;
  const queue = await listReviewQueue().catch(() => []);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-[24px] font-semibold">Trust queue</h1>
          <p className="mt-1 text-[13px] text-lumo-fg-mid">
            Submission, promotion, identity, and demotion reviews ordered by SLA.
          </p>
        </div>
        <Link href="/admin/trust/decisions" className="text-[12.5px] text-lumo-accent hover:underline">
          Decision history
        </Link>
      </div>

      {queue.length === 0 ? (
        <div className="rounded-lg border border-dashed border-lumo-hair bg-lumo-surface/40 p-8 text-center text-[13px] text-lumo-fg-mid">
          No trust reviews waiting.
        </div>
      ) : (
        <div className="overflow-hidden rounded-lg border border-lumo-hair bg-lumo-surface">
          <table className="w-full text-left text-[12.5px]">
            <thead className="border-b border-lumo-hair text-lumo-fg-low">
              <tr>
                <th className="px-3 py-2 font-medium">Type</th>
                <th className="px-3 py-2 font-medium">Agent</th>
                <th className="px-3 py-2 font-medium">Tier</th>
                <th className="px-3 py-2 font-medium">SLA</th>
                <th className="px-3 py-2 font-medium">State</th>
              </tr>
            </thead>
            <tbody>
              {queue.map((item) => (
                <tr key={item.id} className="border-b border-lumo-hair last:border-b-0">
                  <td className="px-3 py-2">{item.request_type}</td>
                  <td className="px-3 py-2">
                    <Link href={`/admin/trust/review/${item.id}`} className="text-lumo-accent hover:underline">
                      {item.agent_id ?? item.identity_user_id ?? "identity"}
                    </Link>
                    {item.agent_version ? <span className="text-lumo-fg-low"> · {item.agent_version}</span> : null}
                  </td>
                  <td className="px-3 py-2">{item.target_tier ?? "n/a"}</td>
                  <td className="px-3 py-2 num">{formatDate(item.sla_due_at)}</td>
                  <td className="px-3 py-2"><StatusPill value={item.state} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function Forbidden() {
  return (
    <div className="rounded-lg border border-red-500/30 bg-red-500/5 p-4 text-[13px] text-red-300">
      Admin access is required.
    </div>
  );
}

function StatusPill({ value }: { value: string }) {
  return (
    <span className="rounded-full bg-lumo-bg px-2 py-1 text-[11px] text-lumo-fg-mid">
      {value}
    </span>
  );
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(value));
}
