/**
 * WEB-REDESIGN-1 MobileNav source-level contract.
 *
 * Run: node --experimental-strip-types tests/web-redesign-mobile-nav.test.mjs
 *
 * The repo doesn't pull in a React renderer for unit tests, so these
 * assertions read the source file and check the AGENTS section is
 * actually gone — the same pattern web-screens-account.test.mjs uses
 * for the /api/me route. Catches regressions where someone re-adds
 * the BASELINE_AGENTS const or the live connection-status pills.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const SRC = readFileSync(
  new URL("../components/MobileNav.tsx", import.meta.url),
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

console.log("\nweb-redesign MobileNav");

t("BASELINE_AGENTS const is gone", () => {
  assert.equal(/const BASELINE_AGENTS/.test(SRC), false);
});

t("AgentRow interface is gone", () => {
  assert.equal(/interface AgentRow/.test(SRC), false);
});

t("agents state is gone", () => {
  // Allow the word in comments, but the state declaration must be absent.
  assert.equal(/useState<AgentRow\[\]>/.test(SRC), false);
});

t("Agents render section header is gone", () => {
  // The render block had `<SectionHeader ...>Agents</SectionHeader>`.
  assert.equal(/SectionHeader[^\n]*>\s*Agents\s*</.test(SRC), false);
});

t("RECENT section is preserved", () => {
  assert.match(SRC, /SectionHeader[^\n]*>\s*Recent\s*</);
});

t("EXPLORE section is preserved", () => {
  assert.match(SRC, /SectionHeader[^\n]*>\s*Explore\s*</);
});

t("auth footer Sign in / Create account preserved", () => {
  assert.match(SRC, /Create your account/);
  assert.match(SRC, /Sign in/);
  assert.match(SRC, /Account settings/);
});

t("doc comment names WEB-REDESIGN-1 as the removal lane", () => {
  assert.match(SRC, /WEB-REDESIGN-1/);
});

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
