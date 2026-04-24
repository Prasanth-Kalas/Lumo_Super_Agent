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

export function nextSpeakableChunk(buf: string): {
  chunk: string;
  rest: string;
} {
  if (buf.length < MIN_CHUNK_CHARS) return { chunk: "", rest: buf };
  const re = /([.!?]+\s)|(\n{2,})/g;
  let lastMatch = -1;
  let m: RegExpExecArray | null;
  while ((m = re.exec(buf)) !== null) {
    lastMatch = re.lastIndex;
  }
  if (lastMatch < 0) return { chunk: "", rest: buf };
  return { chunk: buf.slice(0, lastMatch).trim(), rest: buf.slice(lastMatch) };
}

/**
 * Pick an end-of-turn silence window for STT based on how much the
 * user has already said. Long, clearly-complete utterances dispatch
 * fast (short window); short/partial ones wait longer so a natural
 * mid-sentence thinking pause doesn't truncate them.
 *
 * Inputs chosen empirically from user reports (see task history):
 *   - 1200 ms short window is just above Chrome's native ~700 ms
 *     isFinal threshold, enough to feel responsive without
 *     chattering.
 *   - 3500 ms long window forgives the typical "from SFO … to
 *     Austin" mid-sentence pause.
 *   - 60 chars / ~10 words is the inflection where utterances read
 *     as "complete thought" rather than "opening clause".
 */
export interface SilenceWindows {
  shortMs: number;
  longMs: number;
  longUtteranceChars: number;
}

export const DEFAULT_SILENCE: SilenceWindows = {
  shortMs: 1500,
  longMs: 3500,
  longUtteranceChars: 60,
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
