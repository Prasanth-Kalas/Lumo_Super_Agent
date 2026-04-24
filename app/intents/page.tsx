"use client";

/**
 * /intents — user's list of standing routines.
 *
 * Lumo creates these via the intent_create meta-tool when the user says
 * things like "every Friday at 6pm, book me a bike ride." This page
 * surfaces the full list, shows the next fire time, and lets the user
 * pause/delete.
 *
 * Creation from this UI is intentionally minimal in J3 — description +
 * cron string. The richer "schedule builder" (dropdown days, time
 * pickers, weather gates) is a future pass.
 *
 * Middleware gates access.
 */

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { BrandMark } from "@/components/BrandMark";
import { ThemeToggle } from "@/components/ThemeToggle";

interface StandingIntent {
  id: string;
  description: string;
  schedule_cron: string;
  timezone: string;
  enabled: boolean;
  last_fired_at: string | null;
  next_fire_at: string | null;
  created_at: string;
}

export default function IntentsPage() {
  const [intents, setIntents] = useState<StandingIntent[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  const load = useCallback(async () => {
    const res = await fetch("/api/intents", { cache: "no-store" });
    if (!res.ok) {
      setError("Couldn't load your routines.");
      return;
    }
    const data = (await res.json()) as { intents: StandingIntent[] };
    setIntents(data.intents);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function togglePause(intent: StandingIntent) {
    setBusy(intent.id);
    try {
      const res = await fetch(`/api/intents/${intent.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ enabled: !intent.enabled }),
      });
      if (res.ok) await load();
    } finally {
      setBusy(null);
    }
  }

  async function remove(intent: StandingIntent) {
    if (!window.confirm("Delete this routine? This can't be undone from the UI.")) return;
    setBusy(intent.id);
    try {
      const res = await fetch(`/api/intents/${intent.id}`, { method: "DELETE" });
      if (res.ok) setIntents((prev) => (prev ?? []).filter((x) => x.id !== intent.id));
    } finally {
      setBusy(null);
    }
  }

  async function createRoutine(form: FormData) {
    const description = String(form.get("description") ?? "").trim();
    const schedule_cron = String(form.get("schedule_cron") ?? "").trim();
    const timezone =
      String(form.get("timezone") ?? "").trim() ||
      (typeof Intl !== "undefined"
        ? Intl.DateTimeFormat().resolvedOptions().timeZone
        : "UTC");

    const res = await fetch("/api/intents", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ description, schedule_cron, timezone }),
    });
    if (res.ok) {
      setCreating(false);
      await load();
    } else {
      const data = (await res.json().catch(() => null)) as
        | { error?: string; detail?: string }
        | null;
      setError(data?.detail ?? data?.error ?? "Failed to create routine.");
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
            <span className="text-[13px] text-lumo-fg">Routines</span>
          </div>
          <div className="flex items-center gap-1.5">
            <Link
              href="/memory"
              className="h-7 px-2.5 rounded-md inline-flex items-center text-[12px] text-lumo-fg-mid hover:text-lumo-fg hover:bg-lumo-elevated transition-colors"
            >
              Memory
            </Link>
            <ThemeToggle />
          </div>
        </div>
      </header>

      <div className="mx-auto w-full max-w-3xl px-5 py-8 space-y-6">
        <div className="space-y-2">
          <h1 className="text-[26px] font-semibold tracking-[-0.022em] text-lumo-fg">
            Your standing routines
          </h1>
          <p className="text-[13.5px] text-lumo-fg-mid">
            When a routine is due, Lumo sends you a notification to confirm before
            running it. Auto-run without confirmation is coming later.
          </p>
        </div>

        {error ? (
          <div className="rounded-md border border-red-500/30 bg-red-500/5 px-3 py-2 text-[12.5px] text-red-500">
            {error}
          </div>
        ) : null}

        <div className="flex justify-between items-center">
          <span className="text-[11px] uppercase tracking-[0.12em] text-lumo-fg-low">
            {(intents?.length ?? 0)} {intents?.length === 1 ? "routine" : "routines"}
          </span>
          <button
            type="button"
            onClick={() => setCreating((v) => !v)}
            className="h-7 px-3 rounded-md bg-lumo-fg text-lumo-bg text-[12px] font-medium hover:bg-lumo-accent hover:text-lumo-accent-ink transition-colors"
          >
            {creating ? "Cancel" : "New routine"}
          </button>
        </div>

        {creating ? (
          <form
            action={createRoutine}
            className="rounded-xl border border-lumo-hair bg-lumo-surface p-4 space-y-3"
          >
            <label className="block">
              <span className="text-[11px] uppercase tracking-[0.12em] text-lumo-fg-low">
                Description
              </span>
              <input
                name="description"
                type="text"
                required
                minLength={6}
                placeholder="Every Friday at 6pm, book me a bike ride."
                className="mt-1 block w-full rounded-md border border-lumo-hair bg-lumo-bg px-3 py-1.5 text-[13px] text-lumo-fg placeholder:text-lumo-fg-low focus:border-lumo-edge outline-none"
              />
            </label>
            <label className="block">
              <span className="text-[11px] uppercase tracking-[0.12em] text-lumo-fg-low">
                Cron (minute hour dom month dow)
              </span>
              <input
                name="schedule_cron"
                type="text"
                required
                placeholder="0 18 * * 5"
                className="mt-1 block w-full rounded-md border border-lumo-hair bg-lumo-bg px-3 py-1.5 text-[13px] text-lumo-fg placeholder:text-lumo-fg-low focus:border-lumo-edge outline-none font-mono"
              />
              <span className="mt-1 block text-[11px] text-lumo-fg-low">
                Examples: <span className="font-mono">0 18 * * 5</span> = Friday 6pm ·{" "}
                <span className="font-mono">30 9 * * 1,2,3,4,5</span> = 9:30am weekdays
              </span>
            </label>
            <label className="block">
              <span className="text-[11px] uppercase tracking-[0.12em] text-lumo-fg-low">
                Timezone (optional)
              </span>
              <input
                name="timezone"
                type="text"
                placeholder={
                  typeof Intl !== "undefined"
                    ? Intl.DateTimeFormat().resolvedOptions().timeZone
                    : "UTC"
                }
                className="mt-1 block w-full rounded-md border border-lumo-hair bg-lumo-bg px-3 py-1.5 text-[13px] text-lumo-fg placeholder:text-lumo-fg-low focus:border-lumo-edge outline-none"
              />
            </label>
            <div className="pt-1">
              <button
                type="submit"
                className="h-8 px-3 rounded-md bg-lumo-fg text-lumo-bg text-[12.5px] font-medium hover:bg-lumo-accent hover:text-lumo-accent-ink transition-colors"
              >
                Save routine
              </button>
            </div>
          </form>
        ) : null}

        {intents === null ? (
          <div className="text-[13px] text-lumo-fg-mid">Loading…</div>
        ) : intents.length === 0 ? (
          <div className="rounded-xl border border-dashed border-lumo-hair p-8 text-center space-y-2">
            <div className="text-[14px] text-lumo-fg">No routines yet.</div>
            <p className="text-[12.5px] text-lumo-fg-mid max-w-sm mx-auto">
              Tell Lumo things like &ldquo;every Friday at 6pm, book me a bike ride&rdquo; — it&apos;ll
              save the routine and show it here.
            </p>
          </div>
        ) : (
          <ul className="space-y-2">
            {intents.map((i) => (
              <li
                key={i.id}
                className={
                  "rounded-xl border border-lumo-hair bg-lumo-surface p-4 " +
                  (i.enabled ? "" : "opacity-60")
                }
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="flex-1 min-w-0 space-y-1">
                    <div className="text-[14px] text-lumo-fg">{i.description}</div>
                    <div className="text-[11.5px] text-lumo-fg-low font-mono">
                      {i.schedule_cron} · {i.timezone}
                    </div>
                    <div className="text-[11.5px] text-lumo-fg-mid">
                      {i.enabled
                        ? i.next_fire_at
                          ? `Next: ${formatTs(i.next_fire_at)}`
                          : "Next: unscheduled"
                        : "Paused"}
                      {i.last_fired_at ? ` · Last fired ${formatTs(i.last_fired_at)}` : ""}
                    </div>
                  </div>
                  <div className="flex items-center gap-1">
                    <button
                      type="button"
                      onClick={() => void togglePause(i)}
                      disabled={busy === i.id}
                      className="h-7 px-2.5 rounded-md border border-lumo-hair text-[11.5px] text-lumo-fg-mid hover:text-lumo-fg hover:border-lumo-edge transition-colors"
                    >
                      {i.enabled ? "Pause" : "Resume"}
                    </button>
                    <button
                      type="button"
                      onClick={() => void remove(i)}
                      disabled={busy === i.id}
                      className="h-7 px-2.5 rounded-md border border-lumo-hair text-[11.5px] text-lumo-fg-mid hover:text-red-500 hover:border-red-500/40 transition-colors"
                    >
                      Delete
                    </button>
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </main>
  );
}

function formatTs(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleString(undefined, {
      weekday: "short",
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });
  } catch {
    return iso;
  }
}
