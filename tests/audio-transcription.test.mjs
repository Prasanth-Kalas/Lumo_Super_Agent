/**
 * Audio transcription pure-core tests.
 *
 * Run: node --experimental-strip-types tests/audio-transcription.test.mjs
 */

import assert from "node:assert/strict";
import {
  normalizeTranscribeResponse,
  transcribeAudioCore,
} from "../lib/audio-transcription-core.ts";

let pass = 0;
let fail = 0;
const t = async (name, fn) => {
  try {
    await fn();
    pass++;
    console.log(`  \u2713 ${name}`);
  } catch (e) {
    fail++;
    console.log(`  \u2717 ${name}\n    ${e.message}`);
  }
};

console.log("\naudio transcription");

await t("missing ML config returns stable not_configured fallback", async () => {
  const result = await transcribeAudioCore({
    input: { audio_url: "https://example.com/a.mp3", speaker_diarization: true },
    baseUrl: "",
    authorizationHeader: null,
    fetchImpl: async () => Response.json({}),
    timeoutMs: 100,
    recordUsage: async () => {},
  });
  assert.equal(result.status, "not_configured");
  assert.equal(result.transcript, "");
  assert.equal(result.model, "whisper-large-v3");
});

await t("normalizes valid Whisper response", async () => {
  const result = normalizeTranscribeResponse(
    {
      status: "ok",
      transcript: "hello vegas",
      segments: [{ start: 0, end: 1.4, text: " hello vegas ", speaker: null }],
      language: "en",
      duration_s: 1.5,
      model: "whisper-large-v3",
    },
    42,
  );
  assert.equal(result?.status, "ok");
  assert.equal(result?.segments[0]?.text, "hello vegas");
  assert.equal(result?.language, "en");
  assert.equal(result?.latency_ms, 42);
});

await t("malformed response degrades without throwing", async () => {
  const result = await transcribeAudioCore({
    input: { audio_url: "https://example.com/a.mp3" },
    baseUrl: "http://lumo-ml.test",
    authorizationHeader: "Bearer test",
    fetchImpl: async () => Response.json({ status: "maybe", segments: "broken" }),
    timeoutMs: 100,
    recordUsage: async () => {},
  });
  assert.equal(result.status, "error");
  assert.equal(result.error, "malformed_response");
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
