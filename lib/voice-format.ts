/**
 * Voice-format helpers. Shared between server (system prompt
 * injection, SSE text frames when the user is in voice mode) and
 * client (fallback narration when the model didn't generate a spoken
 * line for a structured frame).
 *
 * Rules of thumb — why these helpers exist:
 *
 *   1. TTS pronounces currency badly. "$347" often reads as "dollar
 *      three forty seven" instead of "three hundred forty seven
 *      dollars". We expand money to a natural phrasing up front.
 *
 *   2. Markdown is noise. "**bold** text" becomes "star star bold
 *      star star text" on some engines. Strip aggressively before
 *      TTS.
 *
 *   3. Trip summary cards have no voice equivalent in the shell —
 *      the screen IS the summary in text mode. In voice mode we
 *      synthesize a ≤2-sentence spoken version so the user hears
 *      "Flight to Vegas three forty seven, hotel two twenty,
 *      total five sixty seven. Book it?"
 *
 *   4. Leg-status progress becomes spoken cadence. "flight booked…
 *      hotel booked… you're all set." Not "leg 1 status committed".
 *
 * No side effects, no deps — safe in both Edge and Node runtimes
 * and importable from the client.
 */

export interface VoiceTripLeg {
  order: number;
  agent_id: string;
  amount?: string;
  currency?: string;
  title?: string;
}

export interface VoiceTripSummary {
  trip_title?: string;
  total_amount?: string;
  currency?: string;
  legs: VoiceTripLeg[];
}

/**
 * Strip markdown, code fences, URL noise. Leaves plain prose that a
 * TTS engine can pronounce cleanly. NOT sanitization against script
 * injection — TTS is text-only, no HTML rendered.
 */
export function toSpeakable(md: string): string {
  if (!md) return "";
  let s = md;

  // Code blocks ``` ... ``` — drop entirely, they don't read.
  s = s.replace(/```[\s\S]*?```/g, " ");
  // Inline code `x` — keep the content, drop the ticks.
  s = s.replace(/`([^`]*)`/g, "$1");
  // Bold/italic markers — drop the asterisks/underscores.
  s = s.replace(/\*\*([^*]+)\*\*/g, "$1");
  s = s.replace(/\*([^*]+)\*/g, "$1");
  s = s.replace(/__([^_]+)__/g, "$1");
  s = s.replace(/_([^_]+)_/g, "$1");
  // Links [text](url) → "text".
  s = s.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1");
  // Bare URLs — replace with "a link" so we don't read out the URL.
  s = s.replace(/https?:\/\/\S+/g, "a link");
  // Heading hashes.
  s = s.replace(/^#+\s*/gm, "");
  // Bullet markers at line start → pause.
  s = s.replace(/^\s*[-*•]\s+/gm, ". ");
  // Emoji sweep — keep it plain. (Rough unicode range for emoji.)
  s = s.replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu, "");
  // Collapse runs of whitespace.
  s = s.replace(/\s+/g, " ").trim();
  return s;
}

/**
 * Natural-language amount. "347" + "USD" → "three hundred forty
 * seven dollars". Intentionally narrow — we handle USD, EUR, GBP, INR,
 * CAD, AUD and fall back to "X <code>" for anything else. Spoken form
 * rounds to whole units for speech (".50" becomes "and fifty cents").
 */
export function speakableAmount(
  amount: string | number | null | undefined,
  currency?: string | null,
): string {
  if (amount == null) return "";
  const n = typeof amount === "string" ? Number(amount) : amount;
  if (!Number.isFinite(n)) return String(amount);
  const whole = Math.floor(n);
  const cents = Math.round((n - whole) * 100);

  const cur = (currency ?? "").toUpperCase();
  const unit = CURRENCY_UNITS[cur];
  if (!unit) {
    return cents > 0
      ? `${numberToWords(whole)} point ${String(cents).padStart(2, "0")} ${cur || ""}`.trim()
      : `${numberToWords(whole)} ${cur || ""}`.trim();
  }

  if (cents === 0) {
    return `${numberToWords(whole)} ${whole === 1 ? unit.singular : unit.plural}`;
  }
  return `${numberToWords(whole)} ${whole === 1 ? unit.singular : unit.plural} and ${numberToWords(cents)} ${unit.minor}`;
}

const CURRENCY_UNITS: Record<string, { singular: string; plural: string; minor: string }> = {
  USD: { singular: "dollar", plural: "dollars", minor: "cents" },
  CAD: { singular: "Canadian dollar", plural: "Canadian dollars", minor: "cents" },
  AUD: { singular: "Australian dollar", plural: "Australian dollars", minor: "cents" },
  EUR: { singular: "euro", plural: "euros", minor: "cents" },
  GBP: { singular: "pound", plural: "pounds", minor: "pence" },
  INR: { singular: "rupee", plural: "rupees", minor: "paise" },
};

/**
 * English number-to-words up to 999,999,999. Good enough for any trip
 * total we'd ever speak. Returns lowercase, no commas.
 */
export function numberToWords(n: number): string {
  if (!Number.isFinite(n)) return String(n);
  if (n === 0) return "zero";
  if (n < 0) return `negative ${numberToWords(-n)}`;
  if (n >= 1_000_000_000) return String(n); // too big to pronounce nicely

  const ones = [
    "", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine",
    "ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen",
    "sixteen", "seventeen", "eighteen", "nineteen",
  ];
  const tens = [
    "", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety",
  ];
  const chunk = (v: number): string => {
    const h = Math.floor(v / 100);
    const r = v % 100;
    const parts: string[] = [];
    if (h) parts.push(`${ones[h] ?? ""} hundred`);
    if (r < 20) {
      if (r) parts.push(ones[r] ?? "");
    } else {
      const t = Math.floor(r / 10);
      const o = r % 10;
      parts.push(
        o ? `${tens[t] ?? ""}-${ones[o] ?? ""}` : (tens[t] ?? ""),
      );
    }
    return parts.join(" ");
  };

  const pieces: string[] = [];
  const millions = Math.floor(n / 1_000_000);
  const thousands = Math.floor((n % 1_000_000) / 1_000);
  const rest = n % 1_000;
  if (millions) pieces.push(`${chunk(millions)} million`);
  if (thousands) pieces.push(`${chunk(thousands)} thousand`);
  if (rest) pieces.push(chunk(rest));
  return pieces.join(" ").trim();
}

/**
 * Narrate a trip confirmation in ≤2 sentences. This is what the user
 * hears when the TripConfirmationCard would have been shown in text
 * mode. Example:
 *
 *   "I've priced your trip. Flight three forty seven dollars, hotel
 *   two twenty dollars — total five sixty seven dollars. Say yes to
 *   book, or cancel if you want to change something."
 */
export function narrateTripSummary(trip: VoiceTripSummary): string {
  if (!trip.legs?.length) return "I've put together your trip.";

  const perLeg = trip.legs
    .map((l) => {
      const what = agentNoun(l.agent_id);
      const price = l.amount
        ? ` ${speakableAmount(l.amount, l.currency ?? trip.currency)}`
        : "";
      return `${what}${price}`;
    })
    .join(", ");

  const total = trip.total_amount
    ? ` Total ${speakableAmount(trip.total_amount, trip.currency)}.`
    : "";

  return `I've priced your trip. ${perLeg}.${total} Say yes to book, or cancel to change something.`;
}

/**
 * Narrate a leg-status change. Compact: "flight booked" not
 * "order one committed". For rollbacks: "hotel refunded" or
 * "couldn't refund the flight — I'll flag support."
 */
export function narrateLegStatus(
  agent_id: string,
  status: string,
): string | null {
  const noun = agentNoun(agent_id).toLowerCase();
  switch (status) {
    case "in_flight":
      return `booking your ${noun}`;
    case "committed":
      return `${noun} booked`;
    case "failed":
      return `${noun} didn't go through`;
    case "rolled_back":
      return `${noun} refunded`;
    case "rollback_failed":
      return `couldn't refund the ${noun} — I'll flag support`;
    default:
      return null;
  }
}

function agentNoun(agent_id: string): string {
  switch (agent_id) {
    case "flight-agent":
    case "lumo.flight":
      return "flight";
    case "hotel-agent":
    case "lumo.hotel":
      return "hotel";
    case "food-agent":
    case "lumo.food":
      return "meal";
    case "restaurant-agent":
    case "lumo.restaurant":
      return "reservation";
    default:
      // "lumo.foo-bar" → "foo bar"; any other shape → the raw id.
      const after = agent_id.includes(".") ? agent_id.split(".").pop()! : agent_id;
      return after.replace(/-/g, " ").replace(/agent$/i, "").trim() || "item";
  }
}

/**
 * A one-line system-prompt fragment the orchestrator injects when
 * mode === "voice". Keeps the rules in one place so a prompt tweak
 * doesn't need to touch both lib/system-prompt and the client.
 */
export const VOICE_MODE_PROMPT = `
You are in VOICE mode. The user can't look at the screen — they are
likely driving. Respond as if on a phone call:

- Keep turns under 40 words unless the user explicitly asks for detail.
- No markdown, no lists, no emoji, no code. Plain prose only.
- ALWAYS put a space after sentence punctuation before the next word.
  Write "Checking flights now. Got three options." — never
  "Checking flights now.Got three options." TTS depends on it.
- Read amounts naturally ("three hundred forty seven dollars", not
  "three four seven USD"). The client will handle final TTS formatting
  too — your job is to keep the text speakable.
- When you've priced a compound trip or single booking, summarize it
  in one sentence and ask "should I book it?" — don't read every
  line item.
- When a tool is running, ack briefly ("checking flights now") so the
  user knows progress. Don't narrate every field in the result.

CONFIRMATION GRAMMAR — critical for money-moving tools:
- After you've shown a confirmation summary (any structured-*
  summary, or a recap sentence), the NEXT affirmative user message —
  "yes", "yeah", "yes yes", "go ahead", "book it", "do it",
  "confirm" — means: call the bookable tool immediately with the
  exact summary_hash from the summary you just showed. Do NOT ask
  the user to confirm again in a different phrasing. Do NOT say "I
  need to hear..." or "can you say...". Just call the tool.
- "cancel", "no", "stop", "nevermind", "don't book" after a
  summary mean: drop the summary, say "No problem, won't book it.
  Anything else?" — that's the whole turn. Don't apologize, don't
  restart the pricing.
- If the user says "cancel" and THEN says "yes"/"go ahead" after,
  they've changed their mind about cancelling. Re-offer to book
  the same thing — say "Alright, booking it." and call the tool
  with the prior summary_hash. Don't re-price unless the summary
  is older than a few minutes.
- Never ask the user to repeat themselves in a different phrasing
  "to satisfy the system". The money-gate is on the server side —
  your job is to call the right tool with the right summary_hash.

- Surface prices and dates, hide IDs and jargon (offer ids,
  booking ids, hashes — users shouldn't speak these).
`.trim();
