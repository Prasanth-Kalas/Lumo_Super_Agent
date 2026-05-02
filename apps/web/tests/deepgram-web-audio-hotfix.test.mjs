/**
 * DEEPGRAM-WEB-AUDIO-HOTFIX-1 regression suite.
 *
 * Run: node --experimental-strip-types tests/deepgram-web-audio-hotfix.test.mjs
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  createChunkedAudioPlayer,
} from "../lib/streaming-audio.ts";
import {
  deepgramRequestId,
  fetchDeepgramSpeechWithRetry,
  isRetryableDeepgramStatus,
} from "../lib/deepgram-tts-retry.ts";

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

console.log("\ndeepgram web audio hotfix");

class FakeSourceBuffer extends EventTarget {
  updating = false;

  constructor(events) {
    super();
    this.events = events;
  }

  appendBuffer(data) {
    const view = data instanceof Uint8Array ? data : new Uint8Array(data);
    this.events.push(`append:${Array.from(view).join(",")}`);
    this.updating = true;
    queueMicrotask(() => {
      this.updating = false;
      this.dispatchEvent(new Event("updateend"));
    });
  }
}

class FakeMediaSource extends EventTarget {
  readyState = "closed";

  constructor(events, onEnd) {
    super();
    this.events = events;
    this.onEnd = onEnd;
  }

  open() {
    this.readyState = "open";
    this.dispatchEvent(new Event("sourceopen"));
  }

  addSourceBuffer(mime) {
    this.events.push(`sourceBuffer:${mime}`);
    return new FakeSourceBuffer(this.events);
  }

  endOfStream() {
    this.events.push("endOfStream");
    this.readyState = "ended";
    queueMicrotask(() => this.onEnd());
  }
}

class FakeAudio extends EventTarget {
  preload = "";
  src = "";

  constructor(events) {
    super();
    this.events = events;
  }

  async play() {
    this.events.push("play");
    queueMicrotask(() => this.dispatchEvent(new Event("playing")));
  }

  pause() {
    this.events.push("pause");
  }

  end() {
    this.dispatchEvent(new Event("ended"));
  }
}

await t("chunked player appends three MP3 responses before endOfStream", async () => {
  const events = [];
  let mediaSource;
  let audio;
  const player = createChunkedAudioPlayer({
    testHooks: {
      supportsMse: true,
      mediaSourceFactory: () => {
        mediaSource = new FakeMediaSource(events, () => audio?.end());
        return mediaSource;
      },
      audioFactory: () => {
        audio = new FakeAudio(events);
        return audio;
      },
      urlFactory: {
        createObjectURL: () => "blob:lumo-test",
        revokeObjectURL: (url) => events.push(`revoke:${url}`),
      },
    },
  });

  mediaSource.open();
  await player.appendResponse(responseWithBytes([1]));
  await player.appendResponse(responseWithBytes([2]));
  await player.appendResponse(responseWithBytes([3]));
  const result = await player.finish();

  assert.equal(result, "played");
  assert.deepEqual(events.filter((event) => event.startsWith("append:")), [
    "append:1",
    "append:2",
    "append:3",
  ]);
  assert.ok(
    events.indexOf("endOfStream") >
      events.lastIndexOf("append:3"),
    "endOfStream must happen after the last append",
  );
});

await t("Deepgram retry helper retries one transient 503 then returns audio", async () => {
  let calls = 0;
  const response = await fetchDeepgramSpeechWithRetry({
    apiKey: "dg_test",
    voice: "aura-2-thalia-en",
    text: "hello",
    speed: 0.9,
    emotion: "warm",
    sessionId: "session_1",
    userId: null,
    startedAt: Date.now(),
    sleepImpl: async () => undefined,
    fetchImpl: async () => {
      calls += 1;
      if (calls === 1) {
        return new Response("temporary", {
          status: 503,
          headers: { "dg-request-id": "dg_req_1" },
        });
      }
      return responseWithBytes([9], { status: 200 });
    },
  });
  assert.equal(calls, 2);
  assert.equal(response?.status, 200);
  assert.equal(isRetryableDeepgramStatus(503), true);
});

await t("Deepgram retry helper returns third 503 with request id for structured route error", async () => {
  let calls = 0;
  const response = await fetchDeepgramSpeechWithRetry({
    apiKey: "dg_test",
    voice: "aura-2-thalia-en",
    text: "hello",
    speed: 0.9,
    emotion: "warm",
    sessionId: "session_1",
    userId: null,
    startedAt: Date.now(),
    sleepImpl: async () => undefined,
    fetchImpl: async () => {
      calls += 1;
      return new Response("temporary", {
        status: 503,
        headers: { "x-dg-request-id": `dg_req_${calls}` },
      });
    },
  });
  assert.equal(calls, 3);
  assert.equal(response?.status, 503);
  assert.equal(deepgramRequestId(response), "dg_req_3");
});

await t("Deepgram retry helper uses fresh fetch state and 200ms backoff per attempt", async () => {
  const urls = [];
  const signals = [];
  const bodies = [];
  const waits = [];
  const response = await fetchDeepgramSpeechWithRetry({
    apiKey: "dg_test",
    voice: "aura-2-thalia-en",
    text: "hello again",
    speed: 0.9,
    emotion: "reassuring",
    sessionId: "session_1",
    userId: null,
    startedAt: Date.now(),
    sleepImpl: async (ms) => {
      waits.push(ms);
    },
    fetchImpl: async (url, init) => {
      urls.push(String(url));
      signals.push(init?.signal);
      bodies.push(String(init?.body));
      if (urls.length < 3) {
        return new Response("temporary", {
          status: 503,
          headers: { "dg-request-id": `dg_req_${urls.length}` },
        });
      }
      return responseWithBytes([9], { status: 200 });
    },
  });
  assert.equal(response?.status, 200);
  assert.equal(urls.length, 3);
  assert.ok(urls.every((url) => /speed=0\.9/.test(url)));
  assert.equal(new Set(signals).size, 3);
  assert.deepEqual(waits, [200, 200]);
  assert.deepEqual(bodies.map((body) => JSON.parse(body)), [
    { text: "hello again" },
    { text: "hello again" },
    { text: "hello again" },
  ]);
});

await t("TTS route maps triple Deepgram 5xx to retryable structured 503", () => {
  const source = readFileSync("app/api/tts/route.ts", "utf8");
  const retrySource = readFileSync("lib/deepgram-tts-retry.ts", "utf8");
  assert.match(source, /tts_upstream_unavailable/);
  assert.match(source, /retryable:\s*true/);
  assert.match(source, /attempt:\s*DEEPGRAM_TTS_MAX_ATTEMPTS/);
  assert.match(retrySource, /tts_deepgram_attempt/);
  assert.match(source, /normalizeDeepgramTtsSpeed\(process\.env\.LUMO_DEEPGRAM_TTS_SPEED\)/);
});

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);

function responseWithBytes(bytes, init = {}) {
  return new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array(bytes));
        controller.close();
      },
    }),
    init,
  );
}
