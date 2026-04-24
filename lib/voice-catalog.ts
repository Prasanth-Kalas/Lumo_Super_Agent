/**
 * Static catalog of voices exposed to the user via the voice picker.
 *
 * We intentionally don't query ElevenLabs' /voices endpoint at runtime:
 *   - Their library has 1000+ voices, most not tuned for concierge use
 *   - We want curated copy ("thoughtful male friend") the API doesn't provide
 *   - Stable ids let us A/B test voice selections without a round trip
 *
 * To add or swap a voice: pick a voice from the ElevenLabs library
 * (app.elevenlabs.io/voice-library), copy its id, and add an entry
 * here with a hand-written description that reflects how it feels,
 * not what ElevenLabs' tags say. The description is what users read
 * when they're auditioning — make it sound like a character, not a
 * spec sheet.
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
  character: "warm-female" | "youthful-female" | "warm-male" | "deep-male";
  /** True for the initial default — only one entry should set this. */
  default?: boolean;
}

export const VOICE_CATALOG: VoiceOption[] = [
  {
    id: "21m00Tcm4TlvDq8ikWAM",
    name: "Rachel",
    description:
      "Warm and professional. Late-20s American female — the friend who happens to narrate your day with calm confidence.",
    character: "warm-female",
    default: true,
  },
  {
    id: "EXAVITQu4vr4xnSDxMaL",
    name: "Bella",
    description:
      "Soft and expressive. Early-20s, playful, reads casual messages naturally. Great when you want Lumo to feel like a peer.",
    character: "youthful-female",
  },
  {
    id: "ErXwobaYiN019PkySvjV",
    name: "Antoni",
    description:
      "Thoughtful American male. 30s, calm, unhurried. A chill friend who happens to be excellent at logistics.",
    character: "warm-male",
  },
  {
    id: "pNInz6obpgDQGBDnMUN5",
    name: "Adam",
    description:
      "Deep and confident. 30s, authoritative without being stiff. The voice you want when Lumo says 'your trip is booked.'",
    character: "deep-male",
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
