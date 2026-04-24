/**
 * Autonomy gate — the "should Lumo do this without asking?" decision.
 *
 * The evaluator and (eventually) any other auto-dispatch path call
 * `evaluateAutonomy()` with a proposed action. It returns:
 *
 *   { allow: true,  recordId }              — proceed, audit row pre-created
 *   { allow: false, reason: <enum> }        — fall back to notification
 *
 * Gates checked, in order (first failure wins so we give a specific reason):
 *
 *   1. Kill-switch  — user_autonomy.kill_switch_until > now()  → deny.
 *   2. Tool tier    — tiers[tool_kind] resolves to one of:
 *                       "always_ask"            → deny.
 *                       "ask_if_over:<cents>"   → deny iff amount >= cents.
 *                       "auto"                  → allow (subject to cap).
 *                     Missing key → treated as "always_ask" (safe default).
 *   3. Daily cap    — sum(today's autonomous_actions.amount_cents) + amount
 *                     > user_autonomy.daily_cap_cents → deny.
 *
 * When allow = true, we pre-insert the autonomous_actions row with
 * outcome='dispatched'. The caller updates that row via
 * `recordOutcome()` once the router / Saga reports back. Pre-insert
 * matters because it reserves the cap (prevents double-spend in a
 * single scan tick).
 *
 * Tool-kind mapping: manifest.domain + intent prefix. We keep it
 * narrow for MVP; extend as we add agents.
 */

import { randomBytes } from "node:crypto";
import { getSupabase } from "./db.js";

export type AutonomyTier =
  | "always_ask"
  | "auto"
  | string; // "ask_if_over:<cents>" — validated at parse time

export interface UserAutonomy {
  user_id: string;
  tiers: Record<string, AutonomyTier>;
  daily_cap_cents: number;
  kill_switch_until: string | null;
  updated_at: string;
}

export type DenyReason =
  | "kill_switch"
  | "always_ask"
  | "over_tier_threshold"
  | "daily_cap_exceeded"
  | "persistence_disabled"
  | "internal_error";

export interface EvaluateInput {
  user_id: string;
  tool_kind: string;
  tool_name: string;
  agent_id?: string;
  amount_cents: number;
  currency?: string;
  intent_id?: string | null;
  summary_hash?: string | null;
}

export type EvaluateResult =
  | { allow: true; record_id: string }
  | { allow: false; reason: DenyReason; detail?: string };

/**
 * Decide + (on allow) reserve cap. Call once per action; do NOT retry
 * on deny — fall through to the notification path.
 */
export async function evaluateAutonomy(
  input: EvaluateInput,
): Promise<EvaluateResult> {
  const db = getSupabase();
  if (!db) return { allow: false, reason: "persistence_disabled" };

  // 1) Load user autonomy row. The trigger-backfilled row always
  // exists for an authed user; we self-heal anyway.
  const autonomy = await loadAutonomy(input.user_id);
  if (!autonomy) return { allow: false, reason: "internal_error" };

  // 2) Kill-switch?
  if (
    autonomy.kill_switch_until &&
    new Date(autonomy.kill_switch_until).getTime() > Date.now()
  ) {
    return { allow: false, reason: "kill_switch" };
  }

  // 3) Tier check.
  const tier = autonomy.tiers[input.tool_kind] ?? "always_ask";
  const tierCheck = checkTier(tier, input.amount_cents);
  if (!tierCheck.ok) {
    return { allow: false, reason: tierCheck.reason, detail: tierCheck.detail };
  }

  // 4) Daily cap.
  const spentToday = await sumTodaySpent(input.user_id);
  if (spentToday + input.amount_cents > autonomy.daily_cap_cents) {
    return {
      allow: false,
      reason: "daily_cap_exceeded",
      detail: `spent=${spentToday}c, need=${input.amount_cents}c, cap=${autonomy.daily_cap_cents}c`,
    };
  }

  // 5) Pre-insert the audit row to reserve the cap.
  const id = `auto_${randomBytes(9).toString("base64url")}`;
  const { error } = await db.from("autonomous_actions").insert({
    id,
    user_id: input.user_id,
    intent_id: input.intent_id ?? null,
    tool_kind: input.tool_kind,
    tool_name: input.tool_name,
    agent_id: input.agent_id ?? null,
    amount_cents: input.amount_cents,
    currency: input.currency ?? null,
    outcome: "dispatched",
    summary_hash: input.summary_hash ?? null,
  });
  if (error) {
    console.error("[autonomy] reserve failed:", error.message);
    return { allow: false, reason: "internal_error" };
  }

  return { allow: true, record_id: id };
}

/**
 * Update the outcome of a previously-approved action. Called by the
 * caller after the router returns (or Saga rolls back).
 */
export async function recordOutcome(args: {
  record_id: string;
  outcome: "committed" | "rolled_back" | "failed";
  request_ref?: string;
  error_detail?: Record<string, unknown>;
}): Promise<void> {
  const db = getSupabase();
  if (!db) return;
  const patch: Record<string, unknown> = { outcome: args.outcome };
  if (args.request_ref !== undefined) patch.request_ref = args.request_ref;
  if (args.error_detail !== undefined) patch.error_detail = args.error_detail;
  const { error } = await db
    .from("autonomous_actions")
    .update(patch)
    .eq("id", args.record_id);
  if (error) console.error("[autonomy] recordOutcome failed:", error.message);
}

// ──────────────────────────────────────────────────────────────────────────
// Reads for the /autonomy page
// ──────────────────────────────────────────────────────────────────────────

export async function getAutonomy(user_id: string): Promise<UserAutonomy | null> {
  return loadAutonomy(user_id);
}

export async function updateAutonomy(
  user_id: string,
  patch: {
    tiers?: Record<string, string>;
    daily_cap_cents?: number;
    kill_switch_until?: string | null;
  },
): Promise<UserAutonomy | null> {
  const db = getSupabase();
  if (!db) return null;
  const p: Record<string, unknown> = {};
  if (patch.tiers) {
    // Validate every tier string so malformed "ask_if_over:" entries
    // don't reach the gate and silently fall through as always_ask.
    for (const [k, v] of Object.entries(patch.tiers)) {
      if (!isValidTier(v)) {
        throw new Error(`Invalid tier for ${k}: ${v}`);
      }
    }
    p.tiers = patch.tiers;
  }
  if (typeof patch.daily_cap_cents === "number") {
    p.daily_cap_cents = Math.max(0, Math.floor(patch.daily_cap_cents));
  }
  if (patch.kill_switch_until !== undefined) {
    p.kill_switch_until = patch.kill_switch_until;
  }
  const { data, error } = await db
    .from("user_autonomy")
    .update(p)
    .eq("user_id", user_id)
    .select("*")
    .single();
  if (error || !data) {
    console.error("[autonomy] update failed:", error?.message);
    return null;
  }
  return toAutonomy(data);
}

export interface AutonomousActionRow {
  id: string;
  user_id: string;
  intent_id: string | null;
  tool_kind: string;
  tool_name: string;
  agent_id: string | null;
  amount_cents: number;
  currency: string | null;
  outcome: string;
  request_ref: string | null;
  fired_at: string;
}

export async function listRecentActions(
  user_id: string,
  limit = 50,
): Promise<AutonomousActionRow[]> {
  const db = getSupabase();
  if (!db) return [];
  const { data, error } = await db
    .from("autonomous_actions")
    .select(
      "id, user_id, intent_id, tool_kind, tool_name, agent_id, amount_cents, currency, outcome, request_ref, fired_at",
    )
    .eq("user_id", user_id)
    .order("fired_at", { ascending: false })
    .limit(limit);
  if (error) {
    console.error("[autonomy] listRecentActions failed:", error.message);
    return [];
  }
  return (data ?? []) as AutonomousActionRow[];
}

/**
 * Today's autonomous spend — exposed so the /autonomy UI can render a
 * "you've used $X of $Y" progress bar without having to reimplement
 * the date math.
 */
export async function getTodaySpendCents(user_id: string): Promise<number> {
  return sumTodaySpent(user_id);
}

// ──────────────────────────────────────────────────────────────────────────
// Internals
// ──────────────────────────────────────────────────────────────────────────

async function loadAutonomy(user_id: string): Promise<UserAutonomy | null> {
  const db = getSupabase();
  if (!db) return null;
  const { data, error } = await db
    .from("user_autonomy")
    .select("*")
    .eq("user_id", user_id)
    .limit(1);
  if (error) {
    console.error("[autonomy] loadAutonomy failed:", error.message);
    return null;
  }
  if (data && data[0]) return toAutonomy(data[0]);

  // Self-heal insert — matches the profile-trigger pattern in case a
  // user pre-dates migration 007.
  const { data: ins, error: insErr } = await db
    .from("user_autonomy")
    .insert({ user_id })
    .select("*")
    .single();
  if (insErr || !ins) {
    console.error("[autonomy] self-heal insert failed:", insErr?.message);
    return null;
  }
  return toAutonomy(ins);
}

async function sumTodaySpent(user_id: string): Promise<number> {
  const db = getSupabase();
  if (!db) return 0;
  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD UTC
  const { data, error } = await db
    .from("autonomous_actions")
    .select("amount_cents")
    .eq("user_id", user_id)
    .eq("fired_on_utc", today)
    .in("outcome", ["dispatched", "committed"]);
  if (error) {
    console.error("[autonomy] sumTodaySpent failed:", error.message);
    return 0;
  }
  let sum = 0;
  for (const r of data ?? []) {
    const n = (r as { amount_cents?: number }).amount_cents;
    if (typeof n === "number") sum += n;
  }
  return sum;
}

function checkTier(
  tier: string,
  amount_cents: number,
):
  | { ok: true }
  | { ok: false; reason: "always_ask" | "over_tier_threshold"; detail?: string } {
  if (tier === "auto") return { ok: true };
  if (tier === "always_ask") return { ok: false, reason: "always_ask" };
  if (tier.startsWith("ask_if_over:")) {
    const raw = tier.slice("ask_if_over:".length);
    const threshold = parseInt(raw, 10);
    if (!Number.isFinite(threshold) || threshold < 0) {
      return { ok: false, reason: "always_ask", detail: `malformed tier: ${tier}` };
    }
    if (amount_cents < threshold) return { ok: true };
    return {
      ok: false,
      reason: "over_tier_threshold",
      detail: `amount=${amount_cents}c, threshold=${threshold}c`,
    };
  }
  // Unknown tier — default deny.
  return { ok: false, reason: "always_ask", detail: `unknown tier: ${tier}` };
}

export function isValidTier(t: string): boolean {
  if (t === "always_ask" || t === "auto") return true;
  if (t.startsWith("ask_if_over:")) {
    const raw = t.slice("ask_if_over:".length);
    const n = parseInt(raw, 10);
    return Number.isFinite(n) && n >= 0 && String(n) === raw;
  }
  return false;
}

function toAutonomy(row: Record<string, unknown>): UserAutonomy {
  return {
    user_id: String(row.user_id),
    tiers:
      row.tiers && typeof row.tiers === "object"
        ? (row.tiers as Record<string, string>)
        : {},
    daily_cap_cents: Number(row.daily_cap_cents ?? 0),
    kill_switch_until: (row.kill_switch_until as string) ?? null,
    updated_at: String(row.updated_at),
  };
}

/**
 * Known tool-kind buckets. When we add new tool classes (e.g., 'ride_book'
 * once a ride-share agent ships), extend here and the /autonomy UI picks
 * it up automatically. Keeping the list explicit means an unexpected
 * tool_name can't sneak into autonomy without a code change.
 */
export const KNOWN_TOOL_KINDS = [
  "food_order",
  "flight_book",
  "hotel_book",
  "restaurant_reserve",
  "ride_book",
] as const;
export type KnownToolKind = (typeof KNOWN_TOOL_KINDS)[number];

/**
 * Best-effort tool_name → tool_kind mapping. We don't stuff this into
 * the manifest because it's a consumer-side policy concept, not a
 * publisher concern. Any tool_name not matched here is treated as
 * its own kind (and therefore defaults to always_ask until the user
 * sets a tier).
 */
export function toolKindFor(tool_name: string): string {
  if (tool_name.startsWith("food_") && tool_name.endsWith("_order")) return "food_order";
  if (tool_name.startsWith("food_place")) return "food_order";
  if (tool_name.startsWith("flight_book")) return "flight_book";
  if (tool_name.startsWith("hotel_book") || tool_name.startsWith("hotel_reserve")) return "hotel_book";
  if (tool_name.startsWith("restaurant_reserve") || tool_name.startsWith("restaurant_book")) return "restaurant_reserve";
  if (tool_name.startsWith("ride_") || tool_name.includes("_ride_")) return "ride_book";
  return tool_name; // unknown → each tool name is its own kind
}
