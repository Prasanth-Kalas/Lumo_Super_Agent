/**
 * Pure-helper tests for the user-side recent-missions endpoint
 * (Sprint 3 / K11). Covers the row-grouping + trim helpers in
 * `lib/workspace-missions-core.ts` — the DB glue and the route handler
 * are covered separately at integration time.
 *
 * Run: node --experimental-strip-types tests/workspace-missions.test.mjs
 */

import assert from "node:assert/strict";
import {
  rowsToMissionCardData,
  trimRecentMissions,
} from "../lib/workspace-missions-core.ts";

let pass = 0;
let fail = 0;
const t = (name, fn) => {
  try {
    fn();
    pass++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    fail++;
    console.log(`  ✗ ${name}\n    ${e.message}`);
  }
};

const mission = (overrides = {}) => ({
  id: "m1",
  user_id: "u1",
  state: "executing",
  intent_text: "Book me a hotel in Goa",
  created_at: "2026-04-26T10:00:00Z",
  updated_at: "2026-04-26T11:00:00Z",
  ...overrides,
});

const step = (overrides = {}) => ({
  id: "s1",
  mission_id: "m1",
  step_order: 0,
  agent_id: "hotel",
  tool_name: "mission.book_hotel",
  status: "pending",
  reversibility: "reversible",
  confirmation_card_id: null,
  started_at: null,
  finished_at: null,
  error_text: null,
  ...overrides,
});

console.log("\nworkspace missions core helpers");

t("rowsToMissionCardData with empty missions returns []", () => {
  assert.deepEqual(rowsToMissionCardData([], []), []);
  assert.deepEqual(rowsToMissionCardData(null, null), []);
  assert.deepEqual(rowsToMissionCardData(undefined, undefined), []);
  assert.deepEqual(rowsToMissionCardData([], [step()]), []);
});

t("rowsToMissionCardData with 1 mission + 3 steps sorts steps by step_order ASC", () => {
  const missions = [mission({ id: "m1" })];
  // intentionally out of order — helper must sort
  const steps = [
    step({ id: "s3", mission_id: "m1", step_order: 2, tool_name: "mission.confirm" }),
    step({ id: "s1", mission_id: "m1", step_order: 0, tool_name: "mission.search" }),
    step({ id: "s2", mission_id: "m1", step_order: 1, tool_name: "mission.select" }),
  ];
  const out = rowsToMissionCardData(missions, steps);
  assert.equal(out.length, 1);
  assert.equal(out[0].id, "m1");
  assert.equal(out[0].steps.length, 3);
  assert.deepEqual(
    out[0].steps.map((s) => s.step_order),
    [0, 1, 2],
  );
  assert.deepEqual(
    out[0].steps.map((s) => s.id),
    ["s1", "s2", "s3"],
  );
  // The card's required fields survived the round-trip.
  assert.equal(out[0].state, "executing");
  assert.equal(out[0].intent_text, "Book me a hotel in Goa");
});

t("rowsToMissionCardData with 2 missions + steps groups them correctly", () => {
  const missions = [
    mission({ id: "m1", updated_at: "2026-04-26T11:00:00Z" }),
    mission({ id: "m2", updated_at: "2026-04-26T10:00:00Z", intent_text: "second" }),
  ];
  const steps = [
    step({ id: "s1", mission_id: "m1", step_order: 0 }),
    step({ id: "s2", mission_id: "m2", step_order: 1 }),
    step({ id: "s3", mission_id: "m1", step_order: 1 }),
    step({ id: "s4", mission_id: "m2", step_order: 0 }),
  ];
  const out = rowsToMissionCardData(missions, steps);
  assert.equal(out.length, 2);
  // Order preserved from input (caller controls sort).
  assert.equal(out[0].id, "m1");
  assert.equal(out[1].id, "m2");
  assert.deepEqual(out[0].steps.map((s) => s.id), ["s1", "s3"]);
  assert.deepEqual(out[1].steps.map((s) => s.id), ["s4", "s2"]);
});

t("rowsToMissionCardData drops steps with no matching mission silently", () => {
  const missions = [mission({ id: "m1" })];
  const steps = [
    step({ id: "s1", mission_id: "m1", step_order: 0 }),
    step({ id: "s_orphan", mission_id: "m_does_not_exist", step_order: 0 }),
    step({ id: "s2", mission_id: "m1", step_order: 1 }),
  ];
  const out = rowsToMissionCardData(missions, steps);
  assert.equal(out.length, 1);
  assert.equal(out[0].steps.length, 2);
  assert.deepEqual(
    out[0].steps.map((s) => s.id),
    ["s1", "s2"],
  );
  // No step for the orphan mission_id should leak through.
  assert.ok(!out[0].steps.some((s) => s.id === "s_orphan"));
});

t("rowsToMissionCardData drops malformed rows quietly", () => {
  // Missing required fields → silently dropped, doesn't throw.
  const missions = [
    mission({ id: "m1" }),
    { id: "m2" }, // missing state/created_at/updated_at — dropped
    null,
    "not a row",
  ];
  const steps = [
    step({ id: "s1", mission_id: "m1", step_order: 0 }),
    { id: "s_bad", mission_id: "m1" }, // missing fields — dropped
    null,
  ];
  const out = rowsToMissionCardData(missions, steps);
  assert.equal(out.length, 1);
  assert.equal(out[0].id, "m1");
  assert.equal(out[0].steps.length, 1);
  assert.equal(out[0].steps[0].id, "s1");
});

t("trimRecentMissions sorts by updated_at desc + slices", () => {
  const missions = [
    mission({ id: "old", updated_at: "2026-04-20T00:00:00Z" }),
    mission({ id: "newest", updated_at: "2026-04-26T12:00:00Z" }),
    mission({ id: "middle", updated_at: "2026-04-25T00:00:00Z" }),
    mission({ id: "older", updated_at: "2026-04-22T00:00:00Z" }),
  ];
  const out = trimRecentMissions(missions, 2);
  assert.equal(out.length, 2);
  assert.deepEqual(
    out.map((m) => m.id),
    ["newest", "middle"],
  );
});

t("trimRecentMissions handles a limit larger than input length", () => {
  const missions = [
    mission({ id: "a", updated_at: "2026-04-26T10:00:00Z" }),
    mission({ id: "b", updated_at: "2026-04-26T11:00:00Z" }),
  ];
  const out = trimRecentMissions(missions, 50);
  assert.equal(out.length, 2);
  // Still sorts even when limit > length.
  assert.deepEqual(
    out.map((m) => m.id),
    ["b", "a"],
  );
  // limit <= 0 → empty.
  assert.deepEqual(trimRecentMissions(missions, 0), []);
  assert.deepEqual(trimRecentMissions(missions, -1), []);
  // null/empty input → empty.
  assert.deepEqual(trimRecentMissions(null, 5), []);
  assert.deepEqual(trimRecentMissions([], 5), []);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
