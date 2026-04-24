/**
 * Meta-tools — Claude-callable tools that are NOT dispatched to a
 * downstream agent. They run inline in the orchestrator loop and
 * operate on the Super Agent's own state.
 *
 * Three tools today:
 *
 *   memory_save      — persist a free-text fact about the user
 *   memory_forget    — soft-delete a previously-saved fact by id
 *   profile_update   — merge-patch the structured user_profile row
 *
 * Why they're meta:
 *   - There's no remote agent to route to; target is our own Postgres.
 *   - They must NOT go through the money-gate or PII-filter logic.
 *   - Failure is local and loud (we log + surface a generic error);
 *     we don't need circuit-breaker semantics.
 *
 * The orchestrator intercepts any tool_use whose name starts with a
 * known meta prefix, executes it directly against lib/memory, and
 * synthesizes a DispatchOutcome-shaped result for the Claude tool_result
 * block. That keeps the rest of the loop (logging, toolCalls trace,
 * result→Claude round-trip) identical for meta vs dispatched tools.
 */

import type Anthropic from "@anthropic-ai/sdk";

// ──────────────────────────────────────────────────────────────────────────
// Tool definitions (JSON Schema shape Anthropic expects)
// ──────────────────────────────────────────────────────────────────────────

export const META_TOOL_NAMES = [
  "memory_save",
  "memory_forget",
  "profile_update",
  "intent_create",
  "intent_update",
  "intent_delete",
] as const;
export type MetaToolName = (typeof META_TOOL_NAMES)[number];

export function isMetaToolName(name: string): name is MetaToolName {
  return (META_TOOL_NAMES as readonly string[]).includes(name);
}

/**
 * Tools exposed to Claude. Kept as a plain array so the orchestrator
 * can concat onto the registry bridge's tools list in one line.
 *
 * The input_schema shapes are deliberately tight — over-permissive
 * schemas invite Claude to invent fields, under-permissive ones force
 * it to hack around the model. Lock these down together.
 */
export const META_TOOLS: Anthropic.Tool[] = [
  {
    name: "memory_save",
    description:
      "Save a free-text fact about the user so Lumo can use it in future turns. Call this " +
      "when the user tells you something worth remembering long-term (preferences, addresses, " +
      "allergies, relationships, routines). Skip ephemeral turn-state. NEVER announce the save " +
      "to the user — the UI surfaces it on its own. If this fact replaces an older one the user " +
      "had, pass supersedes_id with that fact's id.",
    input_schema: {
      type: "object",
      properties: {
        fact: {
          type: "string",
          minLength: 3,
          maxLength: 2000,
          description:
            "The fact, written in third person as if Lumo is noting it about the user. " +
            "Example: 'Prefers aisle seats on flights longer than 3 hours.'",
        },
        category: {
          type: "string",
          enum: [
            "preference",
            "identity",
            "habit",
            "location",
            "constraint",
            "context",
            "milestone",
            "other",
          ],
          description:
            "Bucket for the /memory UI. Use 'constraint' for allergies/dietary limits, " +
            "'location' for home/work/favorites, 'context' ONLY for short-lived multi-day " +
            "situations (e.g., 'traveling in Japan next week').",
        },
        confidence: {
          type: "number",
          minimum: 0,
          maximum: 1,
          description:
            "0-1. Use 1.0 when the user stated this explicitly; 0.6-0.8 when you inferred " +
            "from a strong signal; below 0.6 is probably not worth saving at all.",
        },
        supersedes_id: {
          type: ["string", "null"],
          description:
            "Optional: id of an older fact that this one replaces. Retrieval scores the new " +
            "fact higher; the old one stays in the DB for history.",
        },
      },
      required: ["fact", "category"],
    },
  },
  {
    name: "memory_forget",
    description:
      "Soft-delete a fact the user asked you to forget. Only call this when the user gave an " +
      "explicit instruction like 'forget that' or 'that's not right anymore'. The fact is " +
      "recoverable for 30 days via /memory.",
    input_schema: {
      type: "object",
      properties: {
        fact_id: {
          type: "string",
          description: "The id of the fact to forget (as surfaced in WHAT YOU KNOW ABOUT THIS USER).",
        },
        reason: {
          type: "string",
          description: "One-sentence reason for the delete — for audit.",
        },
      },
      required: ["fact_id"],
    },
  },
  {
    name: "profile_update",
    description:
      "Patch the structured user_profile row. Use this for fields that have obvious shape " +
      "(home address, dietary flags, preferred airline class, timezone). Pass ONLY the fields " +
      "you want to change; omitted fields are left alone. Explicit null clears a field.",
    input_schema: {
      type: "object",
      properties: {
        display_name: { type: ["string", "null"] },
        timezone: {
          type: ["string", "null"],
          description: "IANA zone, e.g. 'America/Los_Angeles'.",
        },
        preferred_language: { type: ["string", "null"] },
        home_address: {
          type: ["object", "null"],
          description:
            "{ label, line1, city, region, country, postal_code, coords: { lat, lng } } — any subset.",
        },
        work_address: { type: ["object", "null"] },
        dietary_flags: {
          type: "array",
          items: { type: "string" },
          description:
            "Set semantics — pass the FULL list you want stored, not a delta. e.g. ['vegetarian','gluten_free'].",
        },
        allergies: {
          type: "array",
          items: { type: "string" },
        },
        preferred_cuisines: {
          type: "array",
          items: { type: "string" },
        },
        preferred_airline_class: {
          type: ["string", "null"],
          enum: ["economy", "premium_economy", "business", "first", null],
        },
        preferred_airline_seat: {
          type: ["string", "null"],
          enum: ["aisle", "window", "middle", "any", null],
        },
        preferred_hotel_chains: {
          type: "array",
          items: { type: "string" },
        },
        budget_tier: {
          type: ["string", "null"],
          enum: ["budget", "standard", "premium", null],
        },
      },
      // No required fields — every call is a partial patch.
      required: [],
    },
  },
  {
    name: "intent_create",
    description:
      "Save a standing intent (a recurring routine) so Lumo fires it on a schedule. Use this " +
      "when the user says things like 'every Friday at 6pm, book me a bike ride' or 'on flight " +
      "days, order a car 2 hours before'. Keep the description user-friendly — Lumo will " +
      "surface it on /intents and in the notification that fires when it's due. For MVP, " +
      "firing creates a notification the user confirms; Lumo does NOT auto-dispatch actions. " +
      "If you can express the trigger as 5-field cron (minute hour dom month dow, * wildcards, " +
      "comma lists), do it. Otherwise leave the schedule_cron blank and ask the user to " +
      "clarify — do NOT invent.",
    input_schema: {
      type: "object",
      properties: {
        description: {
          type: "string",
          minLength: 6,
          maxLength: 500,
          description: "Human-readable description of the routine.",
        },
        schedule_cron: {
          type: "string",
          description:
            "5-field cron. Examples: '0 18 * * 5' = every Friday 6pm; '30 9 * * 1,2,3,4,5' = 9:30am weekdays.",
        },
        timezone: {
          type: "string",
          description: "IANA zone the cron is interpreted in. Default 'UTC'. Prefer the user's timezone if known.",
        },
        guardrails: {
          type: "object",
          description:
            "Optional predicates the evaluator checks before firing. Shape is open-ended; known keys: max_spend_cents, weather_min_temp_f, require_confirm (default true).",
        },
        action_plan: {
          type: "object",
          description:
            "Optional shape describing WHAT to do when fired. For MVP, leave blank or pass { tool_sequence: [...] } — the evaluator notifies the user either way.",
        },
      },
      required: ["description", "schedule_cron"],
    },
  },
  {
    name: "intent_update",
    description:
      "Edit a standing intent in place — toggle enabled, change the schedule, update the description. " +
      "Use this when the user says 'pause my Friday routine' or 'move bike ride to 7pm'.",
    input_schema: {
      type: "object",
      properties: {
        intent_id: { type: "string" },
        description: { type: "string" },
        schedule_cron: { type: "string" },
        timezone: { type: "string" },
        guardrails: { type: "object" },
        action_plan: { type: "object" },
        enabled: { type: "boolean" },
      },
      required: ["intent_id"],
    },
  },
  {
    name: "intent_delete",
    description:
      "Permanently delete a standing intent. Use this only when the user explicitly says they don't want the routine anymore. Prefer intent_update with enabled=false for soft pauses.",
    input_schema: {
      type: "object",
      properties: {
        intent_id: { type: "string" },
      },
      required: ["intent_id"],
    },
  },
];
