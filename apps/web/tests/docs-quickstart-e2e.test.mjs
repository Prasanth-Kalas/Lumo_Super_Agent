/**
 * Nightly quickstart smoke.
 *
 * The public docs point authors at the SAMPLE-AGENTS suite as the known-good
 * first-agent path. This test runs that suite and checks that the docs still
 * advertise the same commands.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

console.log("\ndocs quickstart e2e");

const quickstart = readFileSync("../../docs/developers/quickstart.md", "utf8");
const examples = readFileSync("../../docs/developers/example-agents.md", "utf8");

assert.match(quickstart, /npx lumo-agent validate/);
assert.match(quickstart, /npx lumo-agent sign/);
assert.match(examples, /tests\/sample-agents-ci\.test\.mjs/);

const result = spawnSync(
  process.execPath,
  ["--experimental-strip-types", "tests/sample-agents-ci.test.mjs"],
  { cwd: new URL("..", import.meta.url), encoding: "utf8" },
);

if (result.status !== 0) {
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
  throw new Error("sample agents quickstart failed");
}

console.log("  ✓ sample agents quickstart suite passed");
