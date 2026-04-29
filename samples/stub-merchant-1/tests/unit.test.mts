import assert from "node:assert/strict";
import agent from "../src/index.ts";
import {
  createSampleContext,
  invokeSampleAgent,
} from "../../_shared/runtime.ts";
import { validateSampleManifestFile } from "../../_shared/validation.ts";

const validation = validateSampleManifestFile(
  new URL("../lumo-agent.json", import.meta.url).pathname,
);

assert.deepEqual(validation.errors, []);
assert.equal((agent.manifest as { agent_class?: string }).agent_class, "merchant_of_record");

const confirmation = await invokeSampleAgent(
  agent,
  "book_test_reservation",
  { idempotency_key: "merchant_unit_001" },
  createSampleContext({ request_id: "merchant_unit_001" }),
);

assert.equal(confirmation.status, "needs_confirmation");
assert.equal(confirmation.confirmation_card?.amount_cents, 100);
assert.equal(confirmation.confirmation_card?.currency, "USD");
assert.equal(confirmation.confirmation_card?.reversibility, "compensating");
assert.match(confirmation.confirmation_card?.side_effect_summary ?? "", /Stripe/);

const refund = await invokeSampleAgent(
  agent,
  "refund_test_reservation",
  { payment_intent_id: "pi_unit_001", amount_cents: 100 },
  createSampleContext({
    connectors: {
      "stripe-payments": {
        refundPaymentIntent: async () => ({ refund_id: "re_unit_001" }),
      },
    },
  }),
);

assert.equal(refund.status, "succeeded");
assert.equal((refund.outputs as { refund_id: string }).refund_id, "re_unit_001");
