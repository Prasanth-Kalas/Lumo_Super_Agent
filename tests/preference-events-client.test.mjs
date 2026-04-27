/**
 * Preference event client tests.
 *
 * Run: node --experimental-strip-types tests/preference-events-client.test.mjs
 */

import assert from "node:assert/strict";

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

const originalWindow = globalThis.window;
const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");
const originalFetch = globalThis.fetch;
const originalDateNow = Date.now;

function installBrowserMocks({ sendBeacon } = { sendBeacon: () => false }) {
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {},
  });
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: { sendBeacon },
  });
}

function restoreBrowserMocks() {
  if (originalWindow === undefined) {
    delete globalThis.window;
  } else {
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: originalWindow,
    });
  }
  if (originalNavigator) {
    Object.defineProperty(globalThis, "navigator", originalNavigator);
  } else {
    delete globalThis.navigator;
  }
  globalThis.fetch = originalFetch;
  Date.now = originalDateNow;
}

const client = await import("../lib/preference-events-client.ts");

console.log("\npreference events client");

await t("dedupes repeated events inside the five-second window", () => {
  let now = 1_000;
  const calls = [];
  installBrowserMocks();
  client.__resetPreferenceEventDedupeForTests();
  Date.now = () => now;
  globalThis.fetch = (url, init) => {
    calls.push({ url, init });
    return Promise.resolve({ ok: false });
  };

  const event = {
    surface: "marketplace_tile",
    target_type: "agent",
    target_id: "lumo_flights",
    event_type: "impression",
    context: { source: "test" },
  };

  for (let i = 0; i < 20; i++) client.logPreferenceEvent(event);
  assert.equal(calls.length, 1);

  now += 4_999;
  client.logPreferenceEvent(event);
  assert.equal(calls.length, 1);

  now += 1;
  client.logPreferenceEvent(event);
  assert.equal(calls.length, 2);
  restoreBrowserMocks();
});

await t("does not dedupe distinct meaningful events", () => {
  const calls = [];
  installBrowserMocks();
  client.__resetPreferenceEventDedupeForTests();
  Date.now = () => 10_000;
  globalThis.fetch = (url, init) => {
    calls.push({ url, init });
    return Promise.resolve({ ok: true });
  };

  client.logPreferenceEvent({
    surface: "marketplace_tile",
    target_type: "agent",
    target_id: "lumo_flights",
    event_type: "click",
    context: { source: "test", action: "connect" },
  });
  client.logPreferenceEvent({
    surface: "marketplace_tile",
    target_type: "agent",
    target_id: "lumo_hotels",
    event_type: "click",
    context: { source: "test", action: "connect" },
  });

  assert.equal(calls.length, 2);
  restoreBrowserMocks();
});

restoreBrowserMocks();

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
