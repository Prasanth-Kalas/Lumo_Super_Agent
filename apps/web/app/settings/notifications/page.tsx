"use client";

/**
 * /settings/notifications — master + 4 category toggles + quiet hours.
 *
 * Persists through PUT /api/notifications/preferences (in-memory STUB
 * for v1 — see lib/notif-prefs-stub.ts).
 */

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { LumoWordmark } from "@/components/BrandMark";
import { ThemeToggle } from "@/components/ThemeToggle";
import {
  defaultPrefs,
  type NotifCategoryKey,
  type NotifPrefs,
} from "@/lib/notif-prefs-stub";

const CATEGORIES: Array<{
  key: NotifCategoryKey;
  title: string;
  description: string;
}> = [
  {
    key: "mission_update",
    title: "Mission updates",
    description: "Status changes on trips and other tasks Lumo is running for you.",
  },
  {
    key: "payment_receipt",
    title: "Payment receipts",
    description: "Confirmations when Lumo charges or refunds your card.",
  },
  {
    key: "proactive_moment",
    title: "Proactive suggestions",
    description: "Things Lumo notices that might be useful — flight check-in, refund window expiring, etc.",
  },
  {
    key: "system",
    title: "System & security",
    description: "Account activity, security alerts, and operational notices.",
  },
];

export default function NotificationsSettingsPage() {
  const [prefs, setLocal] = useState<NotifPrefs>(defaultPrefs());
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedToast, setSavedToast] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/notifications/preferences", { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json()) as { prefs: NotifPrefs };
      setLocal(body.prefs);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load preferences");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const persist = async (next: NotifPrefs) => {
    setSaving(true);
    setError(null);
    setSavedToast(null);
    try {
      const res = await fetch("/api/notifications/preferences", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(next),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json()) as { prefs: NotifPrefs };
      setLocal(body.prefs);
      setSavedToast("Saved.");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Save failed");
      // Revert local view on error.
      void refresh();
    } finally {
      setSaving(false);
    }
  };

  const toggleMaster = () => persist({ ...prefs, master: !prefs.master });

  const toggleCategory = (key: NotifCategoryKey) =>
    persist({
      ...prefs,
      categories: { ...prefs.categories, [key]: !prefs.categories[key] },
    });

  const toggleQuietEnabled = () =>
    persist({
      ...prefs,
      quiet_hours: { ...prefs.quiet_hours, enabled: !prefs.quiet_hours.enabled },
    });

  const setQuietHour = (which: "start_hh_local" | "end_hh_local", v: number) =>
    persist({
      ...prefs,
      quiet_hours: { ...prefs.quiet_hours, [which]: v },
    });

  return (
    <main className="min-h-dvh bg-lumo-bg text-lumo-fg-high">
      <header className="sticky top-0 z-20 border-b border-lumo-hair bg-lumo-bg/85 backdrop-blur-md">
        <div className="mx-auto flex w-full max-w-3xl items-center justify-between px-5 py-3">
          <div className="flex items-center gap-2.5">
            <LumoWordmark height={20} />
            <span className="hidden sm:inline text-lumo-fg-low text-[12px]">/</span>
            <Link href="/settings" className="hidden sm:inline text-[13px] text-lumo-fg-mid hover:text-lumo-fg">
              Settings
            </Link>
            <span className="hidden sm:inline text-lumo-fg-low text-[12px]">/</span>
            <span className="hidden sm:inline text-[13px] text-lumo-fg">Notifications</span>
          </div>
          <ThemeToggle />
        </div>
      </header>

      <div className="mx-auto w-full max-w-3xl px-5 py-8 space-y-6">
        <div className="space-y-2">
          <h1 className="text-[26px] sm:text-[28px] font-semibold tracking-[-0.022em] text-lumo-fg leading-[1.15]">
            Notifications
          </h1>
          <p className="text-[13.5px] text-lumo-fg-mid leading-relaxed max-w-2xl">
            Choose which kinds of notifications you want and when Lumo
            should hold them. Quiet hours apply to push and in-app
            alerts; security messages always come through.
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
          <div className="h-32 rounded-xl border border-lumo-hair bg-lumo-surface animate-pulse" />
        ) : (
          <>
            <section className="rounded-xl border border-lumo-hair bg-lumo-surface p-5 sm:p-6 space-y-4">
              <ToggleRow
                title="All notifications"
                description="Master switch. Off pauses everything except critical security messages."
                checked={prefs.master}
                onChange={toggleMaster}
                disabled={saving}
              />
            </section>

            <section className="rounded-xl border border-lumo-hair bg-lumo-surface p-5 sm:p-6 space-y-4">
              <h2 className="text-[16px] font-semibold tracking-[-0.02em] text-lumo-fg">
                Categories
              </h2>
              <div className="space-y-2.5">
                {CATEGORIES.map((c) => (
                  <ToggleRow
                    key={c.key}
                    title={c.title}
                    description={c.description}
                    checked={prefs.categories[c.key]}
                    onChange={() => toggleCategory(c.key)}
                    disabled={saving || !prefs.master}
                  />
                ))}
              </div>
            </section>

            <section className="rounded-xl border border-lumo-hair bg-lumo-surface p-5 sm:p-6 space-y-4">
              <h2 className="text-[16px] font-semibold tracking-[-0.02em] text-lumo-fg">
                Quiet hours
              </h2>
              <ToggleRow
                title="Hold notifications during quiet hours"
                description="Lumo waits until quiet hours end, then delivers held messages in one digest."
                checked={prefs.quiet_hours.enabled}
                onChange={toggleQuietEnabled}
                disabled={saving}
              />
              {prefs.quiet_hours.enabled ? (
                <div className="grid grid-cols-2 gap-3">
                  <HourPicker
                    label="Start"
                    value={prefs.quiet_hours.start_hh_local}
                    onChange={(v) => setQuietHour("start_hh_local", v)}
                    disabled={saving}
                  />
                  <HourPicker
                    label="End"
                    value={prefs.quiet_hours.end_hh_local}
                    onChange={(v) => setQuietHour("end_hh_local", v)}
                    disabled={saving}
                  />
                </div>
              ) : null}
            </section>
          </>
        )}
      </div>
    </main>
  );
}

function ToggleRow(props: {
  title: string;
  description: string;
  checked: boolean;
  onChange: () => void;
  disabled?: boolean;
}) {
  return (
    <label className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 rounded-md border border-lumo-hair bg-lumo-bg/40 p-3.5 cursor-pointer">
      <div className="space-y-0.5">
        <div className="text-[13.5px] font-medium text-lumo-fg-high">{props.title}</div>
        <p className="text-[12.5px] text-lumo-fg-mid leading-relaxed max-w-xl">
          {props.description}
        </p>
      </div>
      <input
        type="checkbox"
        role="switch"
        aria-label={props.title}
        checked={props.checked}
        disabled={props.disabled}
        onChange={props.onChange}
        className="h-5 w-5 accent-lumo-accent flex-shrink-0"
      />
    </label>
  );
}

function HourPicker(props: {
  label: string;
  value: number;
  onChange: (n: number) => void;
  disabled?: boolean;
}) {
  return (
    <label className="block text-[12.5px] text-lumo-fg-mid">
      {props.label}
      <select
        value={props.value}
        onChange={(e) => props.onChange(Number(e.target.value))}
        disabled={props.disabled}
        className="mt-1 w-full h-9 px-2 rounded-md border border-lumo-hair bg-lumo-bg text-[13.5px] text-lumo-fg-high focus:outline-none focus:ring-1 focus:ring-lumo-accent disabled:opacity-50"
      >
        {Array.from({ length: 24 }).map((_, i) => (
          <option key={i} value={i}>
            {i.toString().padStart(2, "0")}:00
          </option>
        ))}
      </select>
    </label>
  );
}
