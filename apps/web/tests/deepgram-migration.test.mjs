/**
 * DEEPGRAM-MIGRATION-1 regression suite.
 *
 * Run: node --experimental-strip-types tests/deepgram-migration.test.mjs
 */

import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  DEFAULT_DEEPGRAM_TTS_VOICE,
  DEFAULT_DEEPGRAM_TTS_SPEED,
  DEEPGRAM_AUTH_GRANT_URL,
  DEEPGRAM_LISTEN_WS_URL,
  DEEPGRAM_STT_MODEL,
  createDeepgramTemporaryToken,
  deepgramListenRestUrl,
  deepgramListenWebSocketUrl,
  deepgramSpeakRestUrl,
  normalizeDeepgramTtsSpeed,
  normalizeDeepgramVoice,
} from "../lib/deepgram.ts";
import {
  buildVoiceProviderCompareRow,
  instrumentAudioStream,
} from "../lib/voice-provider-compare.ts";

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

console.log("\ndeepgram migration");

const migration056 = readFileSync(
  "../../db/migrations/056_voice_provider_compare.sql",
  "utf8",
);
const tokenRouteSource = readFileSync("app/api/audio/deepgram-token/route.ts", "utf8");
const ttsRouteSource = readFileSync("app/api/tts/route.ts", "utf8");
const sttRouteSource = readFileSync("app/api/stt/route.ts", "utf8");
const deepgramTtsRetrySource = readFileSync("lib/deepgram-tts-retry.ts", "utf8");

await t("temporary token call uses Deepgram auth grant with 60s TTL", async () => {
  const result = await createDeepgramTemporaryToken({
    apiKey: "dg_test_key",
    ttlSeconds: 60,
    now: () => new Date("2026-05-02T10:00:00.000Z"),
    fetchImpl: async (url, init) => {
      assert.equal(String(url), DEEPGRAM_AUTH_GRANT_URL);
      assert.equal(init?.method, "POST");
      assert.equal(init?.headers?.authorization, "Token dg_test_key");
      assert.equal(JSON.parse(String(init?.body)).ttl_seconds, 60);
      return Response.json({ access_token: "short_lived", expires_in: 60 });
    },
  });
  assert.equal(result.ok, true);
  assert.equal(result.result.token, "short_lived");
  assert.equal(result.result.expires_at, "2026-05-02T10:01:00.000Z");
});

await t("temporary token degrades cleanly when key is missing", async () => {
  const old = process.env.LUMO_DEEPGRAM_API_KEY;
  delete process.env.LUMO_DEEPGRAM_API_KEY;
  const result = await createDeepgramTemporaryToken({
    fetchImpl: async () => {
      throw new Error("should not call upstream");
    },
  });
  assert.deepEqual(result, {
    ok: false,
    error: "deepgram_not_configured",
    status: 503,
  });
  if (old === undefined) delete process.env.LUMO_DEEPGRAM_API_KEY;
  else process.env.LUMO_DEEPGRAM_API_KEY = old;
});

await t("Deepgram URL helpers pin Nova-3 listen and Aura-2 speak params", () => {
  const listenWs = deepgramListenWebSocketUrl({ encoding: "linear16", sampleRate: 16000 });
  assert.ok(listenWs.startsWith(`${DEEPGRAM_LISTEN_WS_URL}?`));
  assert.match(listenWs, /model=nova-3/);
  assert.match(listenWs, /smart_format=true/);
  assert.match(listenWs, /interim_results=true/);
  assert.match(listenWs, /endpointing=300/);
  assert.match(listenWs, /encoding=linear16/);
  assert.match(listenWs, /sample_rate=16000/);
  assert.match(deepgramListenRestUrl(), /model=nova-3/);
  assert.match(deepgramSpeakRestUrl(DEFAULT_DEEPGRAM_TTS_VOICE), /model=aura-2-thalia-en/);
  assert.match(deepgramSpeakRestUrl(DEFAULT_DEEPGRAM_TTS_VOICE), /speed=0\.9/);
  assert.equal(normalizeDeepgramVoice("aura-2-orpheus-en"), "aura-2-orpheus-en");
  assert.equal(normalizeDeepgramVoice("unknown"), DEFAULT_DEEPGRAM_TTS_VOICE);
  assert.equal(normalizeDeepgramTtsSpeed("0.85"), 0.85);
  assert.equal(normalizeDeepgramTtsSpeed("1.7"), DEFAULT_DEEPGRAM_TTS_SPEED);
  assert.equal(DEFAULT_DEEPGRAM_TTS_SPEED, 0.9);
  assert.equal(DEEPGRAM_STT_MODEL, "nova-3");
});

await t("voice_provider_compare migration has RLS and append-only guard", () => {
  assert.match(migration056, /create table if not exists public\.voice_provider_compare/);
  for (const column of [
    "provider",
    "direction",
    "latency_first_token_ms",
    "total_audio_ms",
    "audio_bytes",
    "session_id",
    "user_id",
  ]) {
    assert.match(migration056, new RegExp(`\\b${column}\\b`));
  }
  assert.match(migration056, /provider in \('deepgram','elevenlabs'\)/);
  assert.match(migration056, /direction in \('stt','tts'\)/);
  assert.match(
    migration056,
    /voice_provider_compare_by_provider_direction_created[\s\S]*provider,\s*direction,\s*created_at desc/,
  );
  assert.match(migration056, /alter table public\.voice_provider_compare enable row level security/);
  assert.match(migration056, /revoke all on public\.voice_provider_compare from anon, authenticated/);
  assert.match(migration056, /VOICE_PROVIDER_COMPARE_APPEND_ONLY/);
});

await t("Deepgram token route is auth-gated, rate-limited, and short-lived", () => {
  assert.match(tokenRouteSource, /requireServerUser/);
  assert.match(tokenRouteSource, /MAX_TOKENS_PER_WINDOW\s*=\s*30/);
  assert.match(tokenRouteSource, /DEEPGRAM_TOKEN_TTL_SECONDS/);
  assert.match(tokenRouteSource, /rate_limited/);
  assert.match(tokenRouteSource, /,\s*200,\s*\)/);
});

await t("web TTS and recorded STT use Deepgram by default", () => {
  assert.match(ttsRouteSource, /LUMO_DEEPGRAM_API_KEY/);
  assert.match(ttsRouteSource, /fetchDeepgramSpeechWithRetry/);
  assert.match(deepgramTtsRetrySource, /deepgramSpeakRestUrl/);
  assert.match(ttsRouteSource, /LUMO_DEEPGRAM_TTS_SPEED/);
  assert.match(ttsRouteSource, /LUMO_TTS_PROVIDER/);
  assert.match(sttRouteSource, /deepgramListenRestUrl/);
  assert.match(sttRouteSource, /DEEPGRAM_STT_MODEL/);
  assert.doesNotMatch(sttRouteSource, /api\.openai\.com\/v1\/audio\/transcriptions/);
});

await t("voice telemetry row sanitizes bounded metadata", () => {
  const row = buildVoiceProviderCompareRow({
    provider: "deepgram",
    direction: "stt",
    latency_first_token_ms: 12.4,
    total_audio_ms: 99.9,
    audio_bytes: 1234.2,
    error: "bad\nbody".repeat(80),
    session_id: "sess with spaces",
    user_id: null,
  });
  assert.equal(row.latency_first_token_ms, 12);
  assert.equal(row.total_audio_ms, 100);
  assert.equal(row.audio_bytes, 1234);
  assert.equal(row.session_id, "sess_with_spaces");
  assert.ok(row.error.length <= 240);
  assert.doesNotMatch(row.error, /\n/);
});

await t("instrumentAudioStream preserves chunks while measuring bytes", async () => {
  const source = new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array([1, 2, 3]));
      controller.enqueue(new Uint8Array([4]));
      controller.close();
    },
  });
  const stream = instrumentAudioStream(source, {
    provider: "deepgram",
    direction: "tts",
    startedAt: Date.now(),
  });
  const reader = stream.getReader();
  const chunks = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(...value);
  }
  assert.deepEqual(chunks, [1, 2, 3, 4]);
});

await t("apps/web keeps legacy TTS provider references confined to fallback code", () => {
  const files = walkSourceFiles(process.cwd());
  const offenders = [];
  const allow = new Set([
    "app/api/tts/route.ts",
    "app/admin/settings/page.tsx",
    "lib/voice-provider-compare.ts",
    "tests/deepgram-migration.test.mjs",
  ]);
  for (const file of files) {
    const text = readFileSync(file, "utf8");
    if (/ElevenLabs|ELEVENLABS|elevenlabs|11labs/.test(text) && !allow.has(file)) {
      offenders.push(file);
    }
  }
  assert.deepEqual(offenders, []);
});

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);

function walkSourceFiles(root) {
  const out = [];
  const visit = (dir, prefix = "") => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name === ".next") continue;
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      const abs = join(dir, entry.name);
      if (entry.isDirectory()) {
        visit(abs, rel);
        continue;
      }
      if (/\.(ts|tsx|js|mjs|md)$/.test(entry.name)) out.push(rel);
    }
  };
  visit(root);
  return out;
}
