/**
 * WEB-REDESIGN-1 LeftRail source-level contract.
 *
 * Run: node --experimental-strip-types tests/web-redesign-left-rail.test.mjs
 *
 * LeftRail had no AGENTS section at the time WEB-REDESIGN-1 opened
 * (the earlier LeftRail rewrite had moved that surface to /admin/apps),
 * but the brief explicitly required these assertions. They also serve
 * as a regression guard — if someone later restores an Agents panel
 * here, this test fails so the next sprint's reviewer can re-evaluate.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const SRC = readFileSync(
  new URL("../components/LeftRail.tsx", import.meta.url),
  "utf8",
);

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

console.log("\nweb-redesign LeftRail");

t("no BASELINE_AGENTS const", () => {
  assert.equal(/const BASELINE_AGENTS/.test(SRC), false);
});

t("no AgentRow interface", () => {
  assert.equal(/interface AgentRow/.test(SRC), false);
});

t("no Agents section header in render", () => {
  // Allow the word inside a comment line; reject a SectionHeader-style
  // render of "Agents".
  assert.equal(/SectionHeader[^\n]*>\s*Agents\s*</.test(SRC), false);
});

t("no live-connection pill rendering", () => {
  // The removed render referenced connection_status. Make sure no
  // residual reference comes back.
  assert.equal(/connection_status/.test(SRC), false);
});

t("Recent / search / profile chip preserved", () => {
  // Sanity: the surfaces the redesign keeps are still present.
  assert.match(SRC, /Search chats/);
  assert.match(SRC, /onNewChat/);
});

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
