"use client";

/**
 * Signup — email + password + optional full name.
 *
 * Flow:
 *   - submit → Supabase Auth signUp
 *   - if email confirmation is enabled in the Supabase project, the user
 *     gets a magic link; we show an "Check your inbox" screen
 *   - otherwise they get a live session and we redirect to ?next
 *
 * The trigger `public.tg_handle_new_user` (see migration 004) creates
 * the matching public.profiles row automatically, so we don't do a
 * separate profile insert here.
 *
 * Suspense wrap: same reason as /login — useSearchParams() forces CSR
 * and Next 14 refuses to prerender without a Suspense boundary above
 * the hook consumer.
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

export default function SignupPage() {
  return (
    <Suspense fallback={<SignupShell />}>
      <SignupForm />
    </Suspense>
  );
}

function SignupShell() {
  return (
    <main className="min-h-dvh flex items-center justify-center bg-lumo-bg text-lumo-fg-high px-5">
      <div className="w-full max-w-sm">
        <h1 className="text-[24px] font-semibold tracking-tight mb-1">Create your Lumo account</h1>
        <p className="text-[13.5px] text-lumo-fg-mid mb-6">
          Then connect the apps you use and let Lumo do the rest.
        </p>
        <div className="h-[300px] rounded-md border border-lumo-hair bg-lumo-surface animate-pulse" />
      </div>
    </main>
  );
}

function SignupForm() {
  const router = useRouter();
  const params = useSearchParams();
  const next = params.get("next") ?? "/";

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [fullName, setFullName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [awaitingConfirm, setAwaitingConfirm] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);

    try {
      const supabase = getBrowserSupabase();
      const { data, error: err } = await supabase.auth.signUp({
        email: email.trim(),
        password,
        options: {
          data: { full_name: fullName.trim() || undefined },
          emailRedirectTo: `${window.location.origin}/auth/callback?next=${encodeURIComponent(next)}`,
        },
      });
      if (err) {
        setError(err.message);
        return;
      }

      // Supabase returns a user with no session when email confirmation
      // is required. In that case we park on the "check your inbox"
      // screen rather than pretending they're signed in.
      if (data.user && !data.session) {
        setAwaitingConfirm(true);
        return;
      }

      router.replace(next);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  if (awaitingConfirm) {
    return (
      <main className="min-h-dvh flex items-center justify-center bg-lumo-bg text-lumo-fg-high px-5">
        <div className="w-full max-w-sm space-y-3 text-center">
          <h1 className="text-[22px] font-semibold tracking-tight">Check your inbox</h1>
          <p className="text-[13.5px] text-lumo-fg-mid">
            We sent a confirmation link to <span className="text-lumo-fg">{email}</span>. Click
            it to finish creating your account.
          </p>
          <Link href="/login" className="inline-block text-[12.5px] text-lumo-accent hover:underline">
            Back to sign in
          </Link>
        </div>
      </main>
    );
  }

  return (
    <main className="min-h-dvh flex items-center justify-center bg-lumo-bg text-lumo-fg-high px-5">
      <div className="w-full max-w-sm">
        <h1 className="text-[24px] font-semibold tracking-tight mb-1">Create your Lumo account</h1>
        <p className="text-[13.5px] text-lumo-fg-mid mb-6">
          Then connect the apps you use and let Lumo do the rest.
        </p>

        <form onSubmit={onSubmit} className="space-y-3">
          <label className="block">
            <span className="text-[11px] uppercase tracking-[0.12em] text-lumo-fg-low">Name</span>
            <input
              type="text"
              autoComplete="name"
              value={fullName}
              onChange={(e) => setFullName(e.target.value)}
              className="mt-1 block w-full rounded-md border border-lumo-hair bg-lumo-surface px-3 py-2 text-[14px] text-lumo-fg placeholder:text-lumo-fg-low focus:border-lumo-edge outline-none"
              placeholder="Alex Rivera"
            />
          </label>

          <label className="block">
            <span className="text-[11px] uppercase tracking-[0.12em] text-lumo-fg-low">Email</span>
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
            <span className="text-[11px] uppercase tracking-[0.12em] text-lumo-fg-low">Password</span>
            <input
              type="password"
              autoComplete="new-password"
              required
              minLength={8}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="mt-1 block w-full rounded-md border border-lumo-hair bg-lumo-surface px-3 py-2 text-[14px] text-lumo-fg placeholder:text-lumo-fg-low focus:border-lumo-edge outline-none"
            />
            <span className="mt-1 block text-[11px] text-lumo-fg-low">8+ characters.</span>
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
            {busy ? "Creating account…" : "Create account"}
          </button>
        </form>

        <div className="mt-6 text-[12.5px] text-lumo-fg-mid text-center">
          Already have an account?{" "}
          <Link href={`/login${next !== "/" ? `?next=${encodeURIComponent(next)}` : ""}`} className="text-lumo-accent hover:underline">
            Sign in
          </Link>
        </div>
      </div>
    </main>
  );
}
