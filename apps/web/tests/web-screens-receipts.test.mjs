/**
 * WEB-SCREENS-1 receipts helpers + refund stub.
 *
 * Run: node --experimental-strip-types tests/web-screens-receipts.test.mjs
 */

import assert from "node:assert/strict";
import {
  formatCents,
  formatTransactionStatus,
  isRefundable,
  providerLabel,
  statusPillClass,
  totalDisplayCents,
} from "../lib/web-screens-receipts.ts";
import {
  __resetForTesting,
  listRefundRequestsForUser,
  recordRefundRequest,
} from "../lib/refund-requests-stub.ts";

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

console.log("\nweb-screens receipts helpers");

const baseTx = {
  id: "txn_1",
  user_id: "user_1",
  agent_id: "lumo.travel.duffel",
  agent_version: "1.0.0",
  provider: "duffel",
  status: "committed",
  currency: "USD",
  authorized_amount_cents: 50000,
  captured_amount_cents: 50000,
  refunded_amount_cents: 0,
  payment_method_label: "Visa •• 4242",
  line_items: [{ description: "AS 312 SFO→LAS", amount_cents: 50000 }],
  receipt_url: null,
  refund_of_transaction_id: null,
  created_at: "2026-04-30T12:00:00Z",
  updated_at: "2026-04-30T12:00:00Z",
};

t("authenticated render — committed Stripe transaction", () => {
  assert.equal(formatTransactionStatus(baseTx), "Paid");
  assert.equal(formatCents(50000, "USD"), "$500.00");
  assert.equal(totalDisplayCents(baseTx), 50000);
  assert.match(statusPillClass("Paid"), /lumo-ok/);
  assert.equal(providerLabel("duffel"), "Duffel · flights");
});

t("empty state — no captured amount falls back to authorized", () => {
  const tx = { ...baseTx, captured_amount_cents: 0, authorized_amount_cents: 12000, status: "authorized" };
  assert.equal(totalDisplayCents(tx), 12000);
  assert.equal(formatTransactionStatus(tx), "Authorized");
});

t("error state — unknown provider returns the raw string", () => {
  assert.equal(providerLabel("brand_new_provider"), "brand_new_provider");
});

t("refundable only when committed with captured > refunded", () => {
  assert.equal(isRefundable(baseTx), true);
  assert.equal(isRefundable({ ...baseTx, status: "rolled_back" }), false);
  assert.equal(
    isRefundable({ ...baseTx, refunded_amount_cents: 50000 }),
    false,
  );
});

t("refund label flips to 'Partially refunded' / 'Refunded'", () => {
  const partial = { ...baseTx, refunded_amount_cents: 10000 };
  assert.equal(formatTransactionStatus(partial), "Partially refunded");
  const full = { ...baseTx, refunded_amount_cents: 50000 };
  assert.equal(formatTransactionStatus(full), "Refunded");
});

t("refund stub: happy-path records request, scoped by user", () => {
  __resetForTesting();
  const id1 = recordRefundRequest({
    user_id: "u_a",
    transaction_id: "txn_1",
    reason: null,
    requested_at: "2026-04-30T12:00:00Z",
  });
  recordRefundRequest({
    user_id: "u_b",
    transaction_id: "txn_2",
    reason: "duplicate",
    requested_at: "2026-04-30T12:00:00Z",
  });
  const aRequests = listRefundRequestsForUser("u_a");
  assert.equal(aRequests.length, 1);
  assert.equal(aRequests[0].request_id, id1);
  assert.equal(listRefundRequestsForUser("u_b").length, 1);
  assert.equal(listRefundRequestsForUser("u_unknown").length, 0);
});

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
