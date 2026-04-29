import assert from "node:assert/strict";
import agent from "../src/index.ts";
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

const ctx = createSampleContext({
  request_id: "merchant_e2e_001",
  connectors: {
    "stripe-payments": {
      createPaymentIntent: async (input: unknown) => ({
        payment_intent_id: "pi_stub_merchant_e2e",
        transaction_id: "txn_stub_merchant_e2e",
        input,
      }),
    },
    "mock-merchant": {
      reserve: async () => ({ reservation_id: "res_stub_merchant_e2e" }),
    },
  },
});

const result = await invokeSampleAgent(
  agent,
  "book_test_reservation",
  {
    confirmed: true,
    idempotency_key: "merchant_e2e_001",
    payment_method_id: "pm_card_visa_lumo_test",
  },
  ctx,
);

assert.equal(result.status, "succeeded");
assert.equal((result.outputs as { payment_intent_id: string }).payment_intent_id, "pi_stub_merchant_e2e");
assert.equal((result.outputs as { reservation_id: string }).reservation_id, "res_stub_merchant_e2e");
assert.deepEqual(
  result.provenance_evidence.sources.map((source) => source.type),
  ["connector.stripe-payments", "connector.mock-merchant", "idempotency"],
);
assertCostWithinManifest(validation, result.cost_actuals.usd);

const cached = await invokeSampleAgent(
  agent,
  "book_test_reservation",
  {
    confirmed: true,
    idempotency_key: "merchant_e2e_001",
    payment_method_id: "pm_card_visa_lumo_test",
  },
  ctx,
);

assert.equal(cached.status, "succeeded");
assert.equal((cached.outputs as { cached?: boolean }).cached, true);
