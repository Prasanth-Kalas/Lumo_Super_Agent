export interface AssistantSuggestion {
  id: string;
  label: string;
  value: string;
}

export interface AssistantSuggestionsFrameValue {
  kind: "assistant_suggestions";
  turn_id: string;
  suggestions: AssistantSuggestion[];
}

export type PlanningStep =
  | "clarification"
  | "selection"
  | "confirmation"
  | "post_booking";

export interface BuildAssistantSuggestionsInput {
  turnId: string;
  assistantText: string;
  planningStep?: PlanningStep;
  latestUserMessage?: string;
  now?: Date;
  userRegion?: string;
}

export function buildAssistantSuggestions(
  input: BuildAssistantSuggestionsInput,
): AssistantSuggestionsFrameValue | null {
  const text = normalizeText(input.assistantText);
  const planningStep = input.planningStep ?? "clarification";
  if (!needsUserDecision(text, planningStep)) return null;

  const now = input.now ?? new Date();
  const latestUser = normalizeText(input.latestUserMessage ?? "");
  const candidates = suggestionsForPlanningStep({
    planningStep,
    text,
    latestUser,
    now,
    userRegion: input.userRegion,
  });

  const suggestions = dedupeSuggestions(candidates ?? []).slice(0, 4);
  if (suggestions.length < 2) return null;

  return {
    kind: "assistant_suggestions",
    turn_id: input.turnId,
    suggestions: suggestions.map((suggestion, index) => ({
      id: `s${index + 1}`,
      label: suggestion.label,
      value: suggestion.value,
    })),
  };
}

function suggestionsForPlanningStep(input: {
  planningStep: PlanningStep;
  text: string;
  latestUser: string;
  now: Date;
  userRegion?: string;
}): SuggestionSeed[] | null {
  if (input.planningStep === "clarification") {
    if (asksForFreeTextIdentity(input.text)) return null;
    return (
      dateSuggestions(input.text, input.now) ??
      airportSuggestions(input.text, input.latestUser, input.userRegion) ??
      tripShapeSuggestions(input.text) ??
      travelerSuggestions(input.text) ??
      budgetSuggestions(input.text) ??
      comfortSuggestions(input.text)
    );
  }
  if (input.planningStep === "selection") {
    return selectionSuggestions(input.text);
  }
  if (input.planningStep === "confirmation") {
    return confirmationSuggestions(input.text);
  }
  return postBookingSuggestions(input.text);
}

function needsUserDecision(text: string, planningStep: PlanningStep): boolean {
  if (planningStep === "clarification") {
    return looksLikeClarificationQuestion(text);
  }
  if (planningStep === "selection") {
    return /\b(pick|choose|select|option|offer|offers|which|nonstop|cheapest|fastest)\b/i.test(text);
  }
  if (planningStep === "confirmation") {
    return /\b(confirm|book|booking|final price|ready|tap|traveler|payment|change|cancel)\b/i.test(text);
  }
  return /\b(booked|confirmed|confirmation|next|hotel|ground|transport|calendar|receipt)\b/i.test(text);
}

function looksLikeClarificationQuestion(text: string): boolean {
  if (!text.includes("?")) return false;
  return /\b(pick|choose|tell me|what|which|when|how many|would you|should i|do you want|works)\b/i.test(text);
}

function asksForFreeTextIdentity(text: string): boolean {
  return /\b(full name|legal name|traveler names?|passenger names?|passport|date of birth|dob)\b/i.test(text);
}

function dateSuggestions(text: string, now: Date): SuggestionSeed[] | null {
  if (!/\b(date|dates|when|return date|weekend|travel window)\b/i.test(text)) {
    return null;
  }
  const firstWeekend = nextWeekend(now, 1);
  const secondWeekend = nextWeekend(now, 2);
  const memorial = memorialDayWeekend(now.getUTCFullYear());
  const seeds: SuggestionSeed[] = [
    {
      label: `Next weekend (${formatRange(firstWeekend.start, firstWeekend.end, true)})`,
      value: `${formatDateValue(firstWeekend.start)} to ${formatDateValue(firstWeekend.end)}`,
    },
    {
      label: `In 2 weeks (${formatRange(secondWeekend.start, secondWeekend.end, true)})`,
      value: `${formatDateValue(secondWeekend.start)} to ${formatDateValue(secondWeekend.end)}`,
    },
  ];
  if (memorial.start.getTime() > now.getTime()) {
    seeds.push({
      label: "Memorial Day weekend",
      value: `${formatDateValue(memorial.start)} to ${formatDateValue(memorial.end)}`,
    });
  } else {
    const midJune = new Date(Date.UTC(now.getUTCFullYear(), 5, 12));
    seeds.push({
      label: `Mid-June (${formatRange(midJune, addDays(midJune, 2), true)})`,
      value: `${formatDateValue(midJune)} to ${formatDateValue(addDays(midJune, 2))}`,
    });
  }
  return seeds;
}

function airportSuggestions(
  text: string,
  latestUser: string,
  userRegion?: string,
): SuggestionSeed[] | null {
  if (!/\b(airport|origin|departure|depart|from where|which city|city should i use)\b/i.test(text)) {
    return null;
  }
  const haystack = `${text} ${latestUser} ${userRegion ?? ""}`.toLowerCase();
  if (/\b(chicago|chi)\b/.test(haystack)) {
    return [
      { label: "Chicago O'Hare (ORD)", value: "Depart from Chicago O'Hare (ORD)" },
      { label: "Chicago Midway (MDW)", value: "Depart from Chicago Midway (MDW)" },
      { label: "Use either Chicago airport", value: "Depart from either ORD or MDW, whichever has the better option" },
    ];
  }
  if (/\b(new york|nyc|manhattan|brooklyn)\b/.test(haystack)) {
    return [
      { label: "JFK", value: "Depart from New York JFK" },
      { label: "LaGuardia (LGA)", value: "Depart from LaGuardia (LGA)" },
      { label: "Newark (EWR)", value: "Depart from Newark (EWR)" },
    ];
  }
  if (/\b(sf|sfo|san francisco|bay area)\b/.test(haystack)) {
    return [
      { label: "San Francisco (SFO)", value: "Depart from San Francisco (SFO)" },
      { label: "Oakland (OAK)", value: "Depart from Oakland (OAK)" },
      { label: "San Jose (SJC)", value: "Depart from San Jose (SJC)" },
    ];
  }
  return null;
}

function travelerSuggestions(text: string): SuggestionSeed[] | null {
  if (!/\b(how many|passengers?|travelers?|people|party size)\b/i.test(text)) return null;
  return [
    { label: "Just me", value: "One traveler" },
    { label: "Two travelers", value: "Two travelers" },
    { label: "Family of four", value: "Four travelers" },
  ];
}

function tripShapeSuggestions(text: string): SuggestionSeed[] | null {
  if (!/\b(round ?trip|one-way|trip type|return flight)\b/i.test(text)) return null;
  return [
    { label: "Roundtrip, 1 passenger", value: "Roundtrip and one passenger" },
    { label: "One-way, 1 passenger", value: "One-way and one passenger" },
    { label: "Roundtrip, 2 passengers", value: "Roundtrip and two passengers" },
  ];
}

function budgetSuggestions(text: string): SuggestionSeed[] | null {
  if (!/\b(budget|price|spend|cap|limit|cheap|comfortable)\b/i.test(text)) return null;
  return [
    { label: "Keep it lean", value: "Optimize for the lowest reasonable price" },
    { label: "Mid-range", value: "Use a mid-range budget with a good comfort tradeoff" },
    { label: "No hard limit", value: "No hard budget limit; prioritize the best fit" },
  ];
}

function comfortSuggestions(text: string): SuggestionSeed[] | null {
  if (!/\b(cheapest|fastest|comfortable|optimi[sz]e|priority|prefer)\b/i.test(text)) return null;
  return [
    { label: "Cheapest", value: "Optimize for the cheapest options" },
    { label: "Fastest", value: "Optimize for the fastest options" },
    { label: "Most comfortable", value: "Optimize for comfort" },
  ];
}

function selectionSuggestions(text: string): SuggestionSeed[] | null {
  if (!/\b(pick|choose|select|option|offer|offers|which|nonstop|cheapest|fastest)\b/i.test(text)) {
    return null;
  }
  return [
    { label: "Cheapest", value: "Pick the cheapest option" },
    { label: "Fastest", value: "Pick the fastest option" },
    { label: "Nonstop only", value: "Show me nonstop options only" },
  ];
}

function confirmationSuggestions(text: string): SuggestionSeed[] | null {
  if (!/\b(confirm|book|booking|final price|ready|tap|traveler|payment|change|cancel)\b/i.test(text)) {
    return null;
  }
  return [
    { label: "Confirm booking", value: "Confirm booking" },
    { label: "Different traveler", value: "Use a different traveler" },
    { label: "Change dates", value: "Change dates" },
    { label: "Cancel", value: "Cancel" },
  ];
}

function postBookingSuggestions(text: string): SuggestionSeed[] | null {
  if (!/\b(booked|confirmed|confirmation|next|hotel|ground|transport|calendar|receipt)\b/i.test(text)) {
    return null;
  }
  return [
    { label: "Book hotel", value: "Book a hotel for this trip" },
    { label: "Add ground transport", value: "Add ground transport" },
    { label: "Send to calendar", value: "Send this booking to my calendar" },
  ];
}

interface SuggestionSeed {
  label: string;
  value: string;
}

function dedupeSuggestions(suggestions: SuggestionSeed[]): SuggestionSeed[] {
  const seen = new Set<string>();
  const out: SuggestionSeed[] = [];
  for (const suggestion of suggestions) {
    const label = suggestion.label.trim();
    const value = suggestion.value.trim();
    const key = `${label.toLowerCase()}::${value.toLowerCase()}`;
    if (!label || !value || seen.has(key)) continue;
    seen.add(key);
    out.push({ label, value });
  }
  return out;
}

function nextWeekend(now: Date, ordinal: 1 | 2): { start: Date; end: Date } {
  const date = utcDateOnly(now);
  const day = date.getUTCDay();
  const daysUntilSaturday = (6 - day + 7) % 7 || 7;
  const start = addDays(date, daysUntilSaturday + (ordinal - 1) * 7);
  return { start, end: addDays(start, 2) };
}

function memorialDayWeekend(year: number): { start: Date; end: Date } {
  const lastMayDay = new Date(Date.UTC(year, 4, 31));
  const mondayOffset = (lastMayDay.getUTCDay() + 6) % 7;
  const memorialDay = addDays(lastMayDay, -mondayOffset);
  return { start: addDays(memorialDay, -2), end: addDays(memorialDay, 2) };
}

function addDays(date: Date, days: number): Date {
  const copy = new Date(date.getTime());
  copy.setUTCDate(copy.getUTCDate() + days);
  return copy;
}

function utcDateOnly(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

function formatRange(start: Date, end: Date, compact = false): string {
  const sameMonth = start.getUTCMonth() === end.getUTCMonth();
  const month = monthName(start);
  const startDay = start.getUTCDate();
  const endText = sameMonth ? String(end.getUTCDate()) : `${monthName(end)} ${end.getUTCDate()}`;
  return compact ? `${month} ${startDay}-${endText}` : `${month} ${startDay} to ${endText}`;
}

function formatDateValue(date: Date): string {
  return `${monthName(date)} ${date.getUTCDate()}, ${date.getUTCFullYear()}`;
}

function monthName(date: Date): string {
  return new Intl.DateTimeFormat("en-US", {
    month: "long",
    timeZone: "UTC",
  }).format(date);
}

function normalizeText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}
