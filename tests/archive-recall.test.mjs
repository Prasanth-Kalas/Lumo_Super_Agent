/**
 * Archive recall pure-core tests.
 *
 * Run: node --experimental-strip-types tests/archive-recall.test.mjs
 */

import assert from "node:assert/strict";
import {
  formatArchiveRecallAnswer,
  recallArchiveCore,
  recallArchiveFallback,
  shouldRunArchiveRecall,
} from "../lib/archive-recall-core.ts";

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

const docs = [
  doc(
    "a",
    "Alex mentioned the Vegas partnership idea in the creator inbox and asked for a follow-up deck.",
    "meta",
    "comments.sync",
  ),
  doc(
    "b",
    "The hotel itinerary note says check in Saturday and compare resort fees before booking.",
    "hotel",
    "hotel.notes",
  ),
  doc("c", "A generic weekly sync about engineering chores.", "github", "issues"),
];

console.log("\narchive recall");

await t("recall gate recognizes explicit archive questions", () => {
  assert.equal(shouldRunArchiveRecall("Where did Alex mention the Vegas partnership?"), true);
  assert.equal(shouldRunArchiveRecall("Search my comments for the hotel note."), true);
  assert.equal(shouldRunArchiveRecall("Thanks, that helps."), false);
});

await t("fallback scores local documents and formats cited answer", () => {
  const result = {
    ...recallArchiveFallback("Where did Alex mention Vegas partnership?", docs, 2),
    source: "fallback",
    latency_ms: 0,
  };
  assert.equal(result.hits[0]?.id, "a");
  assert.match(result.hits[0]?.snippet ?? "", /Vegas partnership/);
  const answer = formatArchiveRecallAnswer("Where did Alex mention Vegas partnership?", result);
  assert.match(answer, /meta · comments\.sync/);
});

await t("ML recall timeout falls back without losing candidates", async () => {
  const result = await recallArchiveCore({
    query: "Where did Alex mention Vegas partnership?",
    documents: docs,
    baseUrl: "http://lumo-ml.test",
    authorizationHeader: "Bearer test",
    fetchImpl: async (_url, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(new DOMException("aborted", "AbortError"));
        });
      }),
    timeoutMs: 10,
    topK: 2,
    recordUsage: async () => {},
  });
  assert.equal(result.source, "fallback");
  assert.equal(result.error, "timeout");
  assert.equal(result.hits[0]?.id, "a");
});

await t("ML recall response is normalized against candidate ids", async () => {
  const result = await recallArchiveCore({
    query: "hotel itinerary",
    documents: docs,
    baseUrl: "http://lumo-ml.test",
    authorizationHeader: "Bearer test",
    fetchImpl: async () =>
      Response.json({
        status: "ok",
        hits: [
          { id: "missing", score: 1, snippet: "ignore" },
          { id: "b", score: 0.9, snippet: "check in Saturday" },
        ],
        _lumo_summary: "Found one.",
      }),
    timeoutMs: 100,
    topK: 2,
    recordUsage: async () => {},
  });
  assert.equal(result.source, "ml");
  assert.deepEqual(result.hits.map((hit) => hit.id), ["b"]);
  assert.equal(result.summary, "Found one.");
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);

function doc(id, text, source, endpoint) {
  return {
    id,
    text,
    source,
    metadata: { endpoint },
  };
}
