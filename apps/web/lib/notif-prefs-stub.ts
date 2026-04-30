/**
 * Web notification-preferences store — STUB.
 *
 * In-memory Map<userId, NotifPrefs>. Lost on server restart.
 *
 * Why a stub: iOS holds these in UserDefaults and there is no DB
 * column on the web side yet. NOTIF-PREFS-PERSIST-1 will add a
 * jsonb column to user_profile (or a new table) and swap the read +
 * write paths to Supabase. The shape on the wire is stable so the
 * /settings/notifications page is the only consumer that needs to
 * keep working — backend implementation moves under it.
 *
 * Shape mirrors iOS:
 *   master:    boolean
 *   categories.mission_update / payment_receipt / proactive_moment / system: boolean
 *   quiet_hours.enabled: boolean, start_hh_local / end_hh_local: 0–23
 */

export type NotifCategoryKey =
  | "mission_update"
  | "payment_receipt"
  | "proactive_moment"
  | "system";

export interface NotifCategoryFlags {
  mission_update: boolean;
  payment_receipt: boolean;
  proactive_moment: boolean;
  system: boolean;
}

export interface QuietHours {
  enabled: boolean;
  start_hh_local: number;
  end_hh_local: number;
}

export interface NotifPrefs {
  master: boolean;
  categories: NotifCategoryFlags;
  quiet_hours: QuietHours;
}

const store = new Map<string, NotifPrefs>();

export function defaultPrefs(): NotifPrefs {
  return {
    master: true,
    categories: {
      mission_update: true,
      payment_receipt: true,
      proactive_moment: true,
      system: true,
    },
    quiet_hours: {
      enabled: false,
      start_hh_local: 22,
      end_hh_local: 7,
    },
  };
}

export function getPrefs(user_id: string): NotifPrefs {
  return store.get(user_id) ?? defaultPrefs();
}

export function setPrefs(user_id: string, prefs: NotifPrefs): NotifPrefs {
  store.set(user_id, prefs);
  return prefs;
}

export function __resetForTesting(): void {
  store.clear();
}

/**
 * Validate + normalize an incoming PUT body. Rejects shape errors,
 * clamps hours to 0-23, and ignores any extra keys. Returns null if
 * the body isn't recoverable.
 */
export function validatePrefsBody(raw: unknown): NotifPrefs | null {
  if (!raw || typeof raw !== "object") return null;
  const body = raw as Record<string, unknown>;
  const cats = body.categories as Record<string, unknown> | undefined;
  const qh = body.quiet_hours as Record<string, unknown> | undefined;
  if (!cats || typeof cats !== "object") return null;
  if (!qh || typeof qh !== "object") return null;
  const isBool = (v: unknown): v is boolean => typeof v === "boolean";
  if (!isBool(body.master)) return null;
  if (
    !isBool(cats.mission_update) ||
    !isBool(cats.payment_receipt) ||
    !isBool(cats.proactive_moment) ||
    !isBool(cats.system)
  ) {
    return null;
  }
  if (!isBool(qh.enabled)) return null;
  const start = clampHour(qh.start_hh_local);
  const end = clampHour(qh.end_hh_local);
  if (start === null || end === null) return null;
  return {
    master: body.master,
    categories: {
      mission_update: cats.mission_update,
      payment_receipt: cats.payment_receipt,
      proactive_moment: cats.proactive_moment,
      system: cats.system,
    },
    quiet_hours: {
      enabled: qh.enabled,
      start_hh_local: start,
      end_hh_local: end,
    },
  };
}

function clampHour(v: unknown): number | null {
  if (typeof v !== "number" || !Number.isFinite(v)) return null;
  const i = Math.floor(v);
  if (i < 0 || i > 23) return null;
  return i;
}

/**
 * True when the given local hour-of-day falls inside the user's quiet
 * window. Handles wraparound (e.g. 22 → 7) correctly. Pure helper —
 * does not consult the store.
 */
export function quietHoursIsActive(
  prefs: NotifPrefs,
  local_hour: number,
): boolean {
  if (!prefs.quiet_hours.enabled) return false;
  const { start_hh_local: s, end_hh_local: e } = prefs.quiet_hours;
  if (s === e) return false;
  if (s < e) {
    return local_hour >= s && local_hour < e;
  }
  // Wraparound (e.g., 22→7): hour is in [s, 24) ∪ [0, e).
  return local_hour >= s || local_hour < e;
}
