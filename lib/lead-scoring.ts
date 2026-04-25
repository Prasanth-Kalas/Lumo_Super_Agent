export interface LeadScore {
  score: number;
  reasons: string[];
  source: "heuristic" | "ml";
}

export interface MlClassifiedItem {
  label?: string;
  score?: number;
  reasons?: string[];
  above_threshold?: boolean;
}

const LEAD_KEYWORDS: Array<{ pattern: RegExp; reason: string; weight: number }> = [
  { pattern: /\b(partner(ship)?|collab(oration)?)\b/i, reason: "partnership", weight: 0.4 },
  { pattern: /\b(sponsor(ship)?|advertis(e|ing|ement))\b/i, reason: "sponsorship", weight: 0.4 },
  { pattern: /\b(podcast|interview|on your show|on my show)\b/i, reason: "podcast/interview", weight: 0.35 },
  { pattern: /\b(hire|hiring|join (your|our) team|career|role|position)\b/i, reason: "hiring", weight: 0.4 },
  { pattern: /\b(consult(ing|ant)?|advisory|advisor)\b/i, reason: "consulting", weight: 0.3 },
  { pattern: /\b(brand( deal)?|paid promo|paid post)\b/i, reason: "brand-deal", weight: 0.4 },
  { pattern: /\b(business email|reach out|in touch|email me|dm me|message me)\b/i, reason: "contact-request", weight: 0.25 },
  { pattern: /\b(invite|invited|invitation)\b/i, reason: "invitation", weight: 0.2 },
  { pattern: /@?[a-z0-9._-]+@[a-z0-9.-]+\.[a-z]{2,}/i, reason: "email-shared", weight: 0.35 },
];

export function scoreLeadHeuristic(text: string): LeadScore {
  let score = 0;
  const reasons: string[] = [];
  for (const k of LEAD_KEYWORDS) {
    if (k.pattern.test(text)) {
      score += k.weight;
      if (!reasons.includes(k.reason)) reasons.push(k.reason);
    }
  }
  if (text.length > 200) {
    score += 0.1;
    reasons.push("substantive-length");
  }
  if (text.length > 500) {
    score += 0.1;
    if (!reasons.includes("substantive-length")) reasons.push("substantive-length");
  }
  return { score: clampScore(score), reasons, source: "heuristic" };
}

export function mergeMlLeadScore(
  fallback: LeadScore,
  item: MlClassifiedItem | undefined,
): LeadScore {
  if (!item || typeof item.score !== "number" || !Number.isFinite(item.score)) {
    return fallback;
  }
  const reasons = Array.isArray(item.reasons)
    ? item.reasons.filter((reason): reason is string => typeof reason === "string" && reason.length > 0)
    : [];
  return {
    score: clampScore(item.score),
    reasons: reasons.length > 0 ? reasons : fallback.reasons,
    source: "ml",
  };
}

function clampScore(score: number): number {
  return Math.max(0, Math.min(1, Number(score.toFixed(3))));
}
