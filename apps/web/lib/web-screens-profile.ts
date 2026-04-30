/**
 * Pure helpers for the /profile editable surface. Pulled out of the
 * page component so the parsing rules can be unit-tested without
 * spinning up React.
 */

export const AIRLINE_CLASS_OPTIONS = [
  { value: "", label: "No preference" },
  { value: "economy", label: "Economy" },
  { value: "premium_economy", label: "Premium economy" },
  { value: "business", label: "Business" },
  { value: "first", label: "First" },
] as const;

export const AIRLINE_SEAT_OPTIONS = [
  { value: "", label: "No preference" },
  { value: "aisle", label: "Aisle" },
  { value: "window", label: "Window" },
] as const;

export const BUDGET_TIER_OPTIONS = [
  { value: "", label: "No preference" },
  { value: "budget", label: "Budget" },
  { value: "mid", label: "Mid-range" },
  { value: "premium", label: "Premium" },
  { value: "luxury", label: "Luxury" },
] as const;

/**
 * Parse a comma-separated tag input into a clean array. Trims, dedupes,
 * preserves order, drops empties, caps each entry at 60 chars and the
 * total at 25 entries (defensive — UserProfile.dietary_flags etc. are
 * arrays of short labels, not paragraphs).
 */
export function parseTagList(raw: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const piece of raw.split(",")) {
    const t = piece.trim().slice(0, 60);
    if (!t) continue;
    const k = t.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(t);
    if (out.length >= 25) break;
  }
  return out;
}

export function formatTagList(values: string[] | null | undefined): string {
  if (!values || values.length === 0) return "";
  return values.join(", ");
}

/**
 * Whitelist the keys the /profile page is allowed to PATCH. Anything
 * else in the body is dropped. Uses null sentinels so empty fields
 * clear the value rather than leaving stale data.
 */
export interface ProfilePatchInput {
  display_name?: string;
  timezone?: string;
  preferred_language?: string;
  preferred_airline_class?: string;
  preferred_airline_seat?: string;
  budget_tier?: string;
  dietary_flags?: string;
  allergies?: string;
  preferred_cuisines?: string;
  preferred_hotel_chains?: string;
}

export function buildProfilePatch(input: ProfilePatchInput): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  const stringFields: Array<keyof ProfilePatchInput> = [
    "display_name",
    "timezone",
    "preferred_language",
    "preferred_airline_class",
    "preferred_airline_seat",
    "budget_tier",
  ];
  for (const k of stringFields) {
    const v = input[k];
    if (typeof v === "string") {
      const trimmed = v.trim();
      patch[k] = trimmed.length === 0 ? null : trimmed;
    }
  }
  const tagFields: Array<keyof ProfilePatchInput> = [
    "dietary_flags",
    "allergies",
    "preferred_cuisines",
    "preferred_hotel_chains",
  ];
  for (const k of tagFields) {
    const v = input[k];
    if (typeof v === "string") {
      patch[k] = parseTagList(v);
    }
  }
  return patch;
}
