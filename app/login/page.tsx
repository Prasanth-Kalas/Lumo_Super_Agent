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
import { seedProfile } from "@/lib/seed-profile";

/**
 * NEXT_PUBLIC_* vars are inlined at BUILD time. If the Vercel project
 * doesn't have them configured when `next build` runs, these resolve
 * to empty strings in the shipped client bundle — and every
 * supabase.auth.* call fails with a misleading error. isAuthConfigured
 * lets the form render a clear "not set up" state instead of failing
 * mid-submit.
 */
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
      // Idempotent profile seed — fills in timezone/language from the
      // browser and display_name from auth metadata on first login
      // per session. No-ops if the profile is already complete.
      void seedProfile();
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

  // Auth env not configured — tell the user plainly instead of
  // letting the form fail silently.
  if (!isAuthConfigured()) {
    return (
      <main className="min-h-dvh flex items-center justify-center bg-lumo-bg text-lumo-fg-high px-5">
        <div className="w-full max-w-md space-y-4">
          <h1 className="text-[22px] font-semibold tracking-tight">
            Account system isn&apos;t set up yet
          </h1>
          <p className="text-[13.5px] text-lumo-fg-mid leading-relaxed">
            Lumo&apos;s sign-in is powered by Supabase Auth. The
            NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY
            environment variables aren&apos;t configured on this
            deployment, so the form can&apos;t talk to the auth
            server.
          </p>
          <p className="text-[13px] text-lumo-fg-low leading-relaxed">
            If you&apos;re the admin: set both vars on Vercel
            (Project → Settings → Environment Variables), then
            redeploy. The URL looks like
            <code className="mx-1 rounded bg-lumo-elevated px-1 py-0.5 text-[12px]">
              https://&lt;ref&gt;.supabase.co
            </code>
            and the anon key starts with
            <code className="mx-1 rounded bg-lumo-elevated px-1 py-0.5 text-[12px]">
              eyJ
            </code>
            .
          </p>
          <Link
            href="/"
            className="inline-block text-[13px] text-lumo-accent hover:underline underline-offset-4"
          >
            ← Back to Lumo
          </Link>
        </div>
      </main>
    );
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
