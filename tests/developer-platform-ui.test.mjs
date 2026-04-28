/**
 * Developer platform launchpad helper tests.
 *
 * Run: node --experimental-strip-types tests/developer-platform-ui.test.mjs
 */

import assert from "node:assert/strict";
import {
  buildDeveloperLaunchSteps,
  developerLaunchStatusLabel,
  developerPlatformStats,
  developerPlatformSummary,
} from "../lib/developer-platform-ui.ts";

let pass = 0;
let fail = 0;
const t = async (name, fn) => {
  try {
    await fn();
    pass++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    fail++;
    console.log(`  ✗ ${name}\n    ${e.message}`);
  }
};

console.log("\ndeveloper platform UI helpers");

await t("stats bucket submissions by review posture", () => {
  const stats = developerPlatformStats([
    { status: "approved" },
    { status: "pending" },
    { status: "certification_failed" },
    { status: "rejected" },
  ]);
  assert.deepEqual(stats, {
    total: 4,
    approved: 1,
    inReview: 1,
    blocked: 2,
  });
});

await t("summary guides a fresh developer to the first action", () => {
  assert.equal(
    developerPlatformSummary([]),
    "Start with the template, run checks, then submit a manifest.",
  );
});

await t("launch steps advance after a passed preflight", () => {
  const steps = buildDeveloperLaunchSteps({
    manifestUrl: "https://agent.example.com/.well-known/agent.json",
    preflight: { status: "passed" },
    submissions: [],
  });
  assert.deepEqual(
    steps.map((step) => [step.id, step.status]),
    [
      ["starter", "done"],
      ["certify", "done"],
      ["submit", "active"],
      ["publish", "idle"],
    ],
  );
});

await t("blocked preflight keeps submit idle", () => {
  const steps = buildDeveloperLaunchSteps({
    manifestUrl: "https://agent.example.com/.well-known/agent.json",
    preflight: { status: "failed" },
    submissions: [],
  });
  assert.equal(steps.find((step) => step.id === "certify")?.status, "blocked");
  assert.equal(steps.find((step) => step.id === "submit")?.status, "idle");
});

await t("approved submission marks publish done", () => {
  const steps = buildDeveloperLaunchSteps({
    submissions: [{ status: "approved", certification_status: "passed" }],
  });
  assert.equal(steps.find((step) => step.id === "publish")?.status, "done");
  assert.equal(
    developerPlatformSummary([{ status: "approved" }]),
    "1 live agent · 0 in review · 0 blocked",
  );
});

await t("status labels are short enough for small pills", () => {
  assert.equal(developerLaunchStatusLabel("done"), "Done");
  assert.equal(developerLaunchStatusLabel("active"), "Next");
  assert.equal(developerLaunchStatusLabel("blocked"), "Fix");
  assert.equal(developerLaunchStatusLabel("idle"), "Later");
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
