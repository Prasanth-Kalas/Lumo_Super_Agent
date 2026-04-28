/**
 * Chat history replay tests.
 *
 * Run: node --experimental-strip-types tests/history-replay.test.mjs
 */

import assert from "node:assert/strict";
import {
  replayEventsToMessages,
  sessionEventsBelongToUser,
} from "../lib/history-replay.ts";

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

console.log("\nhistory replay");

const events = [
  {
    event_id: 1,
    session_id: "session-1",
    frame_type: "request",
    frame_value: {
      user_id: "user-a",
      last_user_message: "Plan my Vegas trip",
    },
    ts: "2026-04-26T08:00:00.000Z",
  },
  {
    event_id: 2,
    session_id: "session-1",
    frame_type: "text",
    frame_value: { type: "text", value: "Absolutely." },
    ts: "2026-04-26T08:00:01.000Z",
  },
  {
    event_id: 3,
    session_id: "session-1",
    frame_type: "text",
    frame_value: { type: "text", value: "I found the right apps." },
    ts: "2026-04-26T08:00:02.000Z",
  },
  {
    event_id: 4,
    session_id: "session-1",
    frame_type: "mission",
    frame_value: { type: "mission", value: { title: "Vegas trip" } },
    ts: "2026-04-26T08:00:03.000Z",
  },
  {
    event_id: 5,
    session_id: "session-1",
    frame_type: "selection",
    frame_value: {
      type: "selection",
      value: { kind: "flight_offers", payload: { count: 3 } },
    },
    ts: "2026-04-26T08:00:04.000Z",
  },
  {
    event_id: 6,
    session_id: "session-1",
    frame_type: "done",
    frame_value: { type: "done" },
    ts: "2026-04-26T08:00:05.000Z",
  },
];

t("scopes replay ownership to request events", () => {
  assert.equal(sessionEventsBelongToUser(events, "user-a"), true);
  assert.equal(sessionEventsBelongToUser(events, "user-b"), false);
});

t("reconstructs user and assistant messages from stored frames", () => {
  const messages = replayEventsToMessages(events);
  assert.equal(messages.length, 2);
  assert.deepEqual(
    messages.map((m) => [m.role, m.content]),
    [
      ["user", "Plan my Vegas trip"],
      ["assistant", "Absolutely. I found the right apps."],
    ],
  );
  assert.equal(messages[1]?.mission?.["title"], "Vegas trip");
  assert.deepEqual(messages[1]?.selections?.map((s) => s.kind), ["flight_offers"]);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
