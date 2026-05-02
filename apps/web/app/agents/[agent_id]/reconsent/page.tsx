"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { LumoWordmark } from "@/components/BrandMark";
import { ThemeToggle } from "@/components/ThemeToggle";

interface ScopeRow {
  scope: string;
  label: string;
  description: string;
  category: "read" | "write" | "financial" | "other";
  defaultConstraints: Record<string, unknown>;
  requiresConfirmation: boolean;
}

interface ReconsentPlan {
  agent: {
    agent_id: string;
    display_name: string;
    one_liner: string;
    version: string;
  };
  installed_version: string;
  pinned_version: string | null;
  requires_reconsent: boolean;
  current_scopes: ScopeRow[];
  added_scopes: ScopeRow[];
  removed_scopes: Array<{ scope: string }>;
  unchanged_scopes: ScopeRow[];
  consent_text_hash: string;
}

export default function AgentReconsentPage() {
  const params = useParams();
  const router = useRouter();
  const agentId = String(params?.agent_id ?? "");
  const [plan, setPlan] = useState<ReconsentPlan | null>(null);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState<"approve" | "pin" | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      setLoading(true);
      setError(null);
      try {
        const res = await fetch(`/api/agents/${encodeURIComponent(agentId)}/reconsent`, {
          cache: "no-store",
        });
        const body = await res.json().catch(() => null);
        if (!alive) return;
        if (!res.ok || !isReconsentPlan(body)) {
          throw new Error(errorMessage(body) ?? `HTTP ${res.status}`);
        }
        setPlan(body);
      } catch (err) {
        if (alive) setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, [agentId]);

  const approve = useCallback(async () => {
    if (!plan || submitting) return;
    setSubmitting("approve");
    setError(null);
    try {
      const res = await fetch(`/api/agents/${encodeURIComponent(plan.agent.agent_id)}/reconsent`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action: "approve",
          consent_text_hash: plan.consent_text_hash,
          granted_scopes: plan.current_scopes.map((scope) => ({
            scope: scope.scope,
            constraints: scope.defaultConstraints,
            expires_at: null,
          })),
        }),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) throw new Error(errorMessage(body) ?? `HTTP ${res.status}`);
      router.push(`/marketplace/${encodeURIComponent(plan.agent.agent_id)}?reconsented=1`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(null);
    }
  }, [plan, router, submitting]);

  const pinPrevious = useCallback(async () => {
    if (!plan || submitting) return;
    setSubmitting("pin");
    setError(null);
    try {
      const res = await fetch(`/api/agents/${encodeURIComponent(plan.agent.agent_id)}/reconsent`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "pin_previous" }),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) throw new Error(errorMessage(body) ?? `HTTP ${res.status}`);
      router.push(`/marketplace/${encodeURIComponent(plan.agent.agent_id)}?pinned=1`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(null);
    }
  }, [plan, router, submitting]);

  if (loading) {
    return (
      <main className="min-h-dvh bg-lumo-bg text-lumo-fg-mid flex items-center justify-center">
        Checking agent permissions...
      </main>
    );
  }

  if (!plan) {
    return (
      <main className="min-h-dvh bg-lumo-bg text-lumo-fg-mid flex items-center justify-center px-6">
        {error ?? "Unable to load re-consent plan."}
      </main>
    );
  }

  return (
    <main className="min-h-dvh bg-lumo-bg text-lumo-fg-high">
      <header className="sticky top-0 z-20 border-b border-lumo-hair bg-lumo-bg/85 backdrop-blur-md">
        <div className="mx-auto flex w-full max-w-4xl items-center justify-between px-5 py-3">
          <Link href={`/marketplace/${plan.agent.agent_id}`} className="flex items-center gap-3">
            <LumoWordmark height={22} />
            <span className="text-[12px] text-lumo-fg-low">Re-consent</span>
          </Link>
          <ThemeToggle />
        </div>
      </header>

      <div className="mx-auto w-full max-w-4xl px-5 py-8">
        <section className="space-y-4">
          <p className="text-[11px] uppercase tracking-[0.14em] text-lumo-fg-low">
            Agent update
          </p>
          <h1 className="text-[28px] font-semibold tracking-tight text-lumo-fg">
            Review {plan.agent.display_name}
          </h1>
          <p className="max-w-2xl text-[14px] leading-relaxed text-lumo-fg-mid">
            Installed version {plan.installed_version || "unknown"} is being compared with version{" "}
            {plan.agent.version}. Approve the current permission contract to keep using this agent.
          </p>
        </section>

        <div className="mt-8 grid grid-cols-1 gap-4 md:grid-cols-2">
          <ScopeList title="Added permissions" empty="No new permissions." rows={plan.added_scopes} />
          <RemovedScopeList rows={plan.removed_scopes} />
        </div>

        <section className="mt-6 rounded-lg border border-lumo-hair bg-lumo-surface p-4">
          <h2 className="text-[14px] font-semibold text-lumo-fg">Current permissions</h2>
          <div className="mt-3 space-y-2">
            {plan.current_scopes.length === 0 ? (
              <p className="text-[13px] text-lumo-fg-mid">This agent declares no data scopes.</p>
            ) : (
              plan.current_scopes.map((scope) => (
                <div key={scope.scope} className="rounded-md border border-lumo-hair bg-lumo-bg px-3 py-2">
                  <div className="text-[13px] font-medium text-lumo-fg">{scope.label}</div>
                  <div className="text-[12px] text-lumo-fg-mid">{scope.description}</div>
                </div>
              ))
            )}
          </div>
        </section>

        {error ? (
          <div className="mt-5 rounded-md border border-lumo-err/30 bg-lumo-err/10 px-3 py-2 text-[12px] text-lumo-err">
            {error}
          </div>
        ) : null}

        <div className="mt-6 flex flex-col gap-3 sm:flex-row">
          <button
            type="button"
            onClick={() => void approve()}
            disabled={submitting !== null}
            className="h-10 rounded-md bg-lumo-fg px-5 text-[13px] font-medium text-lumo-bg transition-colors hover:bg-lumo-accent hover:text-lumo-accent-ink disabled:opacity-50"
          >
            {submitting === "approve" ? "Approving..." : "Approve current permissions"}
          </button>
          <button
            type="button"
            onClick={() => void pinPrevious()}
            disabled={submitting !== null || !plan.installed_version}
            className="h-10 rounded-md border border-lumo-hair px-5 text-[13px] text-lumo-fg-mid transition-colors hover:border-lumo-edge hover:text-lumo-fg disabled:opacity-50"
          >
            {submitting === "pin" ? "Saving..." : "Stay on previous version"}
          </button>
        </div>
      </div>
    </main>
  );
}

function ScopeList({
  title,
  empty,
  rows,
}: {
  title: string;
  empty: string;
  rows: ScopeRow[];
}) {
  return (
    <section className="rounded-lg border border-lumo-hair bg-lumo-surface p-4">
      <h2 className="text-[14px] font-semibold text-lumo-fg">{title}</h2>
      <div className="mt-3 space-y-2">
        {rows.length === 0 ? (
          <p className="text-[12.5px] text-lumo-fg-low">{empty}</p>
        ) : (
          rows.map((scope) => (
            <div key={scope.scope} className="text-[12.5px] text-lumo-fg-mid">
              <span className="font-medium text-lumo-fg">{scope.label}</span>
              <span className="block break-all font-mono text-[10.5px] text-lumo-fg-low">
                {scope.scope}
              </span>
            </div>
          ))
        )}
      </div>
    </section>
  );
}

function RemovedScopeList({ rows }: { rows: Array<{ scope: string }> }) {
  return (
    <section className="rounded-lg border border-lumo-hair bg-lumo-surface p-4">
      <h2 className="text-[14px] font-semibold text-lumo-fg">Removed permissions</h2>
      <div className="mt-3 space-y-2">
        {rows.length === 0 ? (
          <p className="text-[12.5px] text-lumo-fg-low">No removed permissions.</p>
        ) : (
          rows.map((row) => (
            <div key={row.scope} className="break-all font-mono text-[10.5px] text-lumo-fg-low">
              {row.scope}
            </div>
          ))
        )}
      </div>
    </section>
  );
}

function isReconsentPlan(value: unknown): value is ReconsentPlan {
  return (
    typeof value === "object" &&
    value !== null &&
    "agent" in value &&
    "current_scopes" in value &&
    Array.isArray((value as { current_scopes?: unknown }).current_scopes)
  );
}

function errorMessage(value: unknown): string | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  return typeof record.detail === "string"
    ? record.detail
    : typeof record.error === "string"
      ? record.error
      : null;
}
