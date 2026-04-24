"use client";

/**
 * Login page — email/password sign in.
 *
 * Intentionally minimal: we inherit Supabase Auth's rate limiting,
 * email verification, and reset-password flows. This form is just the
 * glue.
 *
 * Next/redirect-on-success:
 *   ?next=/marketplace/food   → redirect after successful login
 *   default                    → /
 *
 * For signup flow, see /signup. For magic link / SSO later — we'll add
 * alternate CTA rows here.
 *
 * Suspense wrap: the form calls useSearchParams() which forces
 * client-side rendering. Next 14 refuses to prerender a page whose
 * root uses that hook without a Suspense boundary — build error
 * "missing-suspense-with-csr-bailout". We split the form out into a
 * child component and render it inside a <Suspense> at the page
 * root; the page shell prerenders (static fallback), the form
 * hydrates on the client with the real ?next param.
 */

import { Suspense, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { createBrowserClient } from "@supabase/ssr";

function getBrowserSupabase() {
  const url =
    process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_URL ?? "";
  const anonKey =
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??
    process.env.SUPABASE_ANON_KEY ??
    "";
  return createBrowserClient(url, anonKey);
}

export default function LoginPage() {
  return (
    <Suspense fallback={<LoginShell />}>
      <LoginForm />
    </Suspense>
  );
}

/**
 * Static fallback rendered during build-time prerender and while
 * the real form is hydrating. Matches the final layout so there's
 * no visible flash.
 */
function LoginShell() {
  return (
    <main className="min-h-dvh flex items-center justify-center bg-lumo-bg text-lumo-fg-high px-5">
      <div className="w-full max-w-sm">
        <h1 className="text-[24px] font-semibold tracking-tight mb-1">
          Sign in to Lumo
        </h1>
        <p className="text-[13.5px] text-lumo-fg-mid mb-6">
          One account. Every connected app.
        </p>
        <div className="h-[220px] rounded-md border border-lumo-hair bg-lumo-surface animate-pulse" />
      </div>
    </main>
  );
}

function LoginForm() {
  const router = useRouter();
  const params = useSearchParams();
  const next = params.get("next") ?? "/";

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
      // Middleware will see the new cookie on the next request; we can
      // push straight to `next`.
      router.replace(next);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="min-h-dvh flex items-center justify-center bg-lumo-bg text-lumo-fg-high px-5">
      <div className="w-full max-w-sm">
        <h1 className="text-[24px] font-semibold tracking-tight mb-1">
          Sign in to Lumo
        </h1>
        <p className="text-[13.5px] text-lumo-fg-mid mb-6">
          One account. Every connected app.
        </p>

        <form onSubmit={onSubmit} className="space-y-3">
          <label className="block">
            <span className="text-[11px] uppercase tracking-[0.12em] text-lumo-fg-low">
              Email
            </span>
            <input
              type="email"
              autoComplete="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="mt-1 block w-full rounded-md border border-lumo-hair bg-lumo-surface px-3 py-2 text-[14px] text-lumo-fg placeholder:text-lumo-fg-low focus:border-lumo-edge outline-none"
              placeholder="you@example.com"
            />
          </label>

          <label className="block">
            <span className="text-[11px] uppercase tracking-[0.12em] text-lumo-fg-low">
              Password
            </span>
            <input
              type="password"
              autoComplete="current-password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="mt-1 block w-full rounded-md border border-lumo-hair bg-lumo-surface px-3 py-2 text-[14px] text-lumo-fg placeholder:text-lumo-fg-low focus:border-lumo-edge outline-none"
            />
          </label>

          {error ? (
            <div className="text-[12.5px] text-red-500 border border-red-500/30 bg-red-500/5 rounded-md px-3 py-2">
              {error}
            </div>
          ) : null}

          <button
            type="submit"
            disabled={busy || !email || !password}
            className="w-full h-9 rounded-md bg-lumo-fg text-lumo-bg text-[13.5px] font-medium hover:bg-lumo-accent hover:text-lumo-accent-ink disabled:bg-lumo-elevated disabled:text-lumo-fg-low transition-colors"
          >
            {busy ? "Signing in…" : "Sign in"}
          </button>
        </form>

        <div className="mt-6 text-[12.5px] text-lumo-fg-mid text-center">
          No account?{" "}
          <Link href={`/signup${next !== "/" ? `?next=${encodeURIComponent(next)}` : ""}`} className="text-lumo-accent hover:underline">
            Create one
          </Link>
        </div>
      </div>
    </main>
  );
}
