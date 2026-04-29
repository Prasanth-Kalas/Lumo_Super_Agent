import { getServerUser } from "@/lib/auth";
import { getSupabase } from "@/lib/db";
import { EmptyState, PageHeading, Panel } from "../_components";

export const dynamic = "force-dynamic";

export default async function DeveloperKeysPage() {
  const user = await getServerUser();
  if (!user) {
    return <EmptyState text="Sign in to manage author keys." />;
  }
  const db = getSupabase();
  const keys = db
    ? ((await db
        .from("developer_keys")
        .select("key_id, fingerprint_sha256, algorithm, label, state, registered_at, last_used_at, revoked_at")
        .eq("user_id", user.id)
        .order("registered_at", { ascending: false })).data ?? [])
    : [];

  return (
    <div className="space-y-6">
      <PageHeading
        title="Author keys"
        description="Public signing keys registered by the lumo-agent submit flow. Private keys stay in your OS keychain."
      />
      <Panel title="Registered keys" meta={`${keys.length} total`}>
        {keys.length === 0 ? (
          <EmptyState text="No keys yet. Run lumo-agent sign to create one, then register the printed public key." />
        ) : (
          <div className="space-y-2">
            {keys.map((key: Record<string, unknown>) => (
              <div key={String(key.key_id)} className="rounded-md border border-lumo-hair bg-lumo-bg/60 p-3">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <div className="text-[13px] font-medium text-lumo-fg">{String(key.key_id)}</div>
                    <div className="mt-0.5 text-[11px] text-lumo-fg-low num">{String(key.fingerprint_sha256)}</div>
                  </div>
                  <span className="rounded-full bg-lumo-surface px-2 py-1 text-[11px] text-lumo-fg-mid">
                    {String(key.state)}
                  </span>
                </div>
              </div>
            ))}
          </div>
        )}
      </Panel>
    </div>
  );
}
