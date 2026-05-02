/**
 * Static catalog of voices exposed to the user via the voice picker.
 *
 * We intentionally don't query the provider voice list at runtime:
 *   - Provider catalogs contain many voices not tuned for concierge use
 *   - We want curated copy ("thoughtful male friend") the API doesn't provide
 *   - Stable ids let us A/B test voice selections without a round trip
 *
 * To add or swap a voice: pick a Deepgram Aura-2 voice id and add an
 * entry here with a hand-written description that reflects how it feels.
 * The description is what users read when they're auditioning — make it
 * sound like a character, not a spec sheet.
 *
 * Preview text: deliberately a concierge-shaped sentence so users
 * audition the voice in the context they'll actually hear it in.
 */

export interface VoiceOption {
  id: string;
  name: string;
  /** One-sentence vibe description shown in the picker card. */
  description: string;
  /** Rough demographic category for filtering/sorting. */
  character:
    | "warm-female"
    | "youthful-female"
    | "british-female"
    | "warm-male"
    | "deep-male";
  /** True for the initial default — only one entry should set this. */
  default?: boolean;
}

export const VOICE_CATALOG: VoiceOption[] = [
  {
    id: "aura-2-thalia-en",
    name: "Thalia",
    description:
      "Conversational and warm. Sounds like a capable friend walking you through the plan — natural, clear, and easy to trust.",
    character: "warm-female",
    default: true,
  },
  {
    id: "aura-2-orpheus-en",
    name: "Orpheus",
    description:
      "Measured and composed. A calm travel operator voice for confirmations, receipts, and high-stakes booking steps.",
    character: "warm-male",
  },
];

export const DEFAULT_VOICE_ID =
  VOICE_CATALOG.find((v) => v.default)?.id ?? VOICE_CATALOG[0]!.id;

const STORAGE_KEY = "lumo.voiceId";

/**
 * Read the user's saved voice choice from localStorage. Returns the
 * default voice id when nothing's saved or when called server-side.
 * Never throws — private-mode browsers can block storage.
 */
export function getSelectedVoiceId(): string {
  if (typeof window === "undefined") return DEFAULT_VOICE_ID;
  try {
    const v = window.localStorage.getItem(STORAGE_KEY);
    if (!v) return DEFAULT_VOICE_ID;
    // Validate against the catalog — if we removed a voice the user
    // previously picked, fall back to default rather than ship a
    // broken id to the API.
    const ok = VOICE_CATALOG.some((entry) => entry.id === v);
    return ok ? v : DEFAULT_VOICE_ID;
  } catch {
    return DEFAULT_VOICE_ID;
  }
}

export function setSelectedVoiceId(id: string): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY, id);
  } catch {
    // private mode / quota — silently ignore; next call returns default.
  }
}

/** Sample phrase auditioned in the voice picker. Concierge-shaped. */
export const VOICE_PREVIEW_TEXT =
  "I found a flight to Vegas for three forty seven, and a hotel near the strip for two twenty. Should I book it?";
