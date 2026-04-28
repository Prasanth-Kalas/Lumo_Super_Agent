/**
 * Phase-3 master regression test.
 *
 * Runs after every Phase-3 deliverable lands. Wires the seven sub-suites
 * together, fails fast on the first regression. Each sub-suite is also
 * wired into npm run test individually so a deliverable can be tested in
 * isolation.
 *
 * Run: node --experimental-strip-types tests/phase3-regression.test.mjs
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const SUBSUITES = [
  "phase3-knowledge-graph.test.mjs",
  "phase3-graph-rag-recall.test.mjs",
  "phase3-bandit-arms.test.mjs",
  "phase3-bandit-promotion.test.mjs",
  "phase3-voice-consent.test.mjs",
  "phase3-wake-word-privacy.test.mjs",
  "phase3-multimodal-rag.test.mjs",
  "phase3-runtime-intelligence.test.mjs",
  "phase3-brain-sdk.test.mjs",
];

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

console.log("\nphase 3 master regression");

t("all sub-suite files exist", () => {
  for (const f of SUBSUITES) {
    const full = path.join(__dirname, f);
    const r = spawnSync("test", ["-f", full]);
    assert.equal(r.status, 0, `missing: ${full}`);
  }
});

t("master spec sealed (phase-3-master.md present)", () => {
  const r = spawnSync("test", ["-f", path.join(__dirname, "..", "docs", "specs", "phase-3-master.md")]);
  assert.equal(r.status, 0, "phase-3-master.md missing");
});

t("ADRs 008-012 present", () => {
  const adrs = [
    "adr-008-knowledge-graph-substrate.md",
    "adr-009-bandit-algorithm.md",
    "adr-010-wake-word-engine.md",
    "adr-011-multimodal-rag-projection.md",
    "adr-012-voice-cloning-biometric-consent.md",
  ];
  for (const a of adrs) {
    const r = spawnSync("test", ["-f", path.join(__dirname, "..", "docs", "specs", a)]);
    assert.equal(r.status, 0, `missing: ${a}`);
  }
});

t("phase 3 migrations 027-034 scaffolded", () => {
  for (let n = 27; n <= 34; n++) {
    const r = spawnSync("ls", [path.join(__dirname, "..", "db", "migrations")]);
    assert.equal(r.status, 0);
    const files = r.stdout.toString();
    assert.ok(files.includes(`0${n}_`), `missing migration 0${n}_*`);
  }
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
