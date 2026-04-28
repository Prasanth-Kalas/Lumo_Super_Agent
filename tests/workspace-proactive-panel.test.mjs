/**
 * Static smoke test for the workspace Proactive Lumo panel wiring.
 *
 * The project does not ship a DOM test runner yet, so this guards the
 * integration contract: fetch pending moments, render cards, patch act/dismiss,
 * and expose the summary/filter controls that make the surface usable.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

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

console.log("\nworkspace proactive panel wiring");

const workspaceSource = readFileSync(
  new URL("../app/workspace/page.tsx", import.meta.url),
  "utf8",
);

t("panel fetches workspace proactive moments and renders cards", () => {
  assert.match(workspaceSource, /\/api\/workspace\/proactive-moments/);
  assert.match(workspaceSource, /<ProactiveMomentCard/);
  assert.match(workspaceSource, /Proactive Lumo/);
});

t("panel exposes proactive summary counts and filters", () => {
  assert.match(workspaceSource, /proactiveMomentCounts/);
  assert.match(workspaceSource, /proactiveMomentMatchesFilter/);
  assert.match(workspaceSource, /Urgent/);
  assert.match(workspaceSource, /Actionable/);
  assert.match(workspaceSource, /Watching/);
});

t("panel patches acted-on and dismissed actions", () => {
  assert.match(workspaceSource, /\/api\/proactive-moments\/\$\{encodeURIComponent\(id\)\}/);
  assert.match(workspaceSource, /status: "acted_on"/);
  assert.match(workspaceSource, /updateMoment\(id, "dismissed"\)/);
});

if (fail > 0) {
  console.error(`\n${fail} failed, ${pass} passed`);
  process.exit(1);
}
console.log(`\n${pass} passed`);
