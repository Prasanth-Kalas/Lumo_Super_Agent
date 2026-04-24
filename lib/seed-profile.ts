/**
 * Client-side helper that seeds user_profile with values Lumo can
 * derive without asking the user: their account name, browser
 * timezone, browser language. Called from signup / login / chat
 * shell mount so profile stops starting empty.
 *
 * Idempotent by design — we PATCH only fields that are currently
 * null on the profile. Explicit user edits on /memory are never
 * overwritten.
 *
 * Gated by a sessionStorage flag so the seed call runs at most once
 * per browser session — no need to bang /api/memory on every shell
 * re-mount.
 */

const SEED_FLAG = "lumo.profileSeeded.v1";

interface PartialProfile {
  display_name?: string | null;
  timezone?: string | null;
  preferred_language?: string | null;
}

/**
 * Read current profile, compute the patch (only missing keys), and
 * PATCH /api/memory/profile if anything needs filling.
 *
 * `opts.fullName` is optional — pass it from the signup form when
 * available. If omitted we rely on Supabase Auth's user_metadata
 * (read server-side via /api/memory which reflects the auth row).
 */
export async function seedProfile(opts?: { fullName?: string }): Promise<void> {
  if (typeof window === "undefined") return;
  try {
    if (window.sessionStorage.getItem(SEED_FLAG) === "1") return;
  } catch {
    // Private mode — storage blocked. Fall through; worst case we
    // send one extra PATCH per navigation.
  }

  // Read existing profile to find gaps. /api/memory returns 401 when
  // the user isn't signed in — treat that as "nothing to seed" and
  // silently bail.
  let current: Record<string, unknown> | null = null;
  try {
    const res = await fetch("/api/memory", { cache: "no-store" });
    if (!res.ok) {
      // Not signed in or server error — don't mark seeded, try again
      // next session.
      return;
    }
    const j = (await res.json()) as { profile?: Record<string, unknown> | null };
    current = j.profile ?? null;
  } catch {
    return;
  }

  const patch: PartialProfile = {};

  // Name: prefer the fullName from the signup form (most direct).
  // Fall back to whatever the profile was seeded with server-side
  // (trigger tg_handle_new_user copies auth.users.raw_user_meta_data
  // → profiles; whether it flows into user_profile depends on the
  // migration, so we double-check here from the client).
  if (!current?.display_name) {
    if (opts?.fullName?.trim()) {
      patch.display_name = opts.fullName.trim();
    }
  }

  // Timezone — IANA zone from the browser. Always safe to auto-fill.
  if (!current?.timezone) {
    try {
      const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
      if (tz) patch.timezone = tz;
    } catch {
      /* ignore */
    }
  }

  // Preferred language — BCP-47 from the browser.
  if (!current?.preferred_language) {
    const lang =
      typeof navigator !== "undefined" ? navigator.language : null;
    if (lang) patch.preferred_language = lang;
  }

  if (Object.keys(patch).length === 0) {
    // Nothing missing — mark seeded so we don't recheck this session.
    try {
      window.sessionStorage.setItem(SEED_FLAG, "1");
    } catch {
      /* ignore */
    }
    return;
  }

  try {
    const res = await fetch("/api/memory/profile", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(patch),
    });
    if (res.ok) {
      try {
        window.sessionStorage.setItem(SEED_FLAG, "1");
      } catch {
        /* ignore */
      }
    }
    // Non-2xx: don't mark seeded; we'll retry on next mount.
  } catch {
    // Network blip — silent retry next session.
  }
}

/**
 * Reset the seed flag. Call on sign-out so the next user's session
 * triggers a fresh seed.
 */
export function clearSeedFlag(): void {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.removeItem(SEED_FLAG);
  } catch {
    /* ignore */
  }
}
