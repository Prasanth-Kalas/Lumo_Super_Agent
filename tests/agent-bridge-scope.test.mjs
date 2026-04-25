/**
 * System-agent bridge eligibility matrix.
 *
 * Run: node --experimental-strip-types tests/agent-bridge-scope.test.mjs
 */

import assert from "node:assert/strict";
import { filterBridgeForUser } from "../lib/agent-bridge-scope.ts";

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

console.log("\nsystem-agent bridge scope");

t("authenticated user sees healthy system agent without install", () => {
  const bridge = scoped([agent("lumo-ml", { system: true })], {
    allowPublicWithoutInstall: false,
  });
  assert.deepEqual(toolNames(bridge), ["lumo_rank_agents"]);
});

t("anonymous user does not see system agent even when connect.model is none", () => {
  const bridge = scoped([agent("lumo-ml", { system: true })], {
    allowPublicWithoutInstall: true,
  });
  assert.deepEqual(toolNames(bridge), []);
});

t("enabled=false system agent is excluded because it is absent from entries", () => {
  const bridge = scoped([], { allowPublicWithoutInstall: false });
  assert.deepEqual(toolNames(bridge), []);
});

t("unhealthy system agent is excluded", () => {
  const bridge = scoped([agent("lumo-ml", { system: true, health_score: 0.2 })], {
    allowPublicWithoutInstall: false,
  });
  assert.deepEqual(toolNames(bridge), []);
});

t("partner manifest system claim is ignored unless registry entry owns system bit", () => {
  const bridge = scoped(
    [agent("partner-agent", { manifestSystemClaim: true, connectModel: "oauth2" })],
    { allowPublicWithoutInstall: false },
  );
  assert.deepEqual(toolNames(bridge), []);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);

function scoped(entries, opts = {}) {
  return filterBridgeForUser(
    {
      tools: [
        { name: "lumo_rank_agents", description: "", input_schema: { type: "object", properties: {} } },
        { name: "partner_tool", description: "", input_schema: { type: "object", properties: {} } },
      ],
      routing: {
        lumo_rank_agents: { agent_id: "lumo-ml" },
        partner_tool: { agent_id: "partner-agent" },
      },
    },
    entries,
    new Set(opts.connected ?? []),
    new Set(opts.installed ?? []),
    opts.minScore ?? 0.6,
    opts.allowPublicWithoutInstall ?? false,
  );
}

function agent(agent_id, opts = {}) {
  return {
    system: opts.system,
    health_score: opts.health_score ?? 1,
    manifest: {
      agent_id,
      system: opts.manifestSystemClaim,
      connect: { model: opts.connectModel ?? "none" },
    },
  };
}

function toolNames(bridge) {
  return bridge.tools.map((t) => t.name).sort();
}
