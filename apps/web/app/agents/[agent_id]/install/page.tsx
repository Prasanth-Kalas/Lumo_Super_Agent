"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { LumoWordmark } from "@/components/BrandMark";
import { ThemeToggle } from "@/components/ThemeToggle";

interface PermissionScopeDescriptor {
  scope: string;
  label: string;
  description: string;
  category: "read" | "write" | "financial" | "other";
  defaultConstraints: {
    up_to_per_invocation_usd?: number;
    per_day_usd?: number;
    specific_to?: string;
  };
  requiresConfirmation: boolean;
}

interface ConsentResponse {
  authenticated: boolean;
  agent: {
    agent_id: string;
    display_name: string;
    one_liner: string;
    version: string;
    domain: string;
    connect_model: string;
    requires_payment: boolean;
    listing: {
      category?: string;
      pricing_note?: string;
      privacy_policy_url?: string;
      terms_url?: string;
      homepage_url?: string;
    } | null;
  };
  scopes: PermissionScopeDescriptor[];
  consent_text: string;
  consent_text_hash: string;
  default_expires_at: string | null;
}

type ConstraintDraft = PermissionScopeDescriptor["defaultConstraints"];

export default function AgentInstallPage() {
  const params = useParams();
  const router = useRouter();
  const agentId = String(params?.agent_id ?? "");
  const [data, setData] = useState<ConsentResponse | null>(null);
  const [included, setIncluded] = useState<Record<string, boolean>>({});
  const [constraints, setConstraints] = useState<Record<string, ConstraintDraft>>({});
  const [expiresAt, setExpiresAt] = useState<Record<string, string | null>>({});
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      setLoading(true);
      setError(null);
      try {
        const res = await fetch(`/api/agents/${encodeURIComponent(agentId)}/install`, {
          cache: "no-store",
        });
        const body = (await res.json().catch(() => null)) as unknown;
        if (!alive) return;
        if (!res.ok || !isConsentResponse(body)) {
          throw new Error(errorMessage(body) ?? `HTTP ${res.status}`);
        }
        setData(body);
        setIncluded(Object.fromEntries(body.scopes.map((scope) => [scope.scope, true])));
        setConstraints(
          Object.fromEntries(
            body.scopes.map((scope) => [scope.scope, { ...scope.defaultConstraints }]),
          ),
        );
        setExpiresAt(
          Object.fromEntries(body.scopes.map((scope) => [scope.scope, body.default_expires_at])),
        );
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

  const selectedScopes = useMemo(() => {
    if (!data) return [];
    return data.scopes.filter((scope) => included[scope.scope] !== false);
  }, [data, included]);

  const submit = useCallback(async () => {
    if (!data || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch(`/api/agents/${encodeURIComponent(data.agent.agent_id)}/install`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          agent_version: data.agent.version,
          consent_text_hash: data.consent_text_hash,
          granted_scopes: selectedScopes.map((scope) => ({
            scope: scope.scope,
            constraints: constraints[scope.scope] ?? {},
            expires_at: expiresAt[scope.scope] ?? null,
          })),
        }),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) {
        throw new Error(body?.detail ?? body?.error ?? `HTTP ${res.status}`);
      }
      router.push(`/marketplace/${encodeURIComponent(data.agent.agent_id)}?installed=${encodeURIComponent(data.agent.agent_id)}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  }, [constraints, data, expiresAt, router, selectedScopes, submitting]);

  if (loading) {
    return (
      <main className="min-h-dvh bg-lumo-bg text-lumo-fg-mid flex items-center justify-center">
        Loading permissions...
      </main>
    );
  }

  if (!data) {
    return (
      <main className="min-h-dvh bg-lumo-bg text-lumo-fg-mid flex items-center justify-center px-6">
        {error ?? "Unable to load this agent."}
      </main>
    );
  }

  return (
    <main className="min-h-dvh bg-lumo-bg text-lumo-fg-high">
      <header className="sticky top-0 z-20 border-b border-lumo-hair bg-lumo-bg/85 backdrop-blur-md">
        <div className="mx-auto flex w-full max-w-5xl items-center justify-between px-5 py-3">
          <Link href={`/marketplace/${data.agent.agent_id}`} className="flex items-center gap-3">
            <LumoWordmark height={20} />
            <span className="text-[12px] text-lumo-fg-low">Permission grant</span>
          </Link>
          <ThemeToggle />
        </div>
      </header>

      <div className="mx-auto grid w-full max-w-5xl grid-cols-1 gap-8 px-5 py-8 lg:grid-cols-[1fr_320px]">
        <section className="space-y-6">
          <div className="space-y-2">
            <p className="text-[11px] uppercase tracking-[0.14em] text-lumo-fg-low">
              Install agent
            </p>
            <h1 className="text-[28px] font-semibold tracking-tight text-lumo-fg">
              Allow {data.agent.display_name}
            </h1>
            <p className="max-w-2xl text-[14px] leading-relaxed text-lumo-fg-mid">
              {data.agent.one_liner}
            </p>
          </div>

          {!data.authenticated ? (
            <div className="rounded-md border border-lumo-warn/30 bg-lumo-warn/10 px-4 py-3 text-[13px] text-lumo-fg-mid">
              Sign in before granting permissions.{" "}
              <Link href="/login" className="font-medium text-lumo-fg underline underline-offset-4">
                Go to login
              </Link>
            </div>
          ) : null}

          <div className="space-y-3">
            {data.scopes.length === 0 ? (
              <div className="rounded-lg border border-lumo-hair bg-lumo-surface p-4 text-[13px] text-lumo-fg-mid">
                This agent does not request any data scopes. Installing it only allows Lumo to invoke
                its public tools from chat.
              </div>
            ) : (
              data.scopes.map((scope) => (
                <ScopeGrantRow
                  key={scope.scope}
                  scope={scope}
                  included={included[scope.scope] !== false}
                  constraints={constraints[scope.scope] ?? {}}
                  expiresAt={expiresAt[scope.scope] ?? null}
                  onIncludedChange={(next) =>
                    setIncluded((prev) => ({ ...prev, [scope.scope]: next }))
                  }
                  onConstraintsChange={(next) =>
                    setConstraints((prev) => ({ ...prev, [scope.scope]: next }))
                  }
                  onExpiresAtChange={(next) =>
                    setExpiresAt((prev) => ({ ...prev, [scope.scope]: next }))
                  }
                />
              ))
            )}
          </div>
        </section>

        <aside className="space-y-4">
          <div className="rounded-lg border border-lumo-hair bg-lumo-surface p-4">
            <div className="space-y-2 text-[12.5px] text-lumo-fg-mid">
              <div className="flex items-center justify-between">
                <span>Version</span>
                <span className="text-lumo-fg">v{data.agent.version}</span>
              </div>
              <div className="flex items-center justify-between">
                <span>Scopes selected</span>
                <span className="text-lumo-fg">{selectedScopes.length}</span>
              </div>
              <div className="flex items-center justify-between">
                <span>Money actions</span>
                <span className={data.agent.requires_payment ? "text-lumo-warn" : "text-lumo-fg-low"}>
                  {data.agent.requires_payment ? "Confirmation required" : "None declared"}
                </span>
              </div>
            </div>

            {error ? (
              <div className="mt-4 rounded-md border border-lumo-err/30 bg-lumo-err/10 px-3 py-2 text-[12px] text-lumo-err">
                {error}
              </div>
            ) : null}

            <button
              type="button"
              disabled={!data.authenticated || submitting}
              onClick={() => void submit()}
              className="mt-4 h-10 w-full rounded-md bg-lumo-fg text-[13px] font-medium text-lumo-bg transition-colors hover:bg-lumo-accent hover:text-lumo-accent-ink disabled:cursor-not-allowed disabled:opacity-50"
            >
              {submitting ? "Installing..." : "Install with selected permissions"}
            </button>

            <p className="mt-3 text-[11.5px] leading-relaxed text-lumo-fg-low">
              You can revoke this agent or individual scopes from Settings at any time. Side-effect
              and payment actions still require a separate confirmation card.
            </p>
          </div>

          <div className="rounded-lg border border-lumo-hair bg-lumo-bg p-4 text-[11.5px] leading-relaxed text-lumo-fg-low">
            Consent hash:
            <div className="mt-1 break-all font-mono text-[10.5px] text-lumo-fg-mid">
              {data.consent_text_hash}
            </div>
          </div>
        </aside>
      </div>
    </main>
  );
}

function ScopeGrantRow({
  scope,
  included,
  constraints,
  expiresAt,
  onIncludedChange,
  onConstraintsChange,
  onExpiresAtChange,
}: {
  scope: PermissionScopeDescriptor;
  included: boolean;
  constraints: ConstraintDraft;
  expiresAt: string | null;
  onIncludedChange: (next: boolean) => void;
  onConstraintsChange: (next: ConstraintDraft) => void;
  onExpiresAtChange: (next: string | null) => void;
}) {
  const hasMoneyCap =
    scope.defaultConstraints.up_to_per_invocation_usd !== undefined ||
    scope.defaultConstraints.per_day_usd !== undefined;

  return (
    <div className="rounded-lg border border-lumo-hair bg-lumo-surface p-4">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-[14px] font-semibold text-lumo-fg">{scope.label}</h2>
            <span className={`rounded px-2 py-0.5 text-[10px] uppercase tracking-[0.1em] ${badgeClass(scope.category)}`}>
              {scope.category}
            </span>
            {scope.requiresConfirmation ? (
              <span className="rounded border border-lumo-warn/30 bg-lumo-warn/10 px-2 py-0.5 text-[10px] uppercase tracking-[0.1em] text-lumo-warn">
                confirmation
              </span>
            ) : null}
          </div>
          <p className="mt-1 text-[12.5px] leading-relaxed text-lumo-fg-mid">
            {scope.description}
          </p>
          <p className="mt-1 break-all font-mono text-[10.5px] text-lumo-fg-low">
            {scope.scope}
          </p>
        </div>
        <label className="flex items-center gap-2 text-[12px] text-lumo-fg-mid">
          <input
            type="checkbox"
            checked={included}
            onChange={(event) => onIncludedChange(event.target.checked)}
          />
          Include
        </label>
      </div>

      {included ? (
        <div className="mt-4 grid grid-cols-1 gap-3 md:grid-cols-2">
          {hasMoneyCap ? (
            <>
              {scope.defaultConstraints.up_to_per_invocation_usd !== undefined ? (
                <label className="text-[12px] text-lumo-fg-mid">
                  Per invocation cap
                  <input
                    type="number"
                    min={0}
                    max={scope.defaultConstraints.up_to_per_invocation_usd}
                    step="1"
                    value={constraints.up_to_per_invocation_usd ?? ""}
                    onChange={(event) =>
                      onConstraintsChange({
                        ...constraints,
                        up_to_per_invocation_usd: Number(event.target.value),
                      })
                    }
                    className="mt-1 h-9 w-full rounded-md border border-lumo-hair bg-lumo-bg px-3 text-[13px] text-lumo-fg outline-none focus:border-lumo-accent"
                  />
                </label>
              ) : null}
              {scope.defaultConstraints.per_day_usd !== undefined ? (
                <label className="text-[12px] text-lumo-fg-mid">
                  Daily cap
                  <input
                    type="number"
                    min={0}
                    max={scope.defaultConstraints.per_day_usd}
                    step="1"
                    value={constraints.per_day_usd ?? ""}
                    onChange={(event) =>
                      onConstraintsChange({
                        ...constraints,
                        per_day_usd: Number(event.target.value),
                      })
                    }
                    className="mt-1 h-9 w-full rounded-md border border-lumo-hair bg-lumo-bg px-3 text-[13px] text-lumo-fg outline-none focus:border-lumo-accent"
                  />
                </label>
              ) : null}
            </>
          ) : null}
          <label className="text-[12px] text-lumo-fg-mid">
            Grant duration
            <select
              value={expiresAt ? "time_bound" : "forever"}
              onChange={(event) =>
                onExpiresAtChange(
                  event.target.value === "forever"
                    ? null
                    : new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
                )
              }
              className="mt-1 h-9 w-full rounded-md border border-lumo-hair bg-lumo-bg px-3 text-[13px] text-lumo-fg outline-none focus:border-lumo-accent"
            >
              <option value="time_bound">30 days</option>
              <option value="forever">Forever</option>
            </select>
          </label>
        </div>
      ) : null}
    </div>
  );
}

function badgeClass(category: PermissionScopeDescriptor["category"]): string {
  if (category === "read") return "border border-lumo-ok/30 bg-lumo-ok/10 text-lumo-ok";
  if (category === "write") return "border border-lumo-warn/30 bg-lumo-warn/10 text-lumo-warn";
  if (category === "financial") return "border border-lumo-err/30 bg-lumo-err/10 text-lumo-err";
  return "border border-lumo-hair bg-lumo-bg text-lumo-fg-low";
}

function isConsentResponse(value: unknown): value is ConsentResponse {
  return (
    typeof value === "object" &&
    value !== null &&
    "agent" in value &&
    "scopes" in value &&
    Array.isArray((value as { scopes?: unknown }).scopes) &&
    typeof (value as { consent_text_hash?: unknown }).consent_text_hash === "string"
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
