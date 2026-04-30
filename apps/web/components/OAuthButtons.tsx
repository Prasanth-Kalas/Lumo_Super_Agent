"use client";

/**
 * Continue-with-Google + Continue-with-Apple buttons for /login and
 * /signup. Both pages render this above their email field with a
 * "or continue with email" divider beneath.
 *
 * Click handler delegates to Supabase's `signInWithOAuth` which kicks
 * off the PKCE flow and bounces the user through the provider, then
 * back to /auth/callback?code=…&next=… (the auth callback route owns
 * the code-for-session exchange + the open-redirect-guarded `next`
 * round-trip — see app/auth/callback/route.ts).
 *
 * The Supabase project's provider config is the source of truth for
 * client IDs, scopes, and redirect URLs. This component just opens
 * the door; it doesn't carry any provider secrets.
 */

import { createBrowserClient } from "@supabase/ssr";
import { useState } from "react";
import { buildOAuthRedirectTo } from "@/lib/oauth-redirect";

export interface OAuthButtonsProps {
  /**
   * Same-origin absolute path the user wants to land on post-auth.
   * Round-trips through Supabase + /auth/callback. Defaults to "/".
   */
  next: string;
  /** Disables the buttons while the parent's email form is mid-submit. */
  disabled?: boolean;
}

type Provider = "google" | "apple";

export default function OAuthButtons({ next, disabled }: OAuthButtonsProps) {
  const [busy, setBusy] = useState<Provider | null>(null);
  const [error, setError] = useState<string | null>(null);

  const start = async (provider: Provider) => {
    if (busy || disabled) return;
    setBusy(provider);
    setError(null);
    try {
      const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
      const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "";
      if (!url || !anonKey) {
        setError("Auth isn't configured on this build.");
        return;
      }
      const supabase = createBrowserClient(url, anonKey);
      const origin =
        typeof window !== "undefined" ? window.location.origin : "";
      const { error: err } = await supabase.auth.signInWithOAuth({
        provider,
        options: {
          redirectTo: buildOAuthRedirectTo(origin, next),
        },
      });
      if (err) {
        setError(err.message);
      }
      // On success Supabase issues a navigation to the provider; the
      // current page is replaced. Nothing more to do here.
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="space-y-2.5">
      <button
        type="button"
        onClick={() => start("google")}
        disabled={busy !== null || !!disabled}
        aria-label="Continue with Google"
        data-testid="oauth-button-google"
        className="w-full h-10 rounded-md border border-lumo-hair bg-lumo-surface text-[13.5px] font-medium text-lumo-fg flex items-center justify-center gap-2.5 hover:bg-lumo-elevated disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
      >
        <GoogleGlyph />
        <span>{busy === "google" ? "Redirecting…" : "Continue with Google"}</span>
      </button>

      <button
        type="button"
        onClick={() => start("apple")}
        disabled={busy !== null || !!disabled}
        aria-label="Continue with Apple"
        data-testid="oauth-button-apple"
        className="w-full h-10 rounded-md border border-lumo-hair bg-lumo-surface text-[13.5px] font-medium text-lumo-fg flex items-center justify-center gap-2.5 hover:bg-lumo-elevated disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
      >
        <AppleGlyph />
        <span>{busy === "apple" ? "Redirecting…" : "Continue with Apple"}</span>
      </button>

      {error ? (
        <div
          role="alert"
          className="text-[12px] text-red-500 border border-red-500/30 bg-red-500/5 rounded-md px-3 py-2"
        >
          {error}
        </div>
      ) : null}

      <Divider />
    </div>
  );
}

function Divider() {
  return (
    <div className="flex items-center gap-3 pt-1 pb-1">
      <div className="h-px flex-1 bg-lumo-hair" />
      <span className="text-[11px] uppercase tracking-[0.12em] text-lumo-fg-low">
        or continue with email
      </span>
      <div className="h-px flex-1 bg-lumo-hair" />
    </div>
  );
}

/**
 * Google "G" — multicolor brand mark. Drawn inline so we don't pull a
 * Google-branded asset into our static dir; the geometry below is the
 * standard quartered logo per Google's brand guidelines.
 */
function GoogleGlyph() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      aria-hidden
      xmlns="http://www.w3.org/2000/svg"
    >
      <path
        d="M15.84 8.18c0-.6-.05-1.18-.15-1.74H8.16v3.29h4.31a3.69 3.69 0 0 1-1.6 2.42v2.01h2.59c1.51-1.39 2.38-3.45 2.38-5.98z"
        fill="#4285F4"
      />
      <path
        d="M8.16 16c2.16 0 3.97-.71 5.3-1.93l-2.59-2.01c-.72.48-1.64.77-2.71.77a4.74 4.74 0 0 1-4.46-3.29H1.05v2.07A8 8 0 0 0 8.16 16z"
        fill="#34A853"
      />
      <path
        d="M3.7 9.54a4.79 4.79 0 0 1 0-3.07V4.4H1.05a8 8 0 0 0 0 7.21l2.65-2.07z"
        fill="#FBBC05"
      />
      <path
        d="M8.16 3.18c1.18 0 2.23.41 3.06 1.2l2.29-2.29A8 8 0 0 0 1.05 4.4l2.65 2.07A4.74 4.74 0 0 1 8.16 3.18z"
        fill="#EA4335"
      />
    </svg>
  );
}

/**
 * Apple logo glyph. Single-color (currentColor) so it inherits text
 * color in light + dark.
 */
function AppleGlyph() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="currentColor"
      aria-hidden
      xmlns="http://www.w3.org/2000/svg"
    >
      <path d="M11.18 8.5a3.31 3.31 0 0 1 1.6-2.78 3.4 3.4 0 0 0-2.69-1.45c-1.13-.12-2.21.66-2.78.66-.59 0-1.46-.65-2.41-.63a3.57 3.57 0 0 0-3 1.83c-1.28 2.21-.33 5.49.92 7.29.6.86 1.32 1.84 2.27 1.81.91-.04 1.26-.59 2.36-.59 1.1 0 1.41.59 2.38.57.98-.01 1.6-.89 2.2-1.76.69-1 .98-1.97 1-2.02a3.21 3.21 0 0 1-1.85-2.93zM9.41 3.06a3.16 3.16 0 0 0 .73-2.27 3.23 3.23 0 0 0-2.09 1.08 3 3 0 0 0-.75 2.18 2.66 2.66 0 0 0 2.11-.99z" />
    </svg>
  );
}
