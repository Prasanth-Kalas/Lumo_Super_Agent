/**
 * Workspace lead classifier scoring helpers.
 *
 * Run: node --experimental-strip-types tests/workspace-lead-classifier.test.mjs
 */

import assert from "node:assert/strict";
import { LEAD_SCORE_THRESHOLD, mergeMlLeadScore, scoreLeadHeuristic } from "../lib/lead-scoring.ts";
import { classifyLeadItemsCore } from "../lib/workspace-lead-classifier-core.ts";

let pass = 0;
let fail = 0;
const t = async (name, fn) => {
  try {
    await fn();
    pass++;
    console.log(`  \u2713 ${name}`);
  } catch (e) {
    fail++;
    console.log(`  \u2717 ${name}\n    ${e.message}`);
  }
};

console.log("\nworkspace lead classifier scoring");

await t("heuristic fallback scores obvious business leads", () => {
  const lead = scoreLeadHeuristic("We want to sponsor your next video. Email partnerships@example.com.");
  assert.equal(lead.source, "heuristic");
  assert.ok(lead.score >= LEAD_SCORE_THRESHOLD);
  assert.ok(lead.reasons.includes("sponsorship"));
});

await t("ML response overrides fallback scores without losing shape", () => {
  const fallback = scoreLeadHeuristic("Nice video!");
  const merged = mergeMlLeadScore(fallback, {
    label: "business_lead",
    score: 0.88,
    reasons: ["speaker-invite"],
    above_threshold: true,
  });
  assert.deepEqual(merged, {
    score: 0.88,
    reasons: ["speaker-invite"],
    source: "ml",
  });
});

await t("malformed ML response keeps heuristic fallback", () => {
  const fallback = scoreLeadHeuristic(
    "We want to sponsor your next video and partner on launch. Email partnerships@example.com.",
  );
  const merged = mergeMlLeadScore(fallback, { label: "business_lead", reasons: ["bad-shape"] });
  assert.equal(merged.source, "heuristic");
  assert.ok(merged.score >= LEAD_SCORE_THRESHOLD);
});

await t("core timeout degrades to heuristic fallback", async () => {
  const text = "We want to sponsor your next video and partner on launch. Email partnerships@example.com.";
  const result = await classifyLeadItemsCore({
    user_id: "user_123",
    redactedTexts: [text],
    fallbackScores: [scoreLeadHeuristic(text)],
    baseUrl: "http://lumo-ml.test",
    authorizationHeader: "Bearer test",
    fetchImpl: async (_url, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(new DOMException("aborted", "AbortError"));
        });
      }),
    timeoutMs: 10,
    threshold: LEAD_SCORE_THRESHOLD,
    itemCap: 100,
    recordUsage: async () => {},
  });
  assert.equal(result.source, "heuristic");
  assert.equal(result.error, "timeout");
  assert.ok(result.scores[0]?.score >= LEAD_SCORE_THRESHOLD);
});

await t("core HTTP error degrades to heuristic fallback", async () => {
  const result = await classifyLeadItemsCore({
    user_id: "user_123",
    redactedTexts: ["We want to sponsor your next video."],
    fallbackScores: [scoreLeadHeuristic("We want to sponsor your next video.")],
    baseUrl: "http://lumo-ml.test",
    authorizationHeader: "Bearer test",
    fetchImpl: async () => new Response("nope", { status: 500 }),
    timeoutMs: 100,
    threshold: LEAD_SCORE_THRESHOLD,
    itemCap: 100,
    recordUsage: async () => {},
  });
  assert.equal(result.source, "heuristic");
  assert.equal(result.error, "http_500");
});

await t("core missing config degrades without calling fetch", async () => {
  let called = false;
  const result = await classifyLeadItemsCore({
    user_id: "user_123",
    redactedTexts: ["We want to sponsor your next video."],
    fallbackScores: [scoreLeadHeuristic("We want to sponsor your next video.")],
    baseUrl: "",
    authorizationHeader: null,
    fetchImpl: async () => {
      called = true;
      return Response.json({});
    },
    timeoutMs: 100,
    threshold: LEAD_SCORE_THRESHOLD,
    itemCap: 100,
    recordUsage: async () => {},
  });
  assert.equal(called, false);
  assert.equal(result.source, "heuristic");
  assert.equal(result.error, "ml_classifier_not_configured");
});

await t("core caps ML batch and leaves tail heuristic", async () => {
  const result = await classifyLeadItemsCore({
    user_id: "user_123",
    redactedTexts: ["redacted one", "redacted two"],
    fallbackScores: [
      scoreLeadHeuristic("Nice video."),
      scoreLeadHeuristic("We want to sponsor your next video."),
    ],
    baseUrl: "http://lumo-ml.test",
    authorizationHeader: "Bearer test",
    fetchImpl: async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      assert.deepEqual(body.items, ["redacted one"]);
      return Response.json({
        classifier: "lead",
        items: [{ label: "business_lead", score: 0.92, reasons: ["ml"], above_threshold: true }],
      });
    },
    timeoutMs: 100,
    threshold: LEAD_SCORE_THRESHOLD,
    itemCap: 1,
    recordUsage: async () => {},
  });
  assert.equal(result.source, "ml");
  assert.equal(result.scores[0]?.source, "ml");
  assert.equal(result.scores[1]?.source, "heuristic");
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
