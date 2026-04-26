/**
 * Pure-helper tests for the MissionCard. Component rendering is exercised
 * at the page level once the workspace wiring lands; these tests cover
 * the state-accent, progress-summary, time-format, cancellability, and
 * agent-label helpers that the card depends on.
 *
 * Run: node --experimental-strip-types tests/mission-card-helpers.test.mjs
 */

import assert from "node:assert/strict";
import {
  formatMissionRelative,
  isMissionCancellable,
  missionStateAccent,
  readableAgentTool,
  stepStatusIcon,
  summarizeMissionProgress,
} from "../lib/mission-card-helpers.ts";

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

console.log("\nmission card helpers");

t("missionStateAccent returns distinct CSS vars for every mission state", () => {
  const states = [
    "draft",
    "awaiting_permissions",
    "awaiting_user_input",
    "awaiting_confirmation",
    "ready",
    "executing",
    "completed",
    "failed",
    "rolling_back",
    "rolled_back",
  ];
  const vars = states.map((s) => missionStateAccent(s).varName);
  const unique = new Set(vars);
  assert.equal(unique.size, states.length, "expected one CSS var per state");
  for (const v of vars) {
    assert.ok(
      v.startsWith("--lumo-mission-state"),
      `var ${v} did not match prefix`,
    );
  }
  // Labels and icons should be non-empty for every state.
  for (const s of states) {
    const a = missionStateAccent(s);
    assert.ok(a.label.length > 0, `label for ${s} empty`);
    assert.ok(a.icon.length > 0, `icon for ${s} empty`);
  }
});

t("missionStateAccent labels match the K10 spec", () => {
  assert.equal(missionStateAccent("draft").label, "Drafting");
  assert.equal(missionStateAccent("awaiting_permissions").label, "Needs permissions");
  assert.equal(missionStateAccent("awaiting_user_input").label, "Needs your input");
  assert.equal(missionStateAccent("awaiting_confirmation").label, "Awaiting confirmation");
  assert.equal(missionStateAccent("ready").label, "Queued");
  assert.equal(missionStateAccent("executing").label, "In flight");
  assert.equal(missionStateAccent("completed").label, "Done");
  assert.equal(missionStateAccent("failed").label, "Failed");
  assert.equal(missionStateAccent("rolling_back").label, "Rolling back");
  assert.equal(missionStateAccent("rolled_back").label, "Rolled back");
});

t("summarizeMissionProgress reports 100 percent when every step succeeded", () => {
  const mission = {
    id: "m1",
    state: "completed",
    intent_text: "trip to vegas",
    created_at: "2026-04-26T11:00:00Z",
    updated_at: "2026-04-26T12:00:00Z",
    steps: [
      step("s1", 0, "succeeded"),
      step("s2", 1, "succeeded"),
      step("s3", 2, "succeeded"),
    ],
  };
  const s = summarizeMissionProgress(mission);
  assert.equal(s.total, 3);
  assert.equal(s.succeeded, 3);
  assert.equal(s.in_flight, 0);
  assert.equal(s.remaining, 0);
  assert.equal(s.failed, 0);
  assert.equal(s.percent, 100);
});

t("summarizeMissionProgress counts mixed statuses correctly", () => {
  const mission = {
    id: "m2",
    state: "executing",
    intent_text: "trip to vegas",
    created_at: "2026-04-26T11:00:00Z",
    updated_at: "2026-04-26T12:00:00Z",
    steps: [
      step("a", 0, "succeeded"),
      step("b", 1, "succeeded"),
      step("c", 2, "succeeded"),
      step("d", 3, "running"),
      step("e", 4, "ready"),
      step("f", 5, "awaiting_confirmation"),
      step("g", 6, "pending"),
      step("h", 7, "pending"),
      step("i", 8, "failed"),
      step("j", 9, "skipped"),
      step("k", 10, "rolled_back"),
    ],
  };
  const s = summarizeMissionProgress(mission);
  assert.equal(s.total, 11);
  assert.equal(s.succeeded, 3);
  assert.equal(s.in_flight, 3, "running + ready + awaiting_confirmation");
  assert.equal(s.remaining, 2);
  assert.equal(s.failed, 1);
  assert.equal(s.skipped, 1);
  assert.equal(s.rolled_back, 1);
  // 3/11 → 27 (floored)
  assert.equal(s.percent, 27);
  // All buckets must add up to total.
  assert.equal(
    s.succeeded + s.in_flight + s.remaining + s.failed + s.skipped + s.rolled_back,
    s.total,
  );
});

t("summarizeMissionProgress is defensive against empty / missing steps", () => {
  const empty = summarizeMissionProgress({
    id: "m3",
    state: "draft",
    intent_text: "",
    created_at: "2026-04-26T11:00:00Z",
    updated_at: "2026-04-26T11:00:00Z",
    steps: [],
  });
  assert.equal(empty.total, 0);
  assert.equal(empty.percent, 0);
});

t("formatMissionRelative matches the proactive moment card pattern", () => {
  const now = Date.parse("2026-04-26T12:00:00Z");
  assert.equal(formatMissionRelative("2026-04-26T11:59:30Z", now), "just now");
  assert.equal(formatMissionRelative("2026-04-26T11:48:00Z", now), "12m ago");
  assert.equal(formatMissionRelative("2026-04-26T09:00:00Z", now), "3h ago");
  assert.equal(formatMissionRelative("2026-04-25T12:00:00Z", now), "yesterday");
  assert.equal(formatMissionRelative("2026-04-23T12:00:00Z", now), "3d ago");
  // Future timestamps render as "scheduled".
  assert.equal(formatMissionRelative("2026-04-27T12:00:00Z", now), "scheduled");
  // Bad input never throws.
  assert.equal(formatMissionRelative("", now), "");
  assert.equal(formatMissionRelative("not-a-date", now), "");
});

t("isMissionCancellable allows in-flight states and rejects terminal ones", () => {
  // Cancellable: any state where the mission still has work to do or is
  // waiting on a human.
  for (const state of [
    "draft",
    "awaiting_permissions",
    "awaiting_user_input",
    "ready",
    "executing",
    "awaiting_confirmation",
  ]) {
    assert.equal(
      isMissionCancellable(state),
      true,
      `expected ${state} to be cancellable`,
    );
  }
  // Not cancellable: terminal-success, terminal-failure, rolled-back,
  // and the D5 transient `rolling_back` state.
  for (const state of ["completed", "failed", "rolled_back", "rolling_back"]) {
    assert.equal(
      isMissionCancellable(state),
      false,
      `expected ${state} to NOT be cancellable`,
    );
  }
});

t("readableAgentTool produces friendly labels for known agents", () => {
  assert.equal(
    readableAgentTool("hotel", "mission.book_hotel"),
    "Lumo Hotels — book hotel",
  );
  assert.equal(
    readableAgentTool("flight", "mission.search_flights"),
    "Lumo Flights — search flights",
  );
  assert.equal(
    readableAgentTool("open-maps", "mission.plan_route"),
    "Lumo Maps — plan route",
  );
});

t("readableAgentTool falls back to 'agent · tool' for unknown agents", () => {
  assert.equal(
    readableAgentTool("third-party-x", "do_thing"),
    "third-party-x · do_thing",
  );
});

t("stepStatusIcon covers every MissionStepStatus with non-empty glyphs", () => {
  const statuses = [
    "pending",
    "ready",
    "running",
    "awaiting_confirmation",
    "succeeded",
    "failed",
    "rolled_back",
    "skipped",
  ];
  for (const s of statuses) {
    const icon = stepStatusIcon(s);
    assert.ok(icon.glyph.length > 0, `glyph for ${s} empty`);
    assert.ok(icon.label.length > 0, `label for ${s} empty`);
  }
  // Specific spec mappings.
  assert.equal(stepStatusIcon("succeeded").glyph, "✓");
  assert.equal(stepStatusIcon("running").glyph, "⏵");
  assert.equal(stepStatusIcon("pending").glyph, "○");
  assert.equal(stepStatusIcon("awaiting_confirmation").glyph, "⏸");
  assert.equal(stepStatusIcon("failed").glyph, "✗");
  assert.equal(stepStatusIcon("rolled_back").glyph, "✗");
  assert.equal(stepStatusIcon("skipped").glyph, "↷");
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);

// ──────────────────────────────────────────────────────────────────────────
// Test fixtures
// ──────────────────────────────────────────────────────────────────────────

function step(id, order, status) {
  return {
    id,
    step_order: order,
    agent_id: "hotel",
    tool_name: "mission.book_hotel",
    status,
    reversibility: "irreversible",
    confirmation_card_id: null,
    started_at: null,
    finished_at: null,
    error_text: null,
  };
}
