/**
 * Preference event pure-core tests.
 *
 * Run: node --experimental-strip-types tests/preference-events.test.mjs
 */

import assert from "node:assert/strict";
import {
  normalizePreferenceEvent,
  normalizePreferenceEvents,
  sanitizePreferenceJson,
} from "../lib/preference-events-core.ts";

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

console.log("\npreference events");

t("normalizes a valid marketplace click", () => {
  const event = normalizePreferenceEvent({
    surface: "marketplace_tile",
    target_type: "agent",
    target_id: "google",
    event_type: "click",
    session_id: "session-1",
    context: { category: "Productivity", rank: 0.82 },
  });
  assert.equal(event?.surface, "marketplace_tile");
  assert.equal(event?.target_id, "google");
  assert.equal(event?.dwell_ms, null);
  assert.deepEqual(event?.context, { category: "Productivity", rank: 0.82 });
});

t("rejects invalid surface and target ids", () => {
  assert.equal(
    normalizePreferenceEvent({
      surface: "admin_panel",
      target_type: "agent",
      target_id: "google",
      event_type: "click",
    }),
    null,
  );
  assert.equal(
    normalizePreferenceEvent({
      surface: "marketplace_tile",
      target_type: "agent",
      target_id: "  ",
      event_type: "click",
    }),
    null,
  );
});

t("requires dwell_ms for dwell events", () => {
  assert.equal(
    normalizePreferenceEvent({
      surface: "workspace_card",
      target_type: "workspace_card",
      target_id: "today:calendar",
      event_type: "dwell",
    }),
    null,
  );
  assert.equal(
    normalizePreferenceEvent({
      surface: "workspace_card",
      target_type: "workspace_card",
      target_id: "today:calendar",
      event_type: "dwell",
      dwell_ms: 1520.4,
    })?.dwell_ms,
    1520,
  );
});

t("sanitizes oversized context payloads", () => {
  const sanitized = sanitizePreferenceJson({
    long: "x".repeat(700),
    nested: { value: { too: { deep: "gone" } } },
    list: Array.from({ length: 30 }, (_, i) => i),
  });
  assert.equal(typeof sanitized, "object");
  assert.equal(sanitized.long.length, 500);
  assert.deepEqual(sanitized.nested, {
    value: { too: null },
  });
  assert.equal(sanitized.list.length, 20);
});

t("normalizes event envelopes and caps batches", () => {
  const events = normalizePreferenceEvents(
    {
      events: Array.from({ length: 60 }, (_, i) => ({
        surface: "chat_suggestion",
        target_type: "suggestion",
        target_id: `suggestion-${i}`,
        event_type: "impression",
      })),
    },
    { maxEvents: 10 },
  );
  assert.equal(events.length, 10);
  assert.equal(events[9]?.target_id, "suggestion-9");
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
