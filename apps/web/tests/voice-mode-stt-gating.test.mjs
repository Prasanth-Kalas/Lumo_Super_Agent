/**
 * VOICE-MODE-STT-GATING-1 regression suite.
 *
 * Run: node --experimental-strip-types tests/voice-mode-stt-gating.test.mjs
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  DEFAULT_VOICE_TTS_TAIL_GUARD_MS,
  canResumeListeningAfterTts,
  expectedTtsResumeSequence,
  isMicPausedForVoicePhase,
  normalizeVoiceTtsTailGuardMs,
  voiceModeActionForState,
} from "../lib/voice-mode-stt-gating.ts";

let pass = 0;
let fail = 0;
const t = async (name, fn) => {
  try {
    await fn();
    pass++;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    fail++;
    console.log(`  ✗ ${name}\n    ${error.stack ?? error.message}`);
  }
};

console.log("\nvoice mode STT gating");

await t("state machine resumes in speaking → guard → listening order", () => {
  assert.deepEqual(expectedTtsResumeSequence(true), [
    "AGENT_THINKING",
    "AGENT_SPEAKING",
    "POST_SPEAKING_GUARD",
    "LISTENING",
  ]);
  assert.deepEqual(expectedTtsResumeSequence(false), [
    "AGENT_THINKING",
    "AGENT_SPEAKING",
    "POST_SPEAKING_GUARD",
  ]);
});

await t("mic feed is paused during agent speaking and post-speaking guard", () => {
  assert.equal(isMicPausedForVoicePhase("AGENT_THINKING"), false);
  assert.equal(isMicPausedForVoicePhase("AGENT_SPEAKING"), true);
  assert.equal(isMicPausedForVoicePhase("POST_SPEAKING_GUARD"), true);
  assert.equal(isMicPausedForVoicePhase("LISTENING"), false);
});

await t("hands-free resume is blocked while the TTS mic gate is active", () => {
  const base = {
    autoListenUnlocked: true,
    handsFree: true,
    userStoppedListening: false,
    enabled: true,
    busy: false,
    micPausedForTts: false,
  };
  assert.equal(canResumeListeningAfterTts(base), true);
  assert.equal(
    canResumeListeningAfterTts({ ...base, micPausedForTts: true }),
    false,
  );
  assert.equal(canResumeListeningAfterTts({ ...base, busy: true }), false);
  assert.equal(
    canResumeListeningAfterTts({ ...base, userStoppedListening: true }),
    false,
  );
});

await t("voice action button has a visible action for every interactive state", () => {
  assert.deepEqual(voiceModeActionForState("idle"), {
    kind: "tap_to_talk",
    label: "Tap to talk",
    disabled: false,
  });
  assert.deepEqual(voiceModeActionForState("listening"), {
    kind: "stop_listening",
    label: "Stop",
    disabled: false,
  });
  assert.deepEqual(voiceModeActionForState("thinking"), {
    kind: "cancel_turn",
    label: "Cancel",
    disabled: false,
  });
  assert.deepEqual(voiceModeActionForState("speaking"), {
    kind: "stop_speaking",
    label: "Stop",
    disabled: false,
  });
  assert.deepEqual(voiceModeActionForState("post_speaking_guard"), {
    kind: "stop_speaking",
    label: "Stop",
    disabled: false,
  });
});

await t("tail guard env parsing defaults to 300ms and clamps bad values", () => {
  assert.equal(
    normalizeVoiceTtsTailGuardMs(undefined),
    DEFAULT_VOICE_TTS_TAIL_GUARD_MS,
  );
  assert.equal(normalizeVoiceTtsTailGuardMs(""), DEFAULT_VOICE_TTS_TAIL_GUARD_MS);
  assert.equal(normalizeVoiceTtsTailGuardMs("275.4"), 275);
  assert.equal(normalizeVoiceTtsTailGuardMs("-40"), 0);
  assert.equal(normalizeVoiceTtsTailGuardMs("5000"), 2000);
});

await t("VoiceMode gates startListening and barge-in while TTS owns the mic", () => {
  const source = readFileSync("components/VoiceMode.tsx", "utf8");
  assert.match(source, /if \(ttsMicPausedRef\.current\) return;\s*const Ctor/);
  assert.match(source, /if \(ttsMicPausedRef\.current\) return;\s*let cancelled = false/);
  assert.match(source, /ttsAbortControllerRef\.current\?\.abort\(\)/);
  assert.match(source, /transitionVoiceState\("post_speaking_guard"/);
  assert.match(source, /TTS_TAIL_GUARD_MS/);
  assert.match(source, /NEXT_PUBLIC_LUMO_VOICE_TTS_TAIL_GUARD_MS/);
  assert.match(source, /setVoiceMachinePhase\("LISTENING"\);\s*transitionVoiceState\("idle"/);
});

await t("VoiceMode logs every state transition through one wrapper", () => {
  const source = readFileSync("components/VoiceMode.tsx", "utf8");
  assert.match(source, /console\.log\("\[lumo-voice\]"/);
  assert.match(source, /event: "state_transition"/);
  assert.match(source, /from,\s*to,\s*trigger,/);
  assert.match(source, /ts: new Date\(\)\.toISOString\(\)/);
  assert.doesNotMatch(source, /\n\s+setState\("[a-z_]+"/);
  assert.doesNotMatch(source, /\n\s+setState\(\(prev\)/);
});

await t("VoiceMode renders one stable action button and wires cancel to chat abort", () => {
  const source = readFileSync("components/VoiceMode.tsx", "utf8");
  const pageSource = readFileSync("app/page.tsx", "utf8");
  assert.match(source, /const voiceAction = voiceModeActionForState\(state\)/);
  assert.match(source, /case "cancel_turn":\s*cancelThinkingTurn\(\)/);
  assert.match(source, />\s*\{voiceAction\.label\}\s*<\/button>/);
  assert.match(pageSource, /chatAbortControllerRef\.current\?\.abort\(\)/);
  assert.match(pageSource, /onCancelTurn=\{cancelActiveChatTurn\}/);
});

await t("five speakable sentences stay eligible for five TTS appends", () => {
  const source = readFileSync("components/VoiceMode.tsx", "utf8");
  assert.match(source, /chunks\.forEach\(\(chunk\) => enqueueTts\(chunk\)\)/);
  assert.match(source, /tailChunks\.forEach\(\(chunk, index\) =>/);
  assert.doesNotMatch(source, /startListening\(\);\s*}\s*,\s*200\)/);
});

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
