/**
 * Registry config load-path helpers.
 *
 * Run: node --experimental-strip-types tests/registry-config.test.mjs
 */

import assert from "node:assert/strict";
import { enabledRegistryAgents } from "../lib/registry-config.ts";

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

console.log("\nregistry config");

t("enabled=false rows are excluded before registry fetch", () => {
  const config = {
    agents: [
      {
        key: "lumo-ml",
        enabled: false,
        system: true,
        base_url: "http://127.0.0.1:3010",
        version: "0.1.0",
      },
      {
        key: "food",
        enabled: true,
        base_url: "http://127.0.0.1:3001",
        version: "0.1.0",
      },
    ],
  };

  assert.deepEqual(enabledRegistryAgents(config).map((agent) => agent.key), ["food"]);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
