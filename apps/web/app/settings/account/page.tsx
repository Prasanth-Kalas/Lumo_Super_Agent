"use client";

/**
 * /settings/account — identity surface.
 *
 * Shows display name, email, member-since. Edit display name PATCHes
 * /api/memory/profile (writes to UserProfile.display_name). Sign out
 * POSTs /api/auth/logout and redirects to /login.
 */

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { LumoWordmark } from "@/components/BrandMark";
import { ThemeToggle } from "@/components/ThemeToggle";

interface MePayload {
  id: string;
  email: string | null;
  full_name: string | null;
  first_name: string | null;
  member_since: string | null;
}

export default function AccountSettingsPage() {
  const [me, setMe] = useState<MePayload | null>(null);
  const [displayName, setDisplayName] = useState<string>("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [savedToast, setSavedToast] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [signingOut, setSigningOut] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const [meRes, profRes] = await Promise.all([
        fetch("/api/me", { cache: "no-store" }),
        fetch("/api/memory/profile", { cache: "no-store" }),
      ]);
      if (!meRes.ok) throw new Error(`/api/me ${meRes.status}`);
      const meBody = (await meRes.json()) as { user: MePayload };
      setMe(meBody.user);
      let initialName = meBody.user.full_name ?? "";
      if (profRes.ok) {
        const profBody = (await profRes.json()) as {
          profile: { display_name: string | null } | null;
        };
        if (profBody.profile?.display_name) {
          initialName = profBody.profile.display_name;
        }
      }
      setDisplayName(initialName);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load account");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const handleSaveName = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setSavedToast(null);
    try {
      const res = await fetch("/api/memory/profile", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ display_name: displayName.trim() || null }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setSavedToast("Saved.");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Save failed");
    } finally {
      setSaving(false);
    }
  };

  const handleSignOut = async () => {
    setSigningOut(true);
    try {
      await fetch("/api/auth/logout", { method: "POST" });
    } catch {
      // logout endpoint always 204s; swallow
    }
    // Hard navigate so cookies clear cleanly.
    window.location.assign("/login");
  };

  return (
    <main className="min-h-dvh bg-lumo-bg text-lumo-fg-high">
      <header className="sticky top-0 z-20 border-b border-lumo-hair bg-lumo-bg/85 backdrop-blur-md">
        <div className="mx-auto flex w-full max-w-3xl items-center justify-between px-5 py-3">
          <div className="flex items-center gap-2.5">
            <LumoWordmark height={22} />
            <span className="hidden sm:inline text-lumo-fg-low text-[12px]">/</span>
            <Link href="/settings" className="hidden sm:inline text-[13px] text-lumo-fg-mid hover:text-lumo-fg">
              Settings
            </Link>
            <span className="hidden sm:inline text-lumo-fg-low text-[12px]">/</span>
            <span className="hidden sm:inline text-[13px] text-lumo-fg">Account</span>
          </div>
          <ThemeToggle />
        </div>
      </header>

      <div className="mx-auto w-full max-w-3xl px-5 py-8 space-y-6">
        <div className="space-y-2">
          <h1 className="text-[26px] sm:text-[28px] font-semibold tracking-[-0.022em] text-lumo-fg leading-[1.15]">
            Account
          </h1>
          <p className="text-[13.5px] text-lumo-fg-mid leading-relaxed max-w-2xl">
            Your name, sign-in email, and the date you joined Lumo.
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
        ) : me ? (
          <>
            <section className="rounded-xl border border-lumo-hair bg-lumo-surface p-5 sm:p-6 space-y-4">
              <h2 className="text-[16px] font-semibold tracking-[-0.02em] text-lumo-fg">
                Identity
              </h2>
              <form onSubmit={handleSaveName} className="space-y-3">
                <label className="block text-[12.5px] text-lumo-fg-mid">
                  Display name
                  <input
                    type="text"
                    value={displayName}
                    onChange={(e) => setDisplayName(e.target.value)}
                    className="mt-1 w-full h-9 px-3 rounded-md border border-lumo-hair bg-lumo-bg text-[13.5px] text-lumo-fg-high focus:outline-none focus:ring-1 focus:ring-lumo-accent"
                    placeholder="What should Lumo call you?"
                    maxLength={120}
                  />
                </label>
                <button
                  type="submit"
                  disabled={saving}
                  className="h-9 px-4 rounded-md bg-lumo-fg text-lumo-bg text-[13px] font-medium hover:bg-lumo-accent hover:text-lumo-accent-ink transition-colors disabled:opacity-50"
                >
                  {saving ? "Saving…" : "Save"}
                </button>
              </form>
              <dl className="grid grid-cols-1 sm:grid-cols-2 gap-y-2 gap-x-6 text-[12.5px] pt-2">
                <div>
                  <dt className="text-lumo-fg-low">Email</dt>
                  <dd className="text-lumo-fg-high">{me.email ?? "—"}</dd>
                </div>
                <div>
                  <dt className="text-lumo-fg-low">Member since</dt>
                  <dd className="text-lumo-fg-high">
                    {me.member_since
                      ? new Date(me.member_since).toLocaleDateString()
                      : "—"}
                  </dd>
                </div>
              </dl>
            </section>

            <section className="rounded-xl border border-lumo-hair bg-lumo-surface p-5 sm:p-6 space-y-3">
              <h2 className="text-[16px] font-semibold tracking-[-0.02em] text-lumo-fg">
                Session
              </h2>
              <p className="text-[12.5px] text-lumo-fg-mid leading-relaxed max-w-xl">
                Sign out on this device. Your data stays — you can sign
                back in any time.
              </p>
              <button
                type="button"
                onClick={handleSignOut}
                disabled={signingOut}
                className="h-9 px-3.5 rounded-md border border-red-500/30 bg-red-500/5 text-[12.5px] text-red-500 hover:bg-red-500/10 transition-colors disabled:opacity-50"
              >
                {signingOut ? "Signing out…" : "Sign out"}
              </button>
            </section>
          </>
        ) : null}
      </div>
    </main>
  );
}
