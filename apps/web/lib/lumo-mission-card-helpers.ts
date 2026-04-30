/**
 * Pure helpers for the LumoMissionCard component. Extracted out of
 * the .tsx so unit tests can import and assert on them via Node's
 * `--experimental-strip-types` (which handles .ts but not .tsx).
 */

export interface ScopeSummaryInput {
  profile_fields_requested: string[];
}

/**
 * Condense a proposal's profile-fields list into a one-line phrase
 * the user can read at a glance. Matches the brief's example
 * ("Will see: name, email, payment method") and clamps long lists
 * to "first two + and N more".
 *
 * Empty list → "Won't access your profile" (positive framing — the
 * user is granting an explicit permission either way).
 */
export function scopeSummary(input: ScopeSummaryInput): string {
  const fields = input.profile_fields_requested;
  if (fields.length === 0) return "Won't access your profile";
  if (fields.length === 1) return `Will see: ${fields[0]}`;
  if (fields.length === 2) return `Will see: ${fields[0]} and ${fields[1]}`;
  if (fields.length === 3) {
    return `Will see: ${fields[0]}, ${fields[1]}, and ${fields[2]}`;
  }
  // 4+: surface the first two and a count for the rest.
  return `Will see: ${fields[0]}, ${fields[1]}, and ${fields.length - 2} more`;
}
