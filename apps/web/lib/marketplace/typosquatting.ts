/**
 * MARKETPLACE-1 anti-typosquatting checks.
 *
 * ADR-015 blocks reserved prefixes, Unicode confusables, and near-neighbour
 * agent ids against official/verified agents. The DB-backed route passes the
 * protected id list from marketplace_agents; tests can pass it directly.
 */

export type TyposquatReason =
  | "reserved_prefix"
  | "homoglyph"
  | "near_official"
  | "near_verified";

export type TyposquatResult =
  | { ok: true }
  | { ok: false; reason: TyposquatReason; neighbor?: string };

const RESERVED_PREFIXES = ["lumo-", "official-", "verified-"];

export interface ProtectedAgentId {
  agent_id: string;
  trust_tier: "official" | "verified" | "community" | "experimental";
}

export function checkTyposquat(
  candidateId: string,
  protectedIds: ProtectedAgentId[],
): TyposquatResult {
  const candidate = candidateId.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]{1,78}[a-z0-9]$/.test(candidate)) {
    return { ok: false, reason: "homoglyph" };
  }

  for (const prefix of RESERVED_PREFIXES) {
    if (candidate.startsWith(prefix)) {
      return { ok: false, reason: "reserved_prefix" };
    }
  }

  if (candidate !== candidate.normalize("NFKC") || containsNonAscii(candidate)) {
    return { ok: false, reason: "homoglyph" };
  }

  for (const protectedId of protectedIds) {
    const neighbour = protectedId.agent_id.trim().toLowerCase();
    if (!neighbour || neighbour === candidate) continue;
    const distance = levenshtein(candidate, neighbour);
    if (protectedId.trust_tier === "official" && distance < 3) {
      return { ok: false, reason: "near_official", neighbor: neighbour };
    }
    if (protectedId.trust_tier === "verified" && distance < 2) {
      return { ok: false, reason: "near_verified", neighbor: neighbour };
    }
  }

  return { ok: true };
}

export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  const previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  const current = new Array<number>(b.length + 1);

  for (let i = 1; i <= a.length; i++) {
    current[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const substitution =
        (previous[j - 1] ?? 0) + (a.charAt(i - 1) === b.charAt(j - 1) ? 0 : 1);
      current[j] = Math.min(
        (previous[j] ?? 0) + 1,
        (current[j - 1] ?? 0) + 1,
        substitution,
      );
    }
    for (let j = 0; j <= b.length; j++) previous[j] = current[j] ?? 0;
  }

  return previous[b.length] ?? 0;
}

function containsNonAscii(value: string): boolean {
  return /[^\x20-\x7e]/.test(value);
}
