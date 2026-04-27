/**
 * KG-1 GraphRAG recall test.
 *
 * Run: node --experimental-strip-types tests/phase3-graph-rag-recall.test.mjs
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import {
  assertGraphCitedHasProvenance,
  recallGraphFromFixture,
} from "../lib/knowledge-graph-core.ts";

let pass = 0;
let fail = 0;
const t = async (name, fn) => {
  try {
    await fn();
    pass++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    fail++;
    console.log(`  ✗ ${name}\n    ${e.message}`);
  }
};

const synthetic = JSON.parse(fs.readFileSync("tests/fixtures/vegas-kg-synthetic.json", "utf8"));

console.log("\nKG-1 GraphRAG recall");

await t("answers the Synthetic Sam Vegas-over-Tahoe query with graph citations", async () => {
  const result = recallGraphFromFixture(
    "why did Sam pick Vegas over Tahoe last December?",
    synthetic,
    { user_id: synthetic.user.id, max_hops: 3 },
  );
  assert.equal(result.evidence_mode, "graph_cited");
  assert.match(result.answer, /board meeting/i);
  assert.match(result.answer, /storm/i);
  assert.ok(result.citations.length >= 2);
  assertGraphCitedHasProvenance(result);
});

await t("returns the Tahoe mission plus both BLOCKED_BY targets", async () => {
  const result = recallGraphFromFixture(
    "what made me pick Vegas over Tahoe?",
    synthetic,
    { user_id: synthetic.user.id, max_hops: 3 },
  );
  const citedText = result.citations.map((citation) => citation.text).join(" | ");
  assert.match(citedText, /Plan Tahoe ski trip/);
  assert.match(citedText, /Q4 board meeting/);
  assert.match(citedText, /Severe winter storm/);
  assert.equal(result.traversal_path.length >= 2, true);
});

await t("each evidence row carries provenance triplet", async () => {
  const result = recallGraphFromFixture("why did Sam pick Vegas over Tahoe?", synthetic, {
    user_id: synthetic.user.id,
  });
  for (const ev of result.evidence) {
    assert.ok(ev.source_table, "source_table missing");
    assert.ok(ev.source_row_id, "source_row_id missing");
    assert.ok("source_url" in ev, "source_url field missing");
  }
});

await t("confidence is the product of the blocker edge weights", async () => {
  const result = recallGraphFromFixture("why did Sam pick Vegas over Tahoe?", synthetic, {
    user_id: synthetic.user.id,
  });
  assert.ok(Math.abs(result.confidence - 0.96 * 0.94) < 1e-6);
});

await t("falls back to vector_only on no graph evidence", async () => {
  const result = recallGraphFromFixture("tasmania devil migration patterns", synthetic, {
    user_id: synthetic.user.id,
  });
  assert.equal(result.evidence_mode, "vector_only");
  assert.equal(result.evidence.length, 0);
  assert.deepEqual(result.path, []);
});

await t("client renderer contract refuses graph response without evidence", async () => {
  const bad = {
    answer: "bad",
    citations: [],
    traversal_path: [["m-1"]],
    candidates: [],
    evidence: [],
    path: ["m-1"],
    confidence: 0.5,
    evidence_mode: "graph_cited",
    source: "fixture",
    latency_ms: 0,
  };
  assert.throws(() => assertGraphCitedHasProvenance(bad), /missing evidence/);
});

await t("citation count >= 2 for the master spec demo query", async () => {
  const result = recallGraphFromFixture(
    "why did Sam pick Vegas over Tahoe last December?",
    synthetic,
    { user_id: synthetic.user.id, max_hops: 3 },
  );
  assert.ok(result.citations.length >= 2);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
