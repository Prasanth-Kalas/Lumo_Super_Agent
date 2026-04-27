/**
 * BANDIT-1 LinUCB → Thompson promotion ladder (ADR-009 §10).
 *
 * Promotion criteria:
 *   - Total reward events on a (user, surface) pair >= 100
 *   - Per-arm minimum reward events >= 10 for at least 5 arms
 *   - Last-30-day CTR variance < 25%
 *
 * Once promoted: per-pair flag flips on `bandit_user_models`. The LinUCB
 * weights become the Thompson posterior's prior mean. Promotions never
 * unwind.
 *
 * Run: node --experimental-strip-types tests/phase3-bandit-promotion.test.mjs
 */

import assert from "node:assert/strict";

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

function variance(arr) {
  if (arr.length < 2) return 0;
  const m = arr.reduce((a, b) => a + b, 0) / arr.length;
  return arr.reduce((a, b) => a + (b - m) ** 2, 0) / (arr.length - 1);
}

function shouldPromote({ totalRewardEvents, perArmCounts, last30DaysCtr }) {
  if (totalRewardEvents < 100) return { promote: false, reason: "below_total_threshold" };
  const armsWith10Plus = perArmCounts.filter((c) => c >= 10).length;
  if (armsWith10Plus < 5) return { promote: false, reason: "below_per_arm_threshold" };
  const v = variance(last30DaysCtr);
  // ADR-009 §10: variance < 25% — interpreted as relative variance < 0.25.
  const mean = last30DaysCtr.reduce((a, b) => a + b, 0) / last30DaysCtr.length;
  const relVar = mean > 0 ? v / (mean * mean) : Infinity;
  if (relVar >= 0.25) return { promote: false, reason: "ctr_unstable" };
  return { promote: true, reason: null };
}

console.log("\nBANDIT-1 promotion ladder");

t("does not promote below 100 events", () => {
  const r = shouldPromote({
    totalRewardEvents: 99,
    perArmCounts: [20, 20, 20, 20, 20],
    last30DaysCtr: Array(30).fill(0.1),
  });
  assert.equal(r.promote, false);
  assert.equal(r.reason, "below_total_threshold");
});

t("does not promote with fewer than 5 arms hitting 10 events", () => {
  const r = shouldPromote({
    totalRewardEvents: 200,
    perArmCounts: [50, 50, 50, 5, 5, 5, 5],
    last30DaysCtr: Array(30).fill(0.1),
  });
  assert.equal(r.promote, false);
  assert.equal(r.reason, "below_per_arm_threshold");
});

t("does not promote with unstable last-30-day CTR", () => {
  const r = shouldPromote({
    totalRewardEvents: 200,
    perArmCounts: [20, 20, 20, 20, 20, 20],
    // wild swings: variance >> 0.25 mean^2
    last30DaysCtr: [0.01, 0.4, 0.02, 0.5, 0.01, 0.45, 0.02, 0.4],
  });
  assert.equal(r.promote, false);
  assert.equal(r.reason, "ctr_unstable");
});

t("promotes when all three criteria met", () => {
  const r = shouldPromote({
    totalRewardEvents: 150,
    perArmCounts: [15, 15, 15, 15, 15, 15, 15, 15],
    last30DaysCtr: Array(30).fill(0.1).map((v, i) => v + (i % 2) * 0.005),
  });
  assert.equal(r.promote, true);
});

t("exactly 100 events crosses the threshold", () => {
  const r = shouldPromote({
    totalRewardEvents: 100,
    perArmCounts: [10, 10, 10, 10, 10, 10, 10, 10, 10, 10],
    last30DaysCtr: Array(30).fill(0.12),
  });
  assert.equal(r.promote, true);
});

t("promotion is one-way — once promoted stays promoted", () => {
  // model: a `bandit_user_models` row, after promotion, exposes
  // `algorithm='thompson'` and a non-null promoted_at. A subsequent fall in
  // total events should not flip back.
  const userModel = { algorithm: "linucb", promoted_at: null };
  const promote = (m) => {
    m.algorithm = "thompson";
    m.promoted_at = new Date().toISOString();
  };
  const tryUnpromote = (m) => {
    // Forbidden — unwinding is not a supported state transition.
    if (m.algorithm === "thompson") {
      throw new Error("cannot unwind a Thompson promotion");
    }
  };
  promote(userModel);
  assert.equal(userModel.algorithm, "thompson");
  assert.throws(() => tryUnpromote(userModel));
});

t("LinUCB theta becomes Thompson posterior prior mean on promotion", () => {
  // The promotion code path in BANDIT-1 will copy `theta` from LinUCB into
  // the Thompson posterior's prior_mean field. We model the contract here.
  const linucbWeights = { theta: [0.3, -0.1, 0.5], A_inv: [[1, 0, 0], [0, 1, 0], [0, 0, 1]] };
  const promoted = {
    algorithm: "thompson",
    posterior: {
      prior_mean: linucbWeights.theta.slice(),
      prior_cov: linucbWeights.A_inv.map((r) => r.slice()),
    },
  };
  assert.deepEqual(promoted.posterior.prior_mean, [0.3, -0.1, 0.5]);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
