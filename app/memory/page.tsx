"use client";

/**
 * /memory — the user's view into what Lumo has learned about them.
 *
 * Three sections:
 *   1. Profile: structured fields (home, work, dietary, travel prefs).
 *      Inline-editable with a single PATCH on blur/save.
 *   2. Facts: free-text memories grouped by category. Each row has a
 *      "Forget" action that soft-deletes (recoverable 30d).
 *   3. Patterns: read-only. These are derived by the nightly pattern
 *      detector (coming in J3) — shown here so the user understands
 *      what inference Lumo is doing.
 *
 * Middleware gates access; this page assumes an authenticated user.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { BrandMark } from "@/components/BrandMark";
import { ThemeToggle } from "@/components/ThemeToggle";

interface UserProfile {
  id: string;
  display_name: string | null;
  timezone: string | null;
  preferred_language: string | null;
  home_address: AddressPayload | null;
  work_address: AddressPayload | null;
  dietary_flags: string[];
  allergies: string[];
  preferred_cuisines: string[];
  preferred_airline_class: string | null;
  preferred_airline_seat: string | null;
  preferred_hotel_chains: string[];
  budget_tier: string | null;
  preferred_payment_hint: string | null;
}

interface AddressPayload {
  label?: string;
  line1?: string;
  city?: string;
  region?: string;
  country?: string;
  coords?: { lat: number; lng: number };
}

interface UserFact {
  id: string;
  fact: string;
  category: string;
  source: string;
  confidence: number;
  first_seen_at: string;
  last_confirmed_at: string;
}

interface BehaviorPattern {
  id: string;
  pattern_kind: string;
  description: string;
  evidence_count: number;
  confidence: number;
  last_observed_at: string;
}

const CATEGORY_LABELS: Record<string, string> = {
  preference: "Preferences",
  identity: "About you",
  habit: "Habits",
  location: "Places",
  constraint: "Dietary & accessibility",
  context: "Current context",
  milestone: "Dates & milestones",
  other: "Other",
};

export default function MemoryPage() {
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [facts, setFacts] = useState<UserFact[]>([]);
  const [patterns, setPatterns] = useState<BehaviorPattern[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/memory", { cache: "no-store" });
      if (!res.ok) {
        setError("Couldn't load your memory.");
        return;
      }
      const data = (await res.json()) as {
        profile: UserProfile | null;
        facts: UserFact[];
        patterns: BehaviorPattern[];
      };
      setProfile(data.profile);
      setFacts(data.facts);
      setPatterns(data.patterns);
      setError(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const factsByCategory = useMemo(() => {
    const buckets: Record<string, UserFact[]> = {};
    for (const f of facts) {
      (buckets[f.category] ??= []).push(f);
    }
    return buckets;
  }, [facts]);

  async function forgetFact(id: string) {
    if (!window.confirm("Forget this? You can't undo from the UI (yet).")) return;
    const res = await fetch(`/api/memory/facts/${id}`, { method: "DELETE" });
    if (res.ok) {
      setFacts((prev) => prev.filter((f) => f.id !== id));
    }
  }

  async function updateProfile(patch: Partial<UserProfile>) {
    const res = await fetch("/api/memory/profile", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(patch),
    });
    if (res.ok) {
      const data = (await res.json()) as { profile: UserProfile };
      setProfile(data.profile);
    }
  }

  return (
    <main className="min-h-dvh bg-lumo-bg text-lumo-fg-high">
      <header className="sticky top-0 z-20 border-b border-lumo-hair bg-lumo-bg/80 backdrop-blur-md">
        <div className="mx-auto flex w-full max-w-3xl items-center justify-between px-5 py-3">
          <div className="flex items-center gap-3">
            <Link href="/" className="flex items-center gap-2.5 hover:text-lumo-accent transition-colors">
              <BrandMark size={22} className="text-lumo-fg" />
              <span className="text-[14px] font-semibold tracking-tight text-lumo-fg">Lumo</span>
            </Link>
            <span className="text-lumo-fg-low text-[12px]">/</span>
            <span className="text-[13px] text-lumo-fg">What Lumo knows</span>
          </div>
          <div className="flex items-center gap-1.5">
            <Link
              href="/connections"
              className="h-7 px-2.5 rounded-md inline-flex items-center text-[12px] text-lumo-fg-mid hover:text-lumo-fg hover:bg-lumo-elevated transition-colors"
            >
              Connections
            </Link>
            <ThemeToggle />
          </div>
        </div>
      </header>

      <div className="mx-auto w-full max-w-3xl px-5 py-8 space-y-8">
        <div className="space-y-2">
          <h1 className="text-[26px] font-semibold tracking-[-0.022em] text-lumo-fg">
            What Lumo knows about you
          </h1>
          <p className="text-[13.5px] text-lumo-fg-mid">
            Lumo learns as you chat so it doesn&apos;t have to ask the same questions twice.
            You control all of it — edit, forget, or wipe.
          </p>
        </div>

        {error ? (
          <div className="rounded-md border border-red-500/30 bg-red-500/5 px-3 py-2 text-[12.5px] text-red-500">
            {error}
          </div>
        ) : null}

        {loading ? (
          <div className="text-[13px] text-lumo-fg-mid">Loading…</div>
        ) : (
          <>
            {/* ─── Profile ────────────────────────────────────────────── */}
            <section className="space-y-3">
              <h2 className="text-[16px] font-semibold text-lumo-fg">Profile</h2>
              <ProfileEditor profile={profile} onChange={updateProfile} />
            </section>

            {/* ─── Facts ──────────────────────────────────────────────── */}
            <section className="space-y-4">
              <div className="flex items-baseline justify-between">
                <h2 className="text-[16px] font-semibold text-lumo-fg">What Lumo remembers</h2>
                <span className="text-[11.5px] text-lumo-fg-low">
                  {facts.length} fact{facts.length === 1 ? "" : "s"}
                </span>
              </div>

              {facts.length === 0 ? (
                <p className="text-[12.5px] text-lumo-fg-mid">
                  Nothing yet. As you chat, Lumo will save the things worth remembering and show them here.
                </p>
              ) : (
                Object.entries(factsByCategory)
                  .sort(([a], [b]) => a.localeCompare(b))
                  .map(([cat, catFacts]) => (
                    <div key={cat} className="space-y-1.5">
                      <div className="text-[11px] uppercase tracking-[0.12em] text-lumo-fg-low">
                        {CATEGORY_LABELS[cat] ?? cat}
                      </div>
                      <ul className="divide-y divide-lumo-hair border-y border-lumo-hair">
                        {catFacts.map((f) => (
                          <li key={f.id} className="py-2.5 flex items-start gap-3">
                            <span className="flex-1 text-[13px] text-lumo-fg-high">{f.fact}</span>
                            <button
                              type="button"
                              onClick={() => void forgetFact(f.id)}
                              className="shrink-0 h-6 px-2 rounded-md border border-lumo-hair text-[11px] text-lumo-fg-mid hover:text-lumo-fg hover:border-lumo-edge transition-colors"
                              aria-label="Forget this"
                            >
                              Forget
                            </button>
                          </li>
                        ))}
                      </ul>
                    </div>
                  ))
              )}
            </section>

            {/* ─── Patterns ───────────────────────────────────────────── */}
            {patterns.length > 0 ? (
              <section className="space-y-3">
                <h2 className="text-[16px] font-semibold text-lumo-fg">Observed patterns</h2>
                <ul className="space-y-1.5">
                  {patterns.map((p) => (
                    <li
                      key={p.id}
                      className="flex items-center justify-between text-[12.5px] text-lumo-fg-high border-b border-lumo-hair pb-2"
                    >
                      <span>{p.description}</span>
                      <span className="text-[11px] text-lumo-fg-low">
                        seen {p.evidence_count}×
                      </span>
                    </li>
                  ))}
                </ul>
              </section>
            ) : null}

            <div className="pt-4 border-t border-lumo-hair text-[11.5px] text-lumo-fg-low">
              Soft-deleted facts are recoverable for 30 days. To permanently erase
              everything Lumo knows about you, email support.
            </div>
          </>
        )}
      </div>
    </main>
  );
}

// ──────────────────────────────────────────────────────────────────────────
// Profile editor — minimal, inline
// ──────────────────────────────────────────────────────────────────────────

function ProfileEditor({
  profile,
  onChange,
}: {
  profile: UserProfile | null;
  onChange: (patch: Partial<UserProfile>) => Promise<void>;
}) {
  if (!profile) {
    return (
      <p className="text-[12.5px] text-lumo-fg-mid">
        No profile yet — as you chat, Lumo will fill this in.
      </p>
    );
  }
  return (
    <div className="rounded-xl border border-lumo-hair bg-lumo-surface p-4 space-y-3">
      <Row label="Name">
        <TextField
          value={profile.display_name ?? ""}
          onCommit={(v) => onChange({ display_name: v || null })}
          placeholder="Alex Rivera"
        />
      </Row>
      <Row label="Timezone">
        <TextField
          value={profile.timezone ?? ""}
          onCommit={(v) => onChange({ timezone: v || null })}
          placeholder="America/Los_Angeles"
        />
      </Row>
      <Row label="Home">
        <TextField
          value={addrToLine(profile.home_address)}
          onCommit={(v) => onChange({ home_address: v ? { line1: v } : null })}
          placeholder="1 Market St, San Francisco"
        />
      </Row>
      <Row label="Dietary">
        <TagsField
          value={profile.dietary_flags}
          onCommit={(v) => onChange({ dietary_flags: v })}
          placeholder="vegetarian, gluten_free"
        />
      </Row>
      <Row label="Allergies">
        <TagsField
          value={profile.allergies}
          onCommit={(v) => onChange({ allergies: v })}
          placeholder="shellfish, peanuts"
        />
      </Row>
      <Row label="Airline class">
        <TextField
          value={profile.preferred_airline_class ?? ""}
          onCommit={(v) => onChange({ preferred_airline_class: v || null })}
          placeholder="economy | business | first"
        />
      </Row>
      <Row label="Seat">
        <TextField
          value={profile.preferred_airline_seat ?? ""}
          onCommit={(v) => onChange({ preferred_airline_seat: v || null })}
          placeholder="aisle | window | any"
        />
      </Row>
      <Row label="Budget">
        <TextField
          value={profile.budget_tier ?? ""}
          onCommit={(v) => onChange({ budget_tier: v || null })}
          placeholder="budget | standard | premium"
        />
      </Row>
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[120px_1fr] gap-3 items-center">
      <span className="text-[11px] uppercase tracking-[0.12em] text-lumo-fg-low">
        {label}
      </span>
      {children}
    </div>
  );
}

function TextField({
  value,
  onCommit,
  placeholder,
}: {
  value: string;
  onCommit: (v: string) => void;
  placeholder?: string;
}) {
  const [local, setLocal] = useState(value);
  useEffect(() => setLocal(value), [value]);
  return (
    <input
      type="text"
      value={local}
      placeholder={placeholder}
      onChange={(e) => setLocal(e.target.value)}
      onBlur={() => {
        if (local !== value) onCommit(local);
      }}
      className="block w-full rounded-md border border-lumo-hair bg-lumo-bg px-3 py-1.5 text-[13px] text-lumo-fg placeholder:text-lumo-fg-low focus:border-lumo-edge outline-none"
    />
  );
}

function TagsField({
  value,
  onCommit,
  placeholder,
}: {
  value: string[];
  onCommit: (v: string[]) => void;
  placeholder?: string;
}) {
  const [local, setLocal] = useState(value.join(", "));
  useEffect(() => setLocal(value.join(", ")), [value]);
  return (
    <input
      type="text"
      value={local}
      placeholder={placeholder}
      onChange={(e) => setLocal(e.target.value)}
      onBlur={() => {
        const tags = local
          .split(",")
          .map((s) => s.trim().toLowerCase())
          .filter(Boolean);
        if (JSON.stringify(tags) !== JSON.stringify(value)) onCommit(tags);
      }}
      className="block w-full rounded-md border border-lumo-hair bg-lumo-bg px-3 py-1.5 text-[13px] text-lumo-fg placeholder:text-lumo-fg-low focus:border-lumo-edge outline-none"
    />
  );
}

function addrToLine(a: AddressPayload | null): string {
  if (!a) return "";
  if (a.line1) {
    const parts = [a.line1, a.city, a.region, a.country].filter(Boolean);
    return parts.join(", ");
  }
  if (a.coords) return `${a.coords.lat.toFixed(3)}, ${a.coords.lng.toFixed(3)}`;
  return "";
}
