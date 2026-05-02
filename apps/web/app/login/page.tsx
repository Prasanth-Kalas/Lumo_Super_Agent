"use client";

/**
 * Login page — email/password sign in.
 *
 * WEB-DESIGN-OVERHAUL-1 — editorial flat-bold layout.
 *   - Two-column on md+: left side is editorial copy in display
 *     serif, right side is the form on a softly-elevated card.
 *   - Mobile collapses to single-column with the form on top.
 *   - Solid colors only; cyan rule + cyan italic emphasis are the
 *     visual accents (no gradients).
 *
 * Auth wiring is unchanged — Supabase Auth via createBrowserClient,
 * with seedProfile after success and ?next= redirect support.
 *
 * Suspense wrap: useSearchParams() forces CSR; the page shell prerenders.
 */

import { Suspense, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { createBrowserClient } from "@supabase/ssr";
import OAuthButtons from "@/components/OAuthButtons";
import { LumoWordmark } from "@/components/BrandMark";
import { seedProfile } from "@/lib/seed-profile";

function supabaseEnv(): { url: string; anonKey: string } {
  return {
    url: process.env.NEXT_PUBLIC_SUPABASE_URL ?? "",
    anonKey: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "",
  };
}
function isAuthConfigured(): boolean {
  const { url, anonKey } = supabaseEnv();
  return url.length > 0 && anonKey.length > 0;
}
function getBrowserSupabase() {
  const { url, anonKey } = supabaseEnv();
  return createBrowserClient(url, anonKey);
}

export default function LoginPage() {
  return (
    <Suspense fallback={<LoginShell />}>
      <LoginForm />
    </Suspense>
  );
}

function LoginShell() {
  return (
    <main className="min-h-dvh bg-lumo-bg text-lumo-fg">
      <Header />
      <div className="mx-auto max-w-6xl px-6 grid md:grid-cols-2 gap-10 md:gap-16 py-12 md:py-24">
        <EditorialCopy />
        <div className="rounded-3xl border border-lumo-hair bg-lumo-surface p-8 shadow-card-lift h-[420px] animate-pulse" />
      </div>
    </main>
  );
}

function Header() {
  return (
    <header className="sticky top-0 z-10 border-b border-lumo-hair bg-lumo-bg/85 backdrop-blur-md">
      <div className="max-w-6xl mx-auto flex items-center justify-between px-6 h-14">
        <Link href="/" className="flex items-center gap-2 text-lumo-fg">
          <LumoWordmark height={20} />
        </Link>
        <Link
          href="/signup"
          className="h-9 px-4 rounded-full text-[13px] font-semibold border border-lumo-hair text-lumo-fg-mid hover:text-lumo-fg hover:border-lumo-edge transition-colors inline-flex items-center"
        >
          Create account
        </Link>
      </div>
    </header>
  );
}

function EditorialCopy() {
  return (
    <div className="md:pt-6">
      <div className="text-[10.5px] uppercase tracking-[0.18em] text-lumo-fg-mid font-medium font-mono inline-flex items-center gap-2">
        <span className="h-[2px] w-6 bg-lumo-accent" aria-hidden />
        Welcome back
      </div>
      <h1 className="mt-6 font-display text-[56px] md:text-[88px] leading-[0.95] tracking-[-0.02em] text-lumo-fg">
        Pick up
        <br />
        <span className="italic text-lumo-accent">where you left off.</span>
      </h1>
      <p className="mt-7 text-[15px] md:text-[16px] text-lumo-fg-mid leading-[1.65] max-w-md">
        Your trips, memory, and connected apps are waiting. Sign in to keep
        the conversation going.
      </p>
    </div>
  );
}

function LoginForm() {
  const router = useRouter();
  const params = useSearchParams();
  const next = params.get("next") ?? "/";

  const [mounted, setMounted] = useState(false);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setMounted(true);
  }, []);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);

    try {
      const supabase = getBrowserSupabase();
      const { error: err } = await supabase.auth.signInWithPassword({
        email: email.trim(),
        password,
      });
      if (err) {
        setError(err.message);
        return;
      }
      void seedProfile();
      router.replace(next);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  if (!mounted) {
    return <LoginShell />;
  }

  if (!isAuthConfigured()) {
    return (
      <main className="min-h-dvh bg-lumo-bg text-lumo-fg">
        <Header />
        <div className="mx-auto max-w-2xl px-6 py-20 space-y-5">
          <h1 className="font-display text-[44px] md:text-[56px] leading-[1.0] tracking-[-0.02em] text-lumo-fg">
            Account system{" "}
            <span className="italic text-lumo-accent">
              isn&apos;t set up yet.
            </span>
          </h1>
          <p className="text-[14.5px] text-lumo-fg-mid leading-relaxed max-w-prose">
            Lumo&apos;s sign-in is powered by Supabase Auth. The
            NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY
            environment variables aren&apos;t configured on this deployment,
            so the form can&apos;t talk to the auth server.
          </p>
          <p className="text-[13.5px] text-lumo-fg-low leading-relaxed max-w-prose">
            If you&apos;re the admin: set both vars on Vercel (Project →
            Settings → Environment Variables), then redeploy. The URL looks
            like{" "}
            <code className="mx-1 rounded bg-lumo-elevated px-1.5 py-0.5 text-[12.5px]">
              https://&lt;ref&gt;.supabase.co
            </code>
            and the anon key starts with{" "}
            <code className="mx-1 rounded bg-lumo-elevated px-1.5 py-0.5 text-[12.5px]">
              eyJ
            </code>
            .
          </p>
          <Link
            href="/"
            className="inline-block text-[13.5px] text-lumo-accent hover:underline underline-offset-4"
          >
            ← Back to Lumo
          </Link>
        </div>
      </main>
    );
  }

  return (
    <main className="min-h-dvh bg-lumo-bg text-lumo-fg">
      <Header />
      <div className="mx-auto max-w-6xl px-6 grid md:grid-cols-2 gap-10 md:gap-16 py-12 md:py-24">
        <EditorialCopy />

        <div className="rounded-3xl border border-lumo-hair bg-lumo-surface p-7 md:p-8 shadow-card-lift">
          <div className="mb-5">
            <OAuthButtons next={next} disabled={busy} />
          </div>

          <div className="relative my-6 flex items-center">
            <div className="flex-1 border-t border-lumo-hair" />
            <span className="px-3 text-[10.5px] uppercase tracking-[0.18em] text-lumo-fg-low font-mono">
              or with email
            </span>
            <div className="flex-1 border-t border-lumo-hair" />
          </div>

          <form onSubmit={onSubmit} className="space-y-4">
            <label className="block">
              <span className="text-[11px] uppercase tracking-[0.16em] text-lumo-fg-mid font-mono">
                Email
              </span>
              <input
                type="email"
                autoComplete="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="mt-2 block w-full rounded-2xl border border-lumo-hair bg-lumo-bg px-4 py-3 text-[15px] text-lumo-fg placeholder:text-lumo-fg-low focus:border-lumo-accent focus:ring-2 focus:ring-lumo-accent/20 outline-none transition-shadow"
                placeholder="you@example.com"
              />
            </label>

            <label className="block">
              <span className="text-[11px] uppercase tracking-[0.16em] text-lumo-fg-mid font-mono">
                Password
              </span>
              <input
                type="password"
                autoComplete="current-password"
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="mt-2 block w-full rounded-2xl border border-lumo-hair bg-lumo-bg px-4 py-3 text-[15px] text-lumo-fg placeholder:text-lumo-fg-low focus:border-lumo-accent focus:ring-2 focus:ring-lumo-accent/20 outline-none transition-shadow"
              />
            </label>

            {error ? (
              <div className="text-[13px] text-lumo-err border border-lumo-err/30 bg-lumo-err/5 rounded-2xl px-4 py-3">
                {error}
              </div>
            ) : null}

            <button
              type="submit"
              disabled={busy || !email || !password}
              className="w-full h-12 rounded-full bg-lumo-fg text-lumo-bg text-[14.5px] font-semibold hover:bg-lumo-accent hover:text-lumo-accent-ink disabled:bg-lumo-elevated disabled:text-lumo-fg-low transition-colors shadow-card-lift"
            >
              {busy ? "Signing in…" : "Sign in"}
            </button>
          </form>

          <div className="mt-6 text-[13px] text-lumo-fg-mid text-center">
            No account?{" "}
            <Link
              href={`/signup${next !== "/" ? `?next=${encodeURIComponent(next)}` : ""}`}
              className="text-lumo-accent hover:underline underline-offset-4"
            >
              Create one
            </Link>
          </div>
        </div>
      </div>
    </main>
  );
}
