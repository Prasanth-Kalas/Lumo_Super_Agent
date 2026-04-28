/**
 * Pure helpers for deciding WHEN to speak and HOW MUCH.
 *
 * Extracted from VoiceMode.tsx so they're unit-testable without
 * standing up a DOM + React environment. The component just imports
 * and calls these. Zero React, zero browser globals — safe in any
 * runtime.
 */

/**
 * Pull the next "ready to speak" chunk off a growing assistant-text
 * buffer.
 *
 * A chunk is "ready" if:
 *   - It ends at a sentence boundary (. ! ? followed by whitespace)
 *     OR a paragraph break (\n\n).
 *   - It's at least MIN_CHUNK_CHARS long, so we don't speak
 *     fragments like "Ok." before context arrives.
 *
 * Returns (chunk, rest). Caller sets spokenSoFar += chunk.length
 * and waits for the next buffer update.
 */
const MIN_CHUNK_CHARS = 20;
const MAX_CHUNK_CHARS = 420;

export function nextSpeakableChunk(buf: string): {
  chunk: string;
  rest: string;
} {
  if (buf.length < MIN_CHUNK_CHARS) return { chunk: "", rest: buf };
  const re = /([.!?]+\s)|(\n{2,})/g;
  const boundaries: number[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(buf)) !== null) {
    boundaries.push(re.lastIndex);
  }
  if (boundaries.length === 0) return { chunk: "", rest: buf };

  let chosen = -1;
  for (const boundary of boundaries) {
    const len = buf.slice(0, boundary).trim().length;
    if (len < MIN_CHUNK_CHARS) continue;
    if (boundary <= MAX_CHUNK_CHARS) {
      chosen = boundary;
      continue;
    }
    if (chosen < 0) chosen = boundary;
    break;
  }
  if (chosen < 0) return { chunk: "", rest: buf };
  return { chunk: buf.slice(0, chosen).trim(), rest: buf.slice(chosen) };
}

export function nextSpeakableChunks(buf: string): {
  chunks: string[];
  rest: string;
} {
  const chunks: string[] = [];
  let rest = buf;
  while (rest.trim()) {
    const next = nextSpeakableChunk(rest);
    if (!next.chunk) break;
    chunks.push(next.chunk);
    rest = next.rest;
  }
  return { chunks, rest };
}

export function finalSpeakableChunks(buf: string): string[] {
  const { chunks, rest } = nextSpeakableChunks(buf);
  const tail = rest.trim();
  if (tail) chunks.push(ensureSentenceEnding(tail));
  return chunks;
}

function ensureSentenceEnding(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) return "";
  return /[.!?…]$/.test(trimmed) ? trimmed : `${trimmed}.`;
}

/**
 * Pick an end-of-turn silence window for STT based on how much the
 * user has already said. Long, clearly-complete utterances dispatch
 * fast (short window); short/partial ones wait longer so a natural
 * mid-sentence thinking pause doesn't truncate them.
 *
 * Inputs chosen empirically from user reports (see task history):
 *   - 2200 ms short window is comfortably above Chrome's native
 *     ~700 ms isFinal threshold, so natural pauses do not split
 *     one spoken thought into multiple chat turns.
 *   - 4500 ms long window forgives the typical "from SFO … to
 *     Austin" mid-sentence pause.
 *   - 80 chars / ~13 words is the inflection where utterances read
 *     as "complete thought" rather than "opening clause".
 */
export interface SilenceWindows {
  shortMs: number;
  longMs: number;
  longUtteranceChars: number;
}

export const DEFAULT_SILENCE: SilenceWindows = {
  shortMs: 2200,
  longMs: 4500,
  longUtteranceChars: 80,
};

export function chooseSilenceWindow(
  bufferedTranscript: string,
  windows: SilenceWindows = DEFAULT_SILENCE,
): number {
  const len = bufferedTranscript.trim().length;
  return len >= windows.longUtteranceChars ? windows.shortMs : windows.longMs;
}

/**
 * Should the silence-fire callback dispatch the buffered transcript,
 * or re-arm for more time? Returns "dispatch" when there's real
 * content; "rearm" when the buffer is empty/whitespace (ambient
 * noise fired the timer, not a real utterance).
 */
export function silenceDecision(
  bufferedTranscript: string,
): "dispatch" | "rearm" {
  return bufferedTranscript.trim() ? "dispatch" : "rearm";
}
