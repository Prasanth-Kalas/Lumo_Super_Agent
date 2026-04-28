/**
 * Static smoke test for the Workspace Missions panel wiring.
 *
 * The project does not ship a DOM test runner yet, so this test guards
 * the integration contract that matters for the Sprint 3 surface:
 * /workspace imports the panel, the panel fetches workspace missions,
 * renders MissionCard, and posts user cancels to the D5 rollback route.
 *
 * Run: node --experimental-strip-types tests/workspace-missions-panel.test.mjs
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

console.log("\nworkspace missions panel wiring");

const panelSource = readFileSync(
  new URL("../components/WorkspaceMissionsPanel.tsx", import.meta.url),
  "utf8",
);
const workspaceSource = readFileSync(
  new URL("../app/workspace/page.tsx", import.meta.url),
  "utf8",
);

t("workspace page imports and renders the mission panel", () => {
  assert.match(
    workspaceSource,
    /import \{ WorkspaceMissionsPanel \} from "@\/components\/WorkspaceMissionsPanel";/,
  );
  assert.match(workspaceSource, /<WorkspaceMissionsPanel \/>/);
});

t("panel fetches the recent mission endpoint and renders MissionCard", () => {
  assert.match(panelSource, /\/api\/workspace\/missions\?limit=5/);
  assert.match(panelSource, /<MissionCard/);
  assert.match(panelSource, /No active missions/);
});

t("panel renders mission-control counts and filters", () => {
  assert.match(panelSource, /missionControlCounts/);
  assert.match(panelSource, /missionMatchesControlFilter/);
  assert.match(panelSource, /Mission Control/);
  assert.match(panelSource, /Needs you/);
});

t("panel posts cancel actions to the D5 rollback route", () => {
  assert.match(panelSource, /\/api\/missions\/\$\{encodeURIComponent\(id\)\}\/cancel/);
  assert.match(panelSource, /method: "POST"/);
  assert.match(panelSource, /workspace_cancel/);
});

if (fail > 0) {
  console.error(`\n${fail} failed, ${pass} passed`);
  process.exit(1);
}
console.log(`\n${pass} passed`);
