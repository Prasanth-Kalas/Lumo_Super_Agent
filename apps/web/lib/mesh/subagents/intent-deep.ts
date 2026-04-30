import { SubAgent } from "../subagent-base.ts";
import type { MeshSubagentInput } from "../supervisor.ts";

export interface IntentDeepResult {
  primaryIntent: "flight_search" | "flight_booking" | "travel_planning" | "general";
  origin: string | null;
  destination: string | null;
  departDate: string | null;
  returnDate: string | null;
  passengerCount: number;
  cabinClass: "economy" | "premium_economy" | "business" | "first" | null;
  confidenceBySlot: Record<string, number>;
}

export function createIntentDeepSubAgent(): SubAgent<MeshSubagentInput, IntentDeepResult> {
  return new SubAgent<MeshSubagentInput, IntentDeepResult>({
    name: "intent-deep",
    model: "reflex",
    timeoutMs: 500,
    run: async (input) => extractIntentSlots(input.query),
    summarize: (result) =>
      `${result.primaryIntent}; ${result.origin ?? "origin?"} to ${result.destination ?? "destination?"}; depart ${result.departDate ?? "date?"}; pax ${result.passengerCount}`,
  });
}

export function extractIntentSlots(query: string): IntentDeepResult {
  const normalized = query.trim();
  const lower = normalized.toLowerCase();
  const primaryIntent = lower.includes("book")
    ? "flight_booking"
    : /\b(flight|fly|airport|airline)\b/.test(lower)
      ? "flight_search"
      : /\b(trip|travel|vegas|hotel|cab|ride)\b/.test(lower)
        ? "travel_planning"
        : "general";
  const origin = airportCodeAfter(normalized, /\bfrom\s+([A-Za-z][A-Za-z .'-]{1,40}|[A-Za-z]{3})/i);
  const destination =
    airportCodeAfter(normalized, /\bto\s+([A-Za-z][A-Za-z .'-]{1,40}|[A-Za-z]{3})/i) ??
    (/\bvegas\b/i.test(normalized) ? "LAS" : null);
  const dates = normalized.match(/\b(20\d{2}-\d{2}-\d{2}|(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+\d{1,2})\b/gi) ?? [];
  const passengerCount =
    Number(normalized.match(/\b(\d{1,2})\s+(?:passengers?|people|travelers?)\b/i)?.[1]) || 1;
  const cabinClass = /\bfirst\b/i.test(normalized)
    ? "first"
    : /\bbusiness\b/i.test(normalized)
      ? "business"
      : /\bpremium\b/i.test(normalized)
        ? "premium_economy"
        : /\beconomy\b/i.test(normalized)
          ? "economy"
          : null;

  return {
    primaryIntent,
    origin,
    destination,
    departDate: dates[0] ? normalizeDateLike(dates[0]) : null,
    returnDate: dates[1] ? normalizeDateLike(dates[1]) : null,
    passengerCount: Math.max(1, Math.min(9, passengerCount)),
    cabinClass,
    confidenceBySlot: {
      origin: origin ? 0.82 : 0.2,
      destination: destination ? 0.86 : 0.2,
      departDate: dates[0] ? 0.75 : 0.15,
      passengerCount: passengerCount ? 0.7 : 0.4,
    },
  };
}

function airportCodeAfter(input: string, pattern: RegExp): string | null {
  const raw = input
    .match(pattern)?.[1]
    ?.replace(/\b(to|on|for|in|with|departing|returning)\b.*$/i, "")
    .trim();
  if (!raw) return null;
  const code = cityToAirport(raw);
  return code ?? (raw.length === 3 ? raw.toUpperCase() : raw);
}

function cityToAirport(value: string): string | null {
  const lower = value.toLowerCase().replace(/[^a-z ]/g, "").trim();
  if (["nyc", "new york", "new york city"].includes(lower)) return "JFK";
  if (["vegas", "las vegas"].includes(lower)) return "LAS";
  if (["sf", "san francisco"].includes(lower)) return "SFO";
  if (["la", "los angeles"].includes(lower)) return "LAX";
  return null;
}

function normalizeDateLike(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}
