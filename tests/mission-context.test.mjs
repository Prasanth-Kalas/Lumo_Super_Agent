/**
 * Mission context resolver regression tests.
 *
 * Run: node --experimental-strip-types tests/mission-context.test.mjs
 */

import assert from "node:assert/strict";
import {
  buildMissionContinueText,
  isMissionContinueApproval,
  selectMissionPlanningRequest,
} from "../lib/mission-context.ts";

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

console.log("\nmission context");

t("keeps the original Vegas mission through greeting follow-ups", () => {
  const request = selectMissionPlanningRequest([
    user("hey can you plan a trip for me to vegas from california from next day for a week"),
    assistant("Which city in California are you flying from?"),
    user("hello"),
  ]);
  assert.equal(
    request,
    "hey can you plan a trip for me to vegas from california from next day for a week",
  );
});

t("does not reduce a mission to waiting-for-flight chatter", () => {
  const request = selectMissionPlanningRequest([
    user("hey can you plan a trip for me to vegas from california from next day for a week"),
    assistant("Which city in California are you flying from?"),
    user("yeah I'm waiting for the flights"),
  ]);
  assert.match(request, /plan a trip/i);
  assert.notEqual(request, "yeah I'm waiting for the flights");
});

t("adds short slot answers to the prior mission instead of replacing it", () => {
  const request = selectMissionPlanningRequest([
    user("Plan a trip to Vegas from California for a week."),
    assistant("Which city in California are you flying from?"),
    user("San Francisco"),
  ]);
  assert.match(request, /Plan a trip to Vegas/);
  assert.match(request, /departing from San Francisco/);
});

t("continue card text resumes the mission request", () => {
  const text = buildMissionContinueText("Plan a trip to Vegas.");
  assert.equal(isMissionContinueApproval(text), true);
  assert.equal(selectMissionPlanningRequest([user(text)]), "Plan a trip to Vegas.");
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);

function user(content) {
  return { role: "user", content };
}

function assistant(content) {
  return { role: "assistant", content };
}
