export interface MissionContextMessage {
  role: "user" | "assistant";
  content: string;
}

const CONTINUE_PREFIXES = [
  "continue planning this mission with approved apps",
  "continue planning this trip with approved apps",
  "yes, continue with available approved apps and skip unavailable marketplace capabilities for now",
];

const THIN_FOLLOWUP_PATTERNS = [
  /^(hello|hi|hey|yo)$/,
  /^(ok|okay|yes|yeah|yep|sure|continue|go ahead)$/,
  /^(thanks|thank you|got it|sounds good)$/,
  /^((i m|im) )?(still )?(waiting|waiting for it|waiting on it)$/,
  /^(yeah|yes|yep|ok|okay)\s+((i m|im) )?(still )?waiting\b/,
  /\bwaiting for (the )?(flight|flights|hotel|hotels|app|apps|results)\b/,
];

export function buildMissionContinueText(originalRequest: string): string {
  return `Continue planning this mission with approved apps: ${originalRequest.trim()}`;
}

export function selectMissionPlanningRequest(
  messages: MissionContextMessage[],
): string {
  const userMessages = messages
    .filter((message) => message.role === "user")
    .map((message) => message.content.trim())
    .filter(Boolean);
  const last = userMessages.at(-1) ?? "";
  if (!last) return "";

  const priorMission = findPriorMissionRequest(userMessages.slice(0, -1));
  const continued = extractMissionContinueRequest(last);
  if (continued) {
    if (isSubstantiveMissionRequest(continued)) return continued;
    return priorMission ?? continued;
  }

  if (priorMission && isThinMissionFollowup(last)) return priorMission;
  if (priorMission && isLikelyMissionSlotAnswer(last)) {
    return mergeMissionSlotAnswer(priorMission, last);
  }
  return last;
}

export function isMissionContinueApproval(request: string): boolean {
  const normalized = normalizeText(request);
  return (
    extractMissionContinueRequest(request) !== null ||
    normalized.includes("continue with the parts")
  );
}

function findPriorMissionRequest(messages: string[]): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const candidate = messages[i]?.trim() ?? "";
    const continued = extractMissionContinueRequest(candidate);
    const request = continued ?? candidate;
    if (isSubstantiveMissionRequest(request)) return request;
  }
  return null;
}

function extractMissionContinueRequest(input: string): string | null {
  const normalized = normalizeText(input);
  for (const prefix of CONTINUE_PREFIXES) {
    if (!normalized.startsWith(normalizeText(prefix))) continue;
    const colonIndex = input.indexOf(":");
    return colonIndex >= 0 ? input.slice(colonIndex + 1).trim() : "";
  }
  return null;
}

function isSubstantiveMissionRequest(input: string): boolean {
  const normalized = normalizeText(input);
  if (!normalized || isThinMissionFollowup(input)) return false;
  if (!isMarketplaceIntent(input)) return false;
  return (
    normalized.split(" ").length >= 2 ||
    /\b(vegas|flight|flights|hotel|hotels|cab|taxi|food|restaurant|trip|travel)\b/.test(
      normalized,
    )
  );
}

function isThinMissionFollowup(input: string): boolean {
  const normalized = normalizeText(input);
  if (!normalized) return true;
  return THIN_FOLLOWUP_PATTERNS.some((pattern) => pattern.test(normalized));
}

function isLikelyMissionSlotAnswer(input: string): boolean {
  const normalized = normalizeText(input);
  if (!normalized || normalized.length > 60) return false;
  if (isThinMissionFollowup(input)) return false;
  if (isMarketplaceIntent(input)) return false;
  return /[a-z0-9]/.test(normalized);
}

function mergeMissionSlotAnswer(priorMission: string, detail: string): string {
  const trimmed = detail.trim();
  if (/\b(from|departing from|leaving from)\b/i.test(trimmed)) {
    return `${priorMission}. ${trimmed}`;
  }
  if (/\b(traveler|travelers|people|person|passenger|passengers)\b/i.test(trimmed)) {
    return `${priorMission}. Travelers: ${trimmed}.`;
  }
  return `${priorMission}. Additional detail from the user: departing from ${trimmed}.`;
}

function normalizeText(input: string): string {
  return input
    .toLowerCase()
    .replace(/[_-]+/g, " ")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function isMarketplaceIntent(input: string): boolean {
  const normalized = normalizeText(input);
  if (!normalized) return false;
  return [
    "app",
    "agent",
    "marketplace",
    "install",
    "connect",
    "trip",
    "travel",
    "vegas",
    "flight",
    "hotel",
    "cab",
    "taxi",
    "food",
    "restaurant",
    "event",
    "attraction",
    "charging",
  ].some((phrase) => includesPhrase(normalized, phrase));
}

function includesPhrase(haystack: string, phrase: string): boolean {
  const normalizedPhrase = normalizeText(phrase);
  if (!normalizedPhrase) return false;
  return new RegExp(`\\b${escapeRegExp(normalizedPhrase)}\\b`).test(haystack);
}

function escapeRegExp(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
