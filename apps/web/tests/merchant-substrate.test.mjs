/**
 * MERCHANT-1 regression suite.
 *
 * Run: node --experimental-strip-types tests/merchant-substrate.test.mjs
 */

import assert from "node:assert/strict";
import { createHash, createSign, generateKeyPairSync } from "node:crypto";
import { readFileSync } from "node:fs";
import https from "node:https";
import nock from "nock";
import stubMerchantAgent from "../../../samples/stub-merchant-1/src/index.ts";
import {
  createSampleContext,
  invokeSampleAgent,
} from "../../../samples/_shared/runtime.ts";
import {
  assertCostWithinManifest,
  validateSampleManifestFile,
} from "../../../samples/_shared/validation.ts";
import {
  fingerprintConfirmationPublicKey,
  verifyDigestSignature,
} from "../lib/merchant/confirmation-crypto.ts";
import { validateMerchantManifest } from "../../../packages/lumo-agent-sdk/src/manifest.ts";

let pass = 0;
let fail = 0;
const t = async (name, fn) => {
  try {
    await fn();
    pass++;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    fail++;
    console.log(`  ✗ ${name}\n    ${error.stack ?? error.message}`);
  }
};

console.log("\nmerchant-1 substrate");

const migration043 = readFileSync("../../db/migrations/043_merchant_1_substrate.sql", "utf8");
const confirmRoute = readFileSync("app/api/payments/confirm-transaction/route.ts", "utf8");
const webhookRoute = readFileSync("app/api/payments/webhooks/stripe/route.ts", "utf8");
const setupIntentRoute = readFileSync("app/api/payments/setup-intent/route.ts", "utf8");
const methodsRoute = readFileSync("app/api/payments/methods/route.ts", "utf8");
const stripeLib = readFileSync("lib/merchant/stripe.ts", "utf8");
const methodPostRoutePath = "app/api/payments/methods/route.ts";
const sampleManifest = JSON.parse(
  readFileSync("../../samples/stub-merchant-1/lumo-agent.json", "utf8"),
);

await t("migration 043 declares the merchant ledger and rollback contract", () => {
  for (const table of [
    "merchant_provider_credentials",
    "transactions",
    "transaction_legs",
    "payments_customers",
    "payment_methods",
    "confirmation_keys",
    "stripe_webhook_events",
  ]) {
    assert.match(migration043, new RegExp(`create table if not exists public\\.${table}`));
  }
  assert.match(migration043, /drop table if exists public\.stripe_webhook_events;/);
  assert.match(migration043, /status\s+text not null default 'draft'/);
  assert.match(migration043, /status\s+text not null default 'pending'/);
  assert.match(migration043, /unique \(user_id, device_id\)/);
  assert.match(migration043, /alter table public\.transactions enable row level security/);
  assert.match(migration043, /public\.transactions_retry_safe_append_only/);
  assert.match(migration043, /public\.transaction_legs_retry_safe_append_only/);
});

await t("payment routes preserve MOBILE-PAYMENTS-1 JSON contract", () => {
  assert.match(stripeLib, /stub: false/);
  assert.match(setupIntentRoute, /createSetupIntent/);
  assert.match(stripeLib, /clientSecret/);
  assert.match(stripeLib, /setupIntentId/);
  assert.match(stripeLib, /customerId/);

  assert.match(methodsRoute, /methods/);
  assert.doesNotMatch(methodsRoute, /export async function POST/);
  assert.equal(methodPostRoutePath.endsWith("route.ts"), true);

  for (const field of [
    "paymentMethodId",
    "amountCents",
    "currency",
    "lineItems",
    "transactionDigest",
    "signedConfirmationToken",
  ]) {
    assert.match(confirmRoute, new RegExp(field));
  }
  assert.match(confirmRoute, /buildReceipt/);
  assert.match(confirmRoute, /status: receiptStatus/);
  assert.match(confirmRoute, /verifyConfirmationToken/);
  assert.doesNotMatch(confirmRoute, /x-lumo-user-id/);
});

await t("confirmation token crypto signs and verifies ECDSA-P256 digests", () => {
  const { privateKey, publicKey } = generateKeyPairSync("ec", {
    namedCurve: "P-256",
  });
  const publicKeyPem = publicKey.export({ format: "pem", type: "spki" }).toString();
  const digest = createHash("sha256").update("merchant-confirmation").digest("hex");
  const signer = createSign("sha256");
  signer.update(Buffer.from(digest, "hex"));
  signer.end();
  const signature = signer.sign(privateKey).toString("base64");

  assert.equal(
    verifyDigestSignature({
      publicKeyPem,
      transactionDigestHex: digest,
      signatureBase64: signature,
    }),
    true,
  );
  assert.equal(
    verifyDigestSignature({
      publicKeyPem,
      transactionDigestHex: createHash("sha256").update("tamper").digest("hex"),
      signatureBase64: signature,
    }),
    false,
  );
  assert.match(fingerprintConfirmationPublicKey(publicKeyPem), /^[a-f0-9]{64}$/);
});

await t("stripe test-mode request shape is nock-mockable for PaymentIntent creation", async () => {
  const scope = nock("https://api.stripe.com", {
    reqheaders: {
      authorization: /Bearer sk_test_/,
    },
  })
    .post("/v1/payment_intents", (body) => {
      const values =
        typeof body === "string"
          ? Object.fromEntries(new URLSearchParams(body))
          : (body ?? {});
      return values.amount === "100" && values.currency === "usd" && values.confirm === "true";
    })
    .reply(200, {
      id: "pi_merchant_test_001",
      object: "payment_intent",
      amount: 100,
      amount_received: 100,
      currency: "usd",
      status: "succeeded",
    });

  const response = await httpsPost("https://api.stripe.com/v1/payment_intents", {
    amount: "100",
    currency: "usd",
    customer: "cus_merchant_test_001",
    payment_method: "pm_card_visa",
    confirm: "true",
  });

  assert.equal(response.statusCode, 200);
  assert.equal(JSON.parse(response.body).id, "pi_merchant_test_001");
  scope.done();
});

await t("webhook handler dedupes Stripe retries by event id", () => {
  assert.match(webhookRoute, /constructStripeWebhookEvent/);
  assert.match(webhookRoute, /stripe_webhook_events/);
  assert.match(webhookRoute, /duplicate: true/);
  assert.match(webhookRoute, /payment_intent\.succeeded/);
  assert.match(webhookRoute, /charge\.refunded/);
});

await t("merchant manifest validation enforces commerce block and compensation", () => {
  assert.deepEqual(validateMerchantManifest(sampleManifest), { ok: true, errors: [] });

  const missingCommerce = {
    ...sampleManifest,
    commerce: undefined,
  };
  const commerceResult = validateMerchantManifest(missingCommerce);
  assert.equal(commerceResult.ok, false);
  assert.match(commerceResult.errors.join("\n"), /commerce block/);

  const missingCompensation = {
    ...sampleManifest,
    transaction_capabilities: [
      {
        ...sampleManifest.transaction_capabilities[0],
        compensation_action_capability_id: undefined,
      },
    ],
  };
  const compensationResult = validateMerchantManifest(missingCompensation);
  assert.equal(compensationResult.ok, false);
  assert.match(compensationResult.errors.join("\n"), /compensation_action_capability_id/);
});

await t("stub merchant agent validates and executes deterministic $1 flow", async () => {
  const validation = validateSampleManifestFile(
    "../../samples/stub-merchant-1/lumo-agent.json",
  );
  assert.deepEqual(validation.errors, []);

  const ctx = createSampleContext({
    request_id: "merchant_regression_001",
    connectors: {
      "stripe-payments": {
        createPaymentIntent: async () => ({
          payment_intent_id: "pi_merchant_regression_001",
          transaction_id: "txn_merchant_regression_001",
        }),
      },
      "mock-merchant": {
        reserve: async () => ({ reservation_id: "res_merchant_regression_001" }),
      },
    },
  });
  const result = await invokeSampleAgent(
    stubMerchantAgent,
    "book_test_reservation",
    {
      confirmed: true,
      idempotency_key: "merchant_regression_001",
      payment_method_id: "pm_card_visa_lumo_test",
    },
    ctx,
  );

  assert.equal(result.status, "succeeded");
  assert.equal((result.outputs ?? {}).amount_cents, 100);
  assert.equal((result.outputs ?? {}).payment_intent_id, "pi_merchant_regression_001");
  assertCostWithinManifest(validation, result.cost_actuals.usd);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);

function httpsPost(urlString, form) {
  const url = new URL(urlString);
  const body = new URLSearchParams(form).toString();
  return new Promise((resolve, reject) => {
    const request = https.request(
      {
        hostname: url.hostname,
        path: url.pathname,
        method: "POST",
        headers: {
          authorization: "Bearer sk_test_merchant_1",
          "content-type": "application/x-www-form-urlencoded",
          "content-length": Buffer.byteLength(body),
        },
      },
      (response) => {
        let raw = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => {
          raw += chunk;
        });
        response.on("end", () => {
          resolve({ statusCode: response.statusCode, body: raw });
        });
      },
    );
    request.on("error", reject);
    request.write(body);
    request.end();
  });
}
