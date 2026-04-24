/**
 * Standing intents DAO.
 *
 * Routines users author — via chat ("every Friday 6pm book me a bike
 * ride") or the /intents page — that Lumo evaluates on a schedule and
 * fires into the notification outbox when due.
 *
 * Cron parsing: we use a minimal in-house parser (see parseCron below)
 * rather than pulling in a dependency. We only support the 5-field
 * vixcron shape with `*`, single numbers, and comma-lists. No ranges,
 * no steps, no day-name aliases. If a user wants more, they can use
 * the UI's schedule builder (to be added) which emits a normalized
 * string.
 *
 * We intentionally do NOT dispatch actions automatically in J3. When
 * an intent is "due", the evaluator creates a notification; the user
 * taps Confirm in the UI which then runs the action plan through
 * normal orchestrator plumbing. Auto-dispatch (with spend caps,
 * per-tool autonomy tiers, kill-switch) is J6 work.
 */

import { randomBytes } from "node:crypto";
import { getSupabase } from "./db.js";

// ──────────────────────────────────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────────────────────────────────

export interface StandingIntent {
  id: string;
  user_id: string;
  description: string;
  schedule_cron: string;
  timezone: string;
  guardrails: Record<string, unknown>;
  action_plan: Record<string, unknown>;
  enabled: boolean;
  last_fired_at: string | null;
  next_fire_at: string | null;
  created_at: string;
  updated_at: string;
}

export class IntentError extends Error {
  readonly code:
    | "persistence_disabled"
    | "invalid_input"
    | "not_found"
    | "invalid_cron";
  constructor(code: IntentError["code"], message: string) {
    super(message);
    this.name = "IntentError";
    this.code = code;
  }
}

// ──────────────────────────────────────────────────────────────────────────
// CRUD
// ──────────────────────────────────────────────────────────────────────────

export async function createIntent(args: {
  user_id: string;
  description: string;
  schedule_cron: string;
  timezone?: string;
  guardrails?: Record<string, unknown>;
  action_plan?: Record<string, unknown>;
  enabled?: boolean;
}): Promise<StandingIntent> {
  const db = getSupabase();
  if (!db) throw new IntentError("persistence_disabled", "Supabase not configured.");

  const description = args.description.trim();
  if (description.length < 6 || description.length > 500) {
    throw new IntentError("invalid_input", "Description must be 6..500 chars.");
  }
  const schedule_cron = args.schedule_cron.trim();
  if (!isCronParseable(schedule_cron)) {
    throw new IntentError("invalid_cron", `Not a valid 5-field cron: ${schedule_cron}`);
  }

  const tz = args.timezone ?? "UTC";
  const now = new Date();
  const next = computeNextFireAt(schedule_cron, tz, now);

  const row = {
    id: `intent_${randomBytes(9).toString("base64url")}`,
    user_id: args.user_id,
    description,
    schedule_cron,
    timezone: tz,
    guardrails: args.guardrails ?? {},
    action_plan: args.action_plan ?? {},
    enabled: args.enabled ?? true,
    last_fired_at: null,
    next_fire_at: next ? next.toISOString() : null,
  };

  const { data, error } = await db
    .from("standing_intents")
    .insert(row)
    .select(selectCols())
    .single();

  if (error || !data) {
    throw new IntentError("invalid_input", `createIntent: ${error?.message ?? "unknown"}`);
  }
  return data as unknown as StandingIntent;
}

export async function updateIntent(args: {
  user_id: string;
  id: string;
  patch: Partial<
    Pick<
      StandingIntent,
      "description" | "schedule_cron" | "timezone" | "guardrails" | "action_plan" | "enabled"
    >
  >;
}): Promise<StandingIntent | null> {
  const db = getSupabase();
  if (!db) throw new IntentError("persistence_disabled", "Supabase not configured.");

  // If schedule or timezone changed, recompute next_fire_at so the
  // evaluator picks up the change on its next tick.
  const patch: Record<string, unknown> = { ...args.patch };
  if (patch.schedule_cron || patch.timezone) {
    // Pull current to merge with patch for cron computation.
    const { data: current } = await db
      .from("standing_intents")
      .select("schedule_cron, timezone")
      .eq("id", args.id)
      .eq("user_id", args.user_id)
      .single();
    if (current) {
      const cron = (patch.schedule_cron as string) ?? current.schedule_cron;
      const tz = (patch.timezone as string) ?? current.timezone;
      if (typeof cron === "string" && !isCronParseable(cron)) {
        throw new IntentError("invalid_cron", `Not a valid 5-field cron: ${cron}`);
      }
      const next = computeNextFireAt(cron, tz, new Date());
      patch.next_fire_at = next ? next.toISOString() : null;
    }
  }

  const { data, error } = await db
    .from("standing_intents")
    .update(patch)
    .eq("id", args.id)
    .eq("user_id", args.user_id)
    .select(selectCols())
    .single();

  if (error) {
    if ((error as { code?: string }).code === "PGRST116") return null;
    throw new IntentError("invalid_input", `updateIntent: ${error.message}`);
  }
  return (data as unknown as StandingIntent) ?? null;
}

export async function deleteIntent(user_id: string, id: string): Promise<void> {
  const db = getSupabase();
  if (!db) throw new IntentError("persistence_disabled", "Supabase not configured.");
  const { error } = await db
    .from("standing_intents")
    .delete()
    .eq("id", id)
    .eq("user_id", user_id);
  if (error) throw new IntentError("invalid_input", `deleteIntent: ${error.message}`);
}

export async function listForUser(user_id: string): Promise<StandingIntent[]> {
  const db = getSupabase();
  if (!db) return [];
  const { data, error } = await db
    .from("standing_intents")
    .select(selectCols())
    .eq("user_id", user_id)
    .order("created_at", { ascending: false });
  if (error) {
    console.error("[intents] listForUser failed:", error.message);
    return [];
  }
  return (data ?? []) as unknown as StandingIntent[];
}

/**
 * Evaluator hot path — intents that are enabled AND next_fire_at <= now.
 * Bounded LIMIT so a clogged evaluator doesn't try to fire 10k intents in
 * one run. The evaluator cron ticks every 15 min so eventual consistency
 * is fine.
 */
export async function dueForEvaluation(limit = 100): Promise<StandingIntent[]> {
  const db = getSupabase();
  if (!db) return [];
  const nowIso = new Date().toISOString();
  const { data, error } = await db
    .from("standing_intents")
    .select(selectCols())
    .eq("enabled", true)
    .not("next_fire_at", "is", null)
    .lte("next_fire_at", nowIso)
    .order("next_fire_at", { ascending: true })
    .limit(limit);
  if (error) {
    console.error("[intents] dueForEvaluation failed:", error.message);
    return [];
  }
  return (data ?? []) as unknown as StandingIntent[];
}

/**
 * After the evaluator fires an intent, advance its cursor: set
 * last_fired_at and recompute next_fire_at from the cron spec.
 */
export async function advanceAfterFire(
  id: string,
  schedule_cron: string,
  timezone: string,
): Promise<void> {
  const db = getSupabase();
  if (!db) return;
  const now = new Date();
  // Start search strictly after "now" to avoid re-firing the same tick.
  const next = computeNextFireAt(schedule_cron, timezone, new Date(now.getTime() + 60 * 1000));
  const { error } = await db
    .from("standing_intents")
    .update({
      last_fired_at: now.toISOString(),
      next_fire_at: next ? next.toISOString() : null,
    })
    .eq("id", id);
  if (error) console.error("[intents] advanceAfterFire failed:", error.message);
}

function selectCols(): string {
  return "id, user_id, description, schedule_cron, timezone, guardrails, action_plan, enabled, last_fired_at, next_fire_at, created_at, updated_at";
}

// ──────────────────────────────────────────────────────────────────────────
// Minimal 5-field cron (minute hour dom month dow)
// ──────────────────────────────────────────────────────────────────────────
// Supported grammar:
//   field := "*" | int | int "," int (, ...)
// Not supported: ranges (5-10), steps (*/5), name aliases (MON, JAN).
// We validate up-front so createIntent rejects garbage with a clear error.

export function isCronParseable(expr: string): boolean {
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) return false;
  const ranges = [
    [0, 59],
    [0, 23],
    [1, 31],
    [1, 12],
    [0, 6],
  ];
  for (let i = 0; i < 5; i++) {
    const field = fields[i];
    const range = ranges[i];
    if (field === undefined || range === undefined) return false;
    const [min, max] = range;
    if (min === undefined || max === undefined) return false;
    if (field === "*") continue;
    const parts = field.split(",");
    for (const p of parts) {
      if (!/^\d+$/.test(p)) return false;
      const n = parseInt(p, 10);
      if (n < min || n > max) return false;
    }
  }
  return true;
}

/**
 * Compute the next fire time at or after `fromUtc`, evaluated in the
 * given IANA timezone. Returns null if the expression is invalid.
 *
 * Approach: step forward minute-by-minute up to 62 days ahead. This is
 * dumb but correct for our grammar and well under 100k iterations in
 * the worst case. If you're tempted to replace this with a bignum-smart
 * solver, wait until we actually need it.
 */
export function computeNextFireAt(
  expr: string,
  timezone: string,
  fromUtc: Date,
): Date | null {
  if (!isCronParseable(expr)) return null;
  const fields = expr.trim().split(/\s+/);
  const [minF, hourF, domF, monF, dowF] = fields as [string, string, string, string, string];

  // Start at the next whole minute so "* * * * *" doesn't return now.
  const start = new Date(fromUtc.getTime());
  start.setUTCSeconds(0, 0);
  start.setUTCMinutes(start.getUTCMinutes() + 1);

  const HORIZON_MIN = 62 * 24 * 60;
  let cursor = start.getTime();
  for (let i = 0; i < HORIZON_MIN; i++) {
    const d = new Date(cursor);
    const parts = extractTzParts(d, timezone);
    if (
      matchesField(parts.minute, minF, 0, 59) &&
      matchesField(parts.hour, hourF, 0, 23) &&
      matchesField(parts.day, domF, 1, 31) &&
      matchesField(parts.month, monF, 1, 12) &&
      matchesField(parts.dow, dowF, 0, 6)
    ) {
      return d;
    }
    cursor += 60 * 1000;
  }
  return null;
}

function matchesField(value: number, field: string, min: number, max: number): boolean {
  if (field === "*") return true;
  for (const p of field.split(",")) {
    const n = parseInt(p, 10);
    if (!Number.isNaN(n) && n === value && n >= min && n <= max) return true;
  }
  return false;
}

interface TzParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  dow: number; // 0 = Sunday
}

/**
 * Pull year/month/day/hour/minute/dow as observed in a given IANA
 * timezone. Uses Intl.DateTimeFormat with hour12=false — standard and
 * consistent across Node versions.
 */
function extractTzParts(d: Date, timezone: string): TzParts {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    weekday: "short",
  });
  const parts: Record<string, string> = {};
  for (const p of fmt.formatToParts(d)) {
    if (p.type !== "literal") parts[p.type] = p.value;
  }
  const dowMap: Record<string, number> = {
    Sun: 0,
    Mon: 1,
    Tue: 2,
    Wed: 3,
    Thu: 4,
    Fri: 5,
    Sat: 6,
  };
  // Intl may emit "24" for hour when hour12=false + midnight — normalize.
  let hour = parseInt(parts.hour ?? "0", 10);
  if (hour === 24) hour = 0;
  return {
    year: parseInt(parts.year ?? "0", 10),
    month: parseInt(parts.month ?? "0", 10),
    day: parseInt(parts.day ?? "0", 10),
    hour,
    minute: parseInt(parts.minute ?? "0", 10),
    dow: dowMap[parts.weekday ?? "Sun"] ?? 0,
  };
}
