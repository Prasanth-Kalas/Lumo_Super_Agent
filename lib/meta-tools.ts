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
];
