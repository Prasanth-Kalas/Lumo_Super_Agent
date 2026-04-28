/**
 * Voice-pipeline regression tests.
 *
 * Runs as a plain Node ESM script using --experimental-strip-types
 * (Node 20.10+) so we don't need vitest/jest to cover the
 * deterministic parts of the voice stack. The component-level
 * state machine still needs eyes-on testing in a browser, but
 * these lock down the boring stuff:
 *
 *   - toSpeakable / contractions / prosody punctuation
 *   - speakableAmount / numberToWords
 *   - narrateTripSummary / narrateLegStatus
 *   - nextSpeakableChunk (TTS chunking threshold)
 *   - chooseSilenceWindow / silenceDecision (STT end-of-turn)
 *
 * Run: node --experimental-strip-types tests/voice.test.mjs
 */

import {
  toSpeakable,
  speakableAmount,
  numberToWords,
  narrateTripSummary,
  narrateLegStatus,
} from "../lib/voice-format.ts";
import {
  nextSpeakableChunk,
  nextSpeakableChunks,
  finalSpeakableChunks,
  chooseSilenceWindow,
  silenceDecision,
  DEFAULT_SILENCE,
} from "../lib/voice-chunking.ts";
import {
  inferVoiceEmotion,
  openAiEmotionInstructions,
  tuneVoiceForEmotion,
} from "../lib/voice-emotion.ts";
import assert from "node:assert/strict";

let pass = 0;
let fail = 0;
const t = (name, fn) => {
  try {
    fn();
    pass++;
    console.log(`  \u2713 ${name}`);
  } catch (e) {
    fail++;
    console.log(`  \u2717 ${name}\n    ${e.message}`);
  }
};

console.log("\ntoSpeakable");
t("strips markdown bold", () => assert.equal(toSpeakable("**hi** there"), "hi there"));
t("strips code fences", () => assert.equal(toSpeakable("pre ```code``` post"), "pre post"));
t("inline code keeps content", () => assert.equal(toSpeakable("use `npm ci` now"), "use npm ci now"));
t("links become their text", () => assert.equal(toSpeakable("See [here](https://x.com) now"), "See here now"));
t("bare URL becomes 'a link'", () => assert.equal(toSpeakable("Visit https://x.com"), "Visit a link"));
t("contractions: I will -> I'll", () => assert.equal(toSpeakable("I will be there"), "I'll be there"));
t("contractions: cannot -> can't", () => assert.equal(toSpeakable("I cannot do that"), "I can't do that"));
t("contractions: case-preserving", () => assert.equal(toSpeakable("You are right"), "You're right"));
t("contractions: do not -> don't", () => assert.equal(toSpeakable("do not worry"), "don't worry"));
t("preserves em-dashes", () => assert.ok(toSpeakable("Alright \u2014 done").includes("\u2014")));
t("converts -- to em-dash", () => assert.ok(toSpeakable("ok -- done").includes("\u2014")));
t("collapses ... to ellipsis", () => assert.ok(toSpeakable("wait...").includes("\u2026")));
t("collapses !!!", () => assert.equal(toSpeakable("yes!!!"), "yes!"));
t("empty string safe", () => assert.equal(toSpeakable(""), ""));

console.log("\nspeakableAmount");
t("347 USD -> contains 'three hundred' + 'dollars'", () => {
  const r = speakableAmount(347, "USD");
  assert.ok(/three hundred/.test(r) && /dollars/.test(r), r);
});
t("1 USD singular", () => assert.ok(speakableAmount(1, "USD").includes("dollar")));
t("EUR works", () => assert.ok(/euro/.test(speakableAmount(50, "EUR"))));
t("unknown currency falls back", () => assert.ok(speakableAmount(10, "XYZ").length > 0));
t("null amount returns empty", () => assert.equal(speakableAmount(null), ""));

console.log("\nnumberToWords");
t("0", () => assert.equal(numberToWords(0), "zero"));
t("21", () => assert.equal(numberToWords(21), "twenty-one"));
t("100", () => assert.equal(numberToWords(100), "one hundred"));
t("347", () => assert.equal(numberToWords(347), "three hundred forty-seven"));
t("1000", () => assert.equal(numberToWords(1000), "one thousand"));

console.log("\nnarrateTripSummary");
t("empty legs fallback", () => assert.ok(narrateTripSummary({ legs: [] }).length > 0));
t("with legs mentions book", () => {
  const r = narrateTripSummary({
    legs: [{ order: 1, agent_id: "flight-agent", amount: "300", currency: "USD" }],
  });
  assert.ok(/book/.test(r), r);
});

console.log("\nnarrateLegStatus");
t("committed phrasing", () => assert.ok(narrateLegStatus("flight-agent", "committed").includes("booked")));
t("rolled_back phrasing", () => assert.ok(narrateLegStatus("hotel-agent", "rolled_back").includes("refunded")));
t("unknown status returns null", () => assert.equal(narrateLegStatus("x", "random"), null));

console.log("\nnextSpeakableChunk");
t("short buffer, not ready", () => {
  const r = nextSpeakableChunk("hi.");
  assert.equal(r.chunk, "");
  assert.equal(r.rest, "hi.");
});
t("no sentence boundary, not ready", () => {
  const r = nextSpeakableChunk("this is a longer buffer without end");
  assert.equal(r.chunk, "");
});
t("single sentence ready", () => {
  const r = nextSpeakableChunk("This is a complete sentence. ");
  assert.ok(r.chunk.length > 0);
});
t("two short sentences may share one bounded chunk", () => {
  const r = nextSpeakableChunk("First one done. Second one here. ");
  assert.ok(r.chunk.includes("First"));
  assert.ok(r.chunk.includes("Second"));
  assert.equal(r.rest, "");
});
t("nextSpeakableChunks drains ready bounded chunks in order", () => {
  const sentence =
    "This is a complete sentence with enough words to be queued for speaking. ";
  const r = nextSpeakableChunks(`${sentence.repeat(10)}Partial`);
  assert.ok(r.chunks.length > 1);
  assert.equal(r.chunks.join(" "), sentence.repeat(10).trim());
  assert.equal(r.rest, "Partial");
});
t("long response is split instead of one huge TTS request", () => {
  const sentence =
    "This is a complete sentence with enough words to be queued for speaking. ";
  const long = sentence.repeat(10);
  const r = nextSpeakableChunks(long);
  assert.ok(r.chunks.length > 1);
  assert.ok(r.chunks.every((chunk) => chunk.length <= 500));
});
t("finalSpeakableChunks adds punctuation to final tail", () => {
  assert.deepEqual(finalSpeakableChunks("Almost done"), ["Almost done."]);
});
t("trailing partial stays as rest", () => {
  const r = nextSpeakableChunk(
    "Full sentence is definitely ready now. Partial next",
  );
  assert.equal(r.rest, "Partial next");
});
t("paragraph break works", () => {
  const r = nextSpeakableChunk("Some longer text here\n\nMore stuff later");
  assert.ok(r.chunk.length > 0);
});
t("question mark boundary", () => {
  const r = nextSpeakableChunk("Are you sure about this? ");
  assert.ok(r.chunk.includes("sure"));
});
t("exclamation boundary", () => {
  const r = nextSpeakableChunk("Well that is great news! ");
  assert.ok(r.chunk.includes("great"));
});

console.log("\nchooseSilenceWindow");
t("short buffer -> long window", () => assert.equal(chooseSilenceWindow("hi"), DEFAULT_SILENCE.longMs));
t("empty buffer -> long window", () => assert.equal(chooseSilenceWindow(""), DEFAULT_SILENCE.longMs));
t("long buffer -> short window", () => assert.equal(chooseSilenceWindow("a".repeat(100)), DEFAULT_SILENCE.shortMs));
t("borderline 80 chars -> short", () => assert.equal(chooseSilenceWindow("a".repeat(80)), DEFAULT_SILENCE.shortMs));
t("borderline 79 chars -> long", () => assert.equal(chooseSilenceWindow("a".repeat(79)), DEFAULT_SILENCE.longMs));

console.log("\nsilenceDecision");
t("empty -> rearm", () => assert.equal(silenceDecision(""), "rearm"));
t("whitespace -> rearm", () => assert.equal(silenceDecision("   "), "rearm"));
t("content -> dispatch", () => assert.equal(silenceDecision("hello"), "dispatch"));

console.log("\nvoice emotion");
t("confirmed text sounds celebratory", () => {
  assert.equal(inferVoiceEmotion("Your flight is booked and confirmed."), "celebratory");
});
t("permission text sounds reassuring", () => {
  assert.equal(inferVoiceEmotion("I need your permission before I book this."), "reassuring");
});
t("upbeat text sounds excited", () => {
  assert.equal(inferVoiceEmotion("Great, I found three options!"), "excited");
});
t("emotion tuning clamps values", () => {
  const tuned = tuneVoiceForEmotion(
    { stability: 0.99, similarity_boost: 0.99, style: 0.95 },
    "reassuring",
  );
  assert.equal(tuned.stability, 1);
  assert.equal(tuned.similarity_boost, 1);
  assert.ok(tuned.style <= 1);
});
t("OpenAI instructions include sentence completion guidance", () => {
  assert.ok(openAiEmotionInstructions("warm").includes("finish every sentence cleanly"));
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
