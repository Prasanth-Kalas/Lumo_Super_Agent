/**
 * WEB-COMPOUND-VIEW-1 regression suite.
 *
 * Run: node --experimental-strip-types tests/web-compound-view.test.mjs
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  buildAssistantCompoundDispatchFrame,
  normalizeDispatchStatus,
} from "../lib/compound/dispatch-frame.ts";

let pass = 0;
let fail = 0;
const t = (name, fn) => {
  try {
    fn();
    pass++;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    fail++;
    console.log(`  ✗ ${name}\n    ${error.stack ?? error.message}`);
  }
};

console.log("\nweb compound view");

const migration052 = readFileSync(
  "../../db/migrations/052_assistant_compound_dispatch_events.sql",
  "utf8",
);
const events = readFileSync("lib/events.ts", "utf8");
const orchestrator = readFileSync("lib/orchestrator.ts", "utf8");
const chatRoute = readFileSync("app/api/chat/route.ts", "utf8");
const page = readFileSync("app/page.tsx", "utf8");
const historyReplay = readFileSync("lib/history-replay.ts", "utf8");
const component = readFileSync("components/CompoundLegStrip.tsx", "utf8");
const demoDispatch = readFileSync("lib/compound/demo-dispatch.ts", "utf8");
const streamRoute = readFileSync(
  "app/api/compound/transactions/[id]/stream/route.ts",
  "utf8",
);
const persistence = readFileSync("lib/compound/persistence.ts", "utf8");

t("event contract admits assistant_compound_dispatch", () => {
  assert.match(events, /"assistant_compound_dispatch"/);
  assert.match(migration052, /'assistant_compound_dispatch'/);
  assert.match(chatRoute, /assistant_compound_dispatch/);
});

t("dispatch frame helper produces ordered, display-ready legs", () => {
  const frame = buildAssistantCompoundDispatchFrame({
    compound_transaction_id: "ct_1",
    status: "executing",
    legs: [
      {
        leg_id: "leg_hotel",
        transaction_id: "tx_hotel",
        order: 2,
        agent_id: "lumo-hotels",
        capability_id: "book_hotel",
        depends_on: ["leg_flight"],
        status: "pending",
      },
      {
        leg_id: "leg_flight",
        transaction_id: "tx_flight",
        order: 1,
        agent_id: "lumo-flights",
        capability_id: "book_flight",
        depends_on: [],
        status: "in_flight",
      },
      {
        leg_id: "leg_restaurant",
        transaction_id: "tx_restaurant",
        order: 3,
        agent_id: "lumo-restaurants",
        capability_id: "book_restaurant",
        depends_on: ["leg_hotel"],
        status: "rollback_in_flight",
      },
    ],
  });

  assert.equal(frame.kind, "assistant_compound_dispatch");
  assert.equal(frame.compound_transaction_id, "ct_1");
  assert.deepEqual(
    frame.legs.map((leg) => leg.leg_id),
    ["leg_flight", "leg_hotel", "leg_restaurant"],
  );
  assert.deepEqual(
    frame.legs.map((leg) => leg.agent_display_name),
    ["Lumo Flights", "Lumo Hotels", "Lumo Restaurants"],
  );
  assert.equal(frame.legs[2]?.status, "rollback_pending");
  // IOS-COMPOUND-ROLLBACK-VIEW-1 carries depends_on through to the
  // dispatch frame so client cards can compute rollback cascades
  // against the saga DAG. Verify each leg's deps survive the
  // ordering + display-name + status normalization.
  assert.deepEqual(frame.legs[0]?.depends_on, []);
  assert.deepEqual(frame.legs[1]?.depends_on, ["leg_flight"]);
  assert.deepEqual(frame.legs[2]?.depends_on, ["leg_hotel"]);
});

t("dispatch frame helper defaults depends_on to [] when omitted on the snapshot", () => {
  const frame = buildAssistantCompoundDispatchFrame({
    compound_transaction_id: "ct_2",
    status: "executing",
    legs: [
      {
        leg_id: "leg_only",
        transaction_id: "tx_1",
        order: 1,
        agent_id: "lumo-flights",
        capability_id: "book_flight",
        // depends_on omitted to simulate older snapshots
        status: "pending",
      },
    ],
  });
  assert.deepEqual(frame.legs[0]?.depends_on, []);
});

t("status normalization stays within SSE v2 status vocabulary", () => {
  assert.equal(normalizeDispatchStatus("authorized"), "pending");
  assert.equal(normalizeDispatchStatus("awaiting_confirmation"), "pending");
  assert.equal(normalizeDispatchStatus("skipped"), "pending");
  assert.equal(normalizeDispatchStatus("rollback_in_flight"), "rollback_pending");
  assert.equal(normalizeDispatchStatus("made_up"), "manual_review");
});

t("chat shell parses, stores, replays, and renders compound dispatch frames", () => {
  assert.match(page, /assistantCompoundDispatchToUI\(frame\.value\)/);
  assert.match(page, /raw\["compoundDispatch"\]/);
  assert.match(page, /CompoundLegStrip payload=\{m\.compoundDispatch\}/);
  assert.match(historyReplay, /event\.frame_type === "assistant_compound_dispatch"/);
  assert.match(historyReplay, /compoundDispatch/);
});

t("component subscribes to compound stream and updates leg statuses from leg_status events", () => {
  assert.match(component, /new EventSource\(url\)/);
  assert.match(
    component,
    /\/api\/compound\/transactions\/\$\{encodeURIComponent\(payload\.compound_transaction_id\)\}\/stream/,
  );
  assert.match(component, /addEventListener\("leg_status"/);
  assert.match(component, /\[frame\.leg_id\]: frame\.status/);
  assert.match(component, /data-settled=\{settled \? "true" : "false"\}/);
});

t("compound stream replays ordered events and closes on terminal compound state", () => {
  assert.match(persistence, /order\("occurred_at", \{ ascending: true \}\)/);
  assert.match(persistence, /order\("id", \{ ascending: true \}\)/);
  assert.match(streamRoute, /readCompoundStatusForUser/);
  assert.match(streamRoute, /isTerminalCompoundStatus/);
});

t("demo path creates a real compound transaction before emitting dispatch", () => {
  assert.match(demoDispatch, /createCompoundTransaction/);
  assert.match(demoDispatch, /loadCompoundSnapshotForUser/);
  assert.match(demoDispatch, /buildAssistantCompoundDispatchFrame/);
  assert.match(demoDispatch, /demo:vegas-weekend:\$\{sessionId\}/);
  assert.match(orchestrator, /maybeCreateVegasWeekendCompoundDispatch/);
  assert.match(orchestrator, /type: "assistant_compound_dispatch"/);
});

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
