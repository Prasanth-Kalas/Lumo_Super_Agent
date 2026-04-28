import assert from "node:assert/strict";
import agent, { sampleUnreadMessages } from "../src/index.ts";
import {
  createSampleContext,
  invokeSampleAgent,
} from "../../_shared/runtime.ts";
import {
  assertCostWithinManifest,
  validateSampleManifestFile,
} from "../../_shared/validation.ts";

const validation = validateSampleManifestFile(
  new URL("../lumo-agent.json", import.meta.url).pathname,
);
assert.deepEqual(validation.errors, []);

for (const mode of ["dev", "sandbox"] as const) {
  const ctx = createSampleContext({
    request_id: `email_${mode}`,
    connectors: {
      gmail: {
        listUnread: async () => ({ messages: sampleUnreadMessages() }),
      },
    },
    history: async () => [{ capability: "summarize_unread_inbox" }],
  });
  const result = await invokeSampleAgent(
    agent,
    "prepare_morning_digest",
    {},
    ctx,
  );
  const outputs = result.outputs as {
    digest_title: string;
    total_unread: number;
  };

  assert.equal(result.status, "succeeded");
  assert.match(outputs.digest_title, /Morning digest/);
  assert.equal(outputs.total_unread, 3);
  assert.equal(result.provenance_evidence.redaction_applied, true);
  assertCostWithinManifest(validation, result.cost_actuals.usd);
}
