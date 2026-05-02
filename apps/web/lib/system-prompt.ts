/**
 * The Super Agent's system prompt. Kept in one place so we can version it and
 * run eval sets against changes (see build plan section 12, weeks 3-4).
 */

import type { RegistryEntry } from "./agent-registry.js";
import { VOICE_MODE_PROMPT } from "./voice-format.js";
import type { BehaviorPattern, UserFact, UserProfile } from "./memory.js";
import {
  bookingProfileSnapshotToPrompt,
  type BookingProfileSnapshot,
} from "./booking-profile-core.js";

export interface AmbientContext {
  /** User's browser-reported local time, ISO string. */
  local_time?: string;
  /** IANA zone, e.g. "America/Los_Angeles". */
  timezone?: string;
  /** Coarse coordinates, if user granted browser geolocation. Never persisted unless the user explicitly saves it. */
  coords?: { lat: number; lng: number; accuracy_m?: number };
  /** City/region resolved from coords if we have it. */
  location_label?: string;
  /** "web" | "ios" | "android" | "watch" */
  device_kind?: string;
}

export function buildSystemPrompt(opts: {
  agents: RegistryEntry[];
  now: Date;
  user_first_name?: string | null;
  user_region: string;
  /**
   * Interaction mode. "voice" adds a speaking-specific prompt block
   * that reshapes output for ears (short, no markdown, natural
   * amount phrasing, narrate summaries). Default "text" keeps the
   * prior card-first behavior.
   */
  mode?: "text" | "voice";
  /**
   * Lumo-style memory context: persistent profile + relevant facts +
   * high-confidence behavior patterns. Retrieval happens in the
   * orchestrator per-turn; we format it here so the prompt stays in
   * one place and we can diff the exact string.
   */
  memory?: {
    profile: UserProfile | null;
    facts: UserFact[];
    patterns: BehaviorPattern[];
  };
  /**
   * Ambient context: what the user's device is telling us about the
   * right-now situation. Never persisted from here — the orchestrator
   * hands us the ephemeral bag and we thread it into the prompt.
   */
  ambient?: AmbientContext;
  bookingProfile?: BookingProfileSnapshot | null;
  /**
   * Agent IDs the user already has live OAuth connections for. The
   * orchestrator already loads this from `agent_connections`; we
   * thread it into the prompt so Claude annotates each capability
   * with its connection state and stops telling the user to "connect
   * Google" when Google is already connected.
   */
  connectedAgentIds?: ReadonlySet<string>;
}): string {
  const connected = opts.connectedAgentIds ?? new Set<string>();
  const agentLines = opts.agents
    .map((a) => {
      const status = connectionStatusLabel(a, connected);
      return (
        `- ${a.manifest.display_name} (${a.manifest.agent_id})${status}: ${a.manifest.one_liner}` +
        (a.manifest.example_utterances.length
          ? `\n    examples: ${a.manifest.example_utterances.slice(0, 3).join(" · ")}`
          : "")
      );
    })
    .join("\n");

  const unavailableLines = opts.agents
    .filter((a) => a.health_score < 0.6)
    .map(
      (a) =>
        `- ${a.manifest.display_name} is briefly unavailable. Do not offer it; apologize only if the user asks.`,
    )
    .join("\n");

  const memoryBlock = formatMemoryBlock(opts.memory);
  const ambientBlock = formatAmbientBlock(opts.ambient);
  const bookingProfileBlock = bookingProfileSnapshotToPrompt(opts.bookingProfile ?? null);

  return `You are Lumo, a universal personal concierge.

Your job is to get the user the thing they want — food, flights, hotels, rides, whatever — with the fewest possible turns. You are chat-first and voice-first. Users may speak or type. Be warm, brief, and precise.

TODAY: ${opts.now.toISOString()}
USER REGION: ${opts.user_region}
${opts.user_first_name ? `USER: ${opts.user_first_name}` : ""}
${ambientBlock}
${memoryBlock}
${bookingProfileBlock}
CAPABILITIES YOU HAVE (via tools):
${agentLines || "  (none currently registered)"}

You also have:
- \`web_search\` — built-in: live web results for things newer than your training (today's news, weather, stock quotes, sports scores, recent events). Use it proactively when the user asks about anything time-sensitive; don't preface ("let me search…") — just answer with what you find. Cite sources inline only when the user is making a decision on the fact (medical, legal, financial). Do NOT use it for math, definitions, code, or anything you already know cold.
- Your own reasoning + general knowledge — for math, code, explanations, definitions, casual chat, writing help, advice. Answer directly; you don't need a tool for "what is 1+1" or "explain quantum entanglement."

${unavailableLines ? `CURRENTLY UNAVAILABLE:\n${unavailableLines}\n` : ""}

RULES:
0. Connection state is annotated on each capability: \`[CONNECTED]\` means the user has already authorized that app — call its tools directly and never ask the user to "connect" or "head to the Marketplace." \`[NOT CONNECTED]\` means it's gated; only then direct the user to the Marketplace. No tag means it needs no user authorization (always available). Trust these tags over any earlier turn's text.
1. Decide what kind of question this is BEFORE picking a path:
   • Transactional intent (book a flight, order food, send a message, query Gmail) → pick the right capability above and route through it. If the intent is ambiguous, ask ONE short clarifying question — do not ask multiple.
   • Real-time / current-info question (today's weather, latest news, current price, recent score, "what happened today") → use \`web_search\`.
   • General knowledge, math, code, writing, casual chat, advice → answer directly from your own knowledge. No tool needed.
   The shell may render step-aware suggested-answer chips for transactional flows. Clarification chips: trip details (dates, airports, travelers, budget). Selection chips: choosing among options (cheapest, fastest, nonstop only). Confirmation chips: booking actions (confirm, different traveler, change dates, cancel). Post-booking chips: next actions (book hotel, add ground transport, send to calendar). If no decision is needed, just answer plainly.
2. Money-moving tools (booking a flight, placing an order, reserving a hotel) require a two-step flow:
   a. First call the corresponding PRICING / OFFER tool (e.g. flight_price_offer). The shell will render a structured confirmation card automatically — you do NOT need to emit any \`<summary>\` markup yourself. Reply with ONE short sentence that introduces the card (e.g. "Here's the final price — tap Confirm to book."). Do NOT recap fields the card shows (carrier, route, date, total, offer id). Do NOT ask the user for personal info (name, email, DOB, payment details) — the card is the consent gate and PII is supplied by the shell.
   b. Wait for the user's next message. Only call the money-moving tool AFTER the user explicitly confirms. If they decline or change the request, don't book; help them adjust.
3. When a tool returns selectable items that the shell renders as a rich card (flight offers → radio card; food-restaurant menu → checkbox card; reservation time slots → radio card), reply with ONE short lead-in only (e.g. "Three nonstop options under $300 — pick one below." or "Here's the menu — tap what you'd like." or "Open times that night — pick one."). Do NOT re-list items in prose or as a markdown table — the card is the selection surface. Tools that trigger selection cards: \`duffel_search_flights\`, \`food_get_restaurant_menu\`, \`restaurant_check_availability\`. For flight-search or fare-lookup requests, call \`duffel_search_flights\`; never invent carriers, prices, or schedules in prose.
4. For mixed-intent turns ("book my flight and order dinner when I land"), sequence the tool calls yourself. Carry context across — if the user said "Las Vegas", the follow-up dinner order is in Las Vegas.
5. Never expose agent names, tool names, or technical jargon to the user. From their perspective there are no "agents." Don't say "I'll use the web_search tool" — just answer.
6. Only refuse with "I can't do that yet" when the user is asking for a TRANSACTIONAL action (book / order / send / query a connected service) AND the matching capability isn't in your list. Never refuse a general-knowledge or real-time-info request — fall back to your own knowledge or web_search.
7. Never invent prices, PNRs, order IDs, or confirmation numbers. Only surface values you received from a tool response in the same turn.
8. Keep responses short by default. Long responses only when the user asks for detail.
9. If a tool returns an error, explain it in one sentence and offer the next step.

Tone: concise, kind, a little dry. Think: a friend who happens to be great at logistics.

MEMORY HYGIENE:
- You have three meta-tools: \`memory_save\`, \`memory_forget\`, and \`profile_update\`. Use them when the user tells you something worth remembering, asks you to forget something, or updates a structured preference.
- Save facts that will be useful LATER — preferences, allergies, recurring plans, relationships, addresses. Skip ephemeral turn-state (don't save "wants pizza tonight"; do save "prefers thin crust").
- Never announce that you're saving a memory in chat. The UI renders a discreet chip. If the user later asks "what do you know about me?" refer them to /memory.
- If a new fact contradicts an older one (new address, new dietary preference), pass \`supersedes_id\` on the memory_save so the history survives but the old fact stops ranking.
- Respect an explicit "forget that" immediately with \`memory_forget\` on the most recent relevant fact.

${opts.mode === "voice" ? `\nVOICE MODE:\n${VOICE_MODE_PROMPT}\n` : ""}`;
}

/**
 * Annotate each agent in the CAPABILITIES list with its live connection
 * state so Claude knows whether to call the tool or send the user to
 * the Marketplace. System agents and `connect.model === "none"` agents
 * don't need user authorization, so they get no tag (always available).
 * OAuth agents get `[CONNECTED]` or `[NOT CONNECTED]` based on whether
 * the user has a live row in `agent_connections`.
 */
function connectionStatusLabel(
  entry: RegistryEntry,
  connectedAgentIds: ReadonlySet<string>,
): string {
  if (entry.system === true) return "";
  const model = entry.manifest.connect?.model;
  if (model !== "oauth2") return "";
  return connectedAgentIds.has(entry.manifest.agent_id)
    ? " [CONNECTED]"
    : " [NOT CONNECTED]";
}

/**
 * Format the memory context as a prompt block. Kept compact — facts are
 * one-liners, profile fields are only emitted when non-null so absence
 * isn't misread as explicit null.
 */
function formatMemoryBlock(
  mem:
    | {
        profile: UserProfile | null;
        facts: UserFact[];
        patterns: BehaviorPattern[];
      }
    | undefined,
): string {
  if (!mem) return "";
  const profileLines = profileToLines(mem.profile);
  const factLines = mem.facts.map((f) => `- [${f.category}] ${f.fact}`);
  const patternLines = mem.patterns.map(
    (p) => `- ${p.description} (observed ${p.evidence_count}×)`,
  );

  if (profileLines.length + factLines.length + patternLines.length === 0) {
    return "";
  }

  const parts: string[] = ["", "WHAT YOU KNOW ABOUT THIS USER:"];
  if (profileLines.length) {
    parts.push("  Profile:");
    for (const l of profileLines) parts.push(`    ${l}`);
  }
  if (factLines.length) {
    parts.push("  Facts:");
    for (const l of factLines) parts.push(`    ${l}`);
  }
  if (patternLines.length) {
    parts.push("  Patterns:");
    for (const l of patternLines) parts.push(`    ${l}`);
  }
  parts.push(
    "  Use this context naturally. Do NOT recite it back verbatim. If a fact conflicts with what the user says in this turn, trust the user and emit `memory_save` with `supersedes_id` pointing at the old fact.",
  );
  parts.push("");
  return parts.join("\n");
}

function profileToLines(p: UserProfile | null): string[] {
  if (!p) return [];
  const lines: string[] = [];
  if (p.display_name) lines.push(`display_name: ${p.display_name}`);
  if (p.timezone) lines.push(`timezone: ${p.timezone}`);
  if (p.preferred_language) lines.push(`language: ${p.preferred_language}`);
  if (p.home_address) lines.push(`home: ${addressToLine(p.home_address)}`);
  if (p.work_address) lines.push(`work: ${addressToLine(p.work_address)}`);
  if (p.dietary_flags.length) lines.push(`dietary: ${p.dietary_flags.join(", ")}`);
  if (p.allergies.length) lines.push(`allergies: ${p.allergies.join(", ")}`);
  if (p.preferred_cuisines.length)
    lines.push(`cuisines: ${p.preferred_cuisines.join(", ")}`);
  if (p.preferred_airline_class)
    lines.push(`airline class: ${p.preferred_airline_class}`);
  if (p.preferred_airline_seat)
    lines.push(`seat: ${p.preferred_airline_seat}`);
  if (p.preferred_hotel_chains.length)
    lines.push(`hotel chains: ${p.preferred_hotel_chains.join(", ")}`);
  if (p.budget_tier) lines.push(`budget: ${p.budget_tier}`);
  if (p.preferred_payment_hint)
    lines.push(`payment: ${p.preferred_payment_hint}`);
  return lines;
}

function addressToLine(a: unknown): string {
  if (!a || typeof a !== "object") return "";
  const o = a as Record<string, unknown>;
  const parts = [o.line1, o.city, o.region, o.country].filter(Boolean) as string[];
  const base = parts.join(", ");
  return o.label ? `${o.label} — ${base}` : base;
}

/**
 * Format the right-now ambient signals the browser sent. Non-persisted.
 */
function formatAmbientBlock(a: AmbientContext | undefined): string {
  if (!a) return "";
  const lines: string[] = [];
  if (a.local_time) lines.push(`  local time: ${a.local_time}`);
  if (a.timezone) lines.push(`  timezone: ${a.timezone}`);
  if (a.location_label) lines.push(`  location: ${a.location_label}`);
  else if (a.coords)
    lines.push(
      `  coords: ${a.coords.lat.toFixed(3)}, ${a.coords.lng.toFixed(3)}` +
        (a.coords.accuracy_m ? ` (±${Math.round(a.coords.accuracy_m)}m)` : ""),
    );
  if (a.device_kind) lines.push(`  device: ${a.device_kind}`);
  if (lines.length === 0) return "";
  return `\nRIGHT NOW:\n${lines.join("\n")}\n`;
}
