"use client";

/**
 * /profile — edit the structured personal-preferences profile that
 * drives proactive suggestions (aisle seat, hotel chains, dietary
 * flags, budget tier, etc.).
 *
 * Reads via GET /api/memory/profile; writes via PATCH on the same
 * route. Empty fields clear the value (PATCH with explicit null).
 *
 * v1 intentionally omits addresses and frequent-flyer-number editors
 * — those need richer widgets than a text input. They're still
 * editable through chat ("save my home address as …"). Future
 * follow-up: PROFILE-RICH-FIELDS-1.
 */

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { LumoWordmark } from "@/components/BrandMark";
import { ThemeToggle } from "@/components/ThemeToggle";
import {
  AIRLINE_CLASS_OPTIONS,
  AIRLINE_SEAT_OPTIONS,
  BUDGET_TIER_OPTIONS,
  buildProfilePatch,
  formatTagList,
  type ProfilePatchInput,
} from "@/lib/web-screens-profile";

interface ProfileShape {
  display_name: string | null;
  timezone: string | null;
  preferred_language: string | null;
  preferred_airline_class: string | null;
  preferred_airline_seat: string | null;
  budget_tier: string | null;
  dietary_flags: string[] | null;
  allergies: string[] | null;
  preferred_cuisines: string[] | null;
  preferred_hotel_chains: string[] | null;
}

function emptyForm(): ProfilePatchInput {
  return {
    display_name: "",
    timezone: "",
    preferred_language: "",
    preferred_airline_class: "",
    preferred_airline_seat: "",
    budget_tier: "",
    dietary_flags: "",
    allergies: "",
    preferred_cuisines: "",
    preferred_hotel_chains: "",
  };
}

function fromProfile(p: ProfileShape | null): ProfilePatchInput {
  if (!p) return emptyForm();
  return {
    display_name: p.display_name ?? "",
    timezone: p.timezone ?? "",
    preferred_language: p.preferred_language ?? "",
    preferred_airline_class: p.preferred_airline_class ?? "",
    preferred_airline_seat: p.preferred_airline_seat ?? "",
    budget_tier: p.budget_tier ?? "",
    dietary_flags: formatTagList(p.dietary_flags),
    allergies: formatTagList(p.allergies),
    preferred_cuisines: formatTagList(p.preferred_cuisines),
    preferred_hotel_chains: formatTagList(p.preferred_hotel_chains),
  };
}

export default function ProfilePage() {
  const [form, setForm] = useState<ProfilePatchInput>(emptyForm());
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedToast, setSavedToast] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/memory/profile", { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json()) as { profile: ProfileShape | null };
      setForm(fromProfile(body.profile));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load profile");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const setField = <K extends keyof ProfilePatchInput>(k: K, v: ProfilePatchInput[K]) =>
    setForm((prev) => ({ ...prev, [k]: v }));

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setError(null);
    setSavedToast(null);
    try {
      const patch = buildProfilePatch(form);
      const res = await fetch("/api/memory/profile", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(patch),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setSavedToast("Saved.");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Save failed");
    } finally {
      setSaving(false);
    }
  };

  return (
    <main className="min-h-dvh bg-lumo-bg text-lumo-fg-high">
      <header className="sticky top-0 z-20 border-b border-lumo-hair bg-lumo-bg/85 backdrop-blur-md">
        <div className="flex w-full items-center justify-between px-6 py-3">
          <div className="flex items-center gap-2.5">
            <LumoWordmark height={22} />
            <span className="hidden sm:inline text-lumo-fg-low text-[12px]">/</span>
            <span className="hidden sm:inline text-[13px] text-lumo-fg">Profile</span>
          </div>
          <ThemeToggle />
        </div>
      </header>

      <div className="mx-auto w-full max-w-4xl px-6 py-12 space-y-10">
        <div className="space-y-3">
          <h1 className="font-display text-[44px] md:text-[64px] leading-[1.0] tracking-[-0.02em] text-lumo-fg">
            Your <span className="italic text-lumo-accent">profile.</span>
          </h1>
          <p className="text-[15px] text-lumo-fg-mid leading-[1.65] max-w-xl">
            Preferences Lumo uses when planning trips, booking food, and
            making proactive suggestions. Everything is optional — fill in
            what you want assistance on. Lists accept comma-separated
            entries.
          </p>
        </div>

        {savedToast ? (
          <div role="status" className="rounded-md border border-lumo-ok/30 bg-lumo-ok/5 px-3 py-2 text-[12.5px] text-lumo-ok">
            {savedToast}
          </div>
        ) : null}
        {error ? (
          <div role="alert" className="rounded-md border border-red-500/30 bg-red-500/5 px-3 py-2 text-[12.5px] text-red-500">
            {error}
          </div>
        ) : null}

        {loading ? (
          <div className="h-64 rounded-xl border border-lumo-hair bg-lumo-surface animate-pulse" />
        ) : (
          <form onSubmit={handleSave} className="space-y-6">
            <Section title="Identity">
              <TextField
                label="Display name"
                value={form.display_name ?? ""}
                onChange={(v) => setField("display_name", v)}
                placeholder="What should Lumo call you?"
              />
              <TextField
                label="Timezone"
                value={form.timezone ?? ""}
                onChange={(v) => setField("timezone", v)}
                placeholder="America/Los_Angeles"
              />
              <TextField
                label="Preferred language"
                value={form.preferred_language ?? ""}
                onChange={(v) => setField("preferred_language", v)}
                placeholder="en-US"
              />
            </Section>

            <Section title="Travel">
              <SelectField
                label="Cabin class"
                value={form.preferred_airline_class ?? ""}
                onChange={(v) => setField("preferred_airline_class", v)}
                options={AIRLINE_CLASS_OPTIONS}
              />
              <SelectField
                label="Seat preference"
                value={form.preferred_airline_seat ?? ""}
                onChange={(v) => setField("preferred_airline_seat", v)}
                options={AIRLINE_SEAT_OPTIONS}
              />
            </Section>

            <Section title="Food & dietary">
              <TextField
                label="Dietary flags"
                value={form.dietary_flags ?? ""}
                onChange={(v) => setField("dietary_flags", v)}
                placeholder="vegetarian, halal"
              />
              <TextField
                label="Allergies"
                value={form.allergies ?? ""}
                onChange={(v) => setField("allergies", v)}
                placeholder="peanut, shellfish"
              />
              <TextField
                label="Preferred cuisines"
                value={form.preferred_cuisines ?? ""}
                onChange={(v) => setField("preferred_cuisines", v)}
                placeholder="japanese, italian"
              />
            </Section>

            <Section title="Stay">
              <TextField
                label="Preferred hotel chains"
                value={form.preferred_hotel_chains ?? ""}
                onChange={(v) => setField("preferred_hotel_chains", v)}
                placeholder="marriott, hyatt"
              />
            </Section>

            <Section title="Budget">
              <SelectField
                label="Default budget tier"
                value={form.budget_tier ?? ""}
                onChange={(v) => setField("budget_tier", v)}
                options={BUDGET_TIER_OPTIONS}
              />
            </Section>

            <div className="flex items-center justify-end gap-2 pt-2">
              <Link
                href="/settings"
                className="h-9 px-3.5 rounded-md text-[12.5px] text-lumo-fg-mid hover:bg-lumo-elevated transition-colors inline-flex items-center"
              >
                Cancel
              </Link>
              <button
                type="submit"
                disabled={saving}
                className="h-9 px-4 rounded-md bg-lumo-fg text-lumo-bg text-[13px] font-medium hover:bg-lumo-accent hover:text-lumo-accent-ink transition-colors disabled:opacity-50"
              >
                {saving ? "Saving…" : "Save profile"}
              </button>
            </div>
          </form>
        )}
      </div>
    </main>
  );
}

function Section(props: { title: string; children: React.ReactNode }) {
  return (
    <section className="rounded-2xl border border-lumo-hair bg-lumo-surface p-5 sm:p-6 space-y-4">
      <h2 className="font-display text-[24px] tracking-[-0.01em] text-lumo-fg">
        {props.title}.
      </h2>
      <div className="space-y-3">{props.children}</div>
    </section>
  );
}

function TextField(props: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
}) {
  return (
    <label className="block text-[12.5px] text-lumo-fg-mid">
      {props.label}
      <input
        type="text"
        value={props.value}
        onChange={(e) => props.onChange(e.target.value)}
        placeholder={props.placeholder}
        className="mt-1 w-full h-9 px-3 rounded-md border border-lumo-hair bg-lumo-bg text-[13.5px] text-lumo-fg-high focus:outline-none focus:ring-1 focus:ring-lumo-accent"
      />
    </label>
  );
}

function SelectField(props: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: ReadonlyArray<{ value: string; label: string }>;
}) {
  return (
    <label className="block text-[12.5px] text-lumo-fg-mid">
      {props.label}
      <select
        value={props.value}
        onChange={(e) => props.onChange(e.target.value)}
        className="mt-1 w-full h-9 px-2 rounded-md border border-lumo-hair bg-lumo-bg text-[13.5px] text-lumo-fg-high focus:outline-none focus:ring-1 focus:ring-lumo-accent"
      >
        {props.options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );
}
