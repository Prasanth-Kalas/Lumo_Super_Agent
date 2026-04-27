/**
 * KG-1 knowledge graph substrate regression.
 *
 * Run: node --experimental-strip-types tests/phase3-knowledge-graph.test.mjs
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import {
  traverseGraphInMemory,
  validateKnowledgeGraphFixture,
} from "../lib/knowledge-graph-core.ts";
import {
  buildGraphSeedNodeIdMap,
  prepareGraphEdgeSeedRows,
  prepareGraphNodeSeedRows,
} from "../lib/knowledge-graph.ts";

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

const USER_A = "00000000-0000-0000-0000-000000000aaa";
const USER_B = "00000000-0000-0000-0000-000000000bbb";
const synthetic = JSON.parse(fs.readFileSync("tests/fixtures/vegas-kg-synthetic.json", "utf8"));
const knowledgeGraphSource = fs.readFileSync("lib/knowledge-graph.ts", "utf8");
const migration035 = fs.readFileSync("db/migrations/035_kg_embedding_seed_rpc.sql", "utf8");

function node(id, user_id = USER_A, extra = {}) {
  return {
    id,
    user_id,
    label: "mission",
    external_key: id,
    properties: { summary: id },
    source_table: "missions",
    source_row_id: id,
    source_url: `https://lumo.test/${id}`,
    ...extra,
  };
}

function edge(id, source_id, target_id, user_id = USER_A, extra = {}) {
  return {
    id,
    user_id,
    source_id,
    target_id,
    edge_type: "RELATED_TO",
    weight: 0.9,
    source_table: "mission_execution_events",
    source_row_id: id,
    source_url: `https://lumo.test/edges/${id}`,
    ...extra,
  };
}

const fixture = {
  user: { id: USER_A },
  nodes: [
    node("a"),
    node("b", USER_A, { label: "event", properties: { title: "Vegas dinner" } }),
    node("c", USER_A, { label: "person", properties: { name: "Alice" } }),
    node("d", USER_A, { label: "place", properties: { name: "Las Vegas" } }),
    node("other", USER_B, { label: "person", properties: { name: "Other user" } }),
  ],
  edges: [
    edge("ab", "a", "b", USER_A, { edge_type: "PART_OF", weight: 0.9 }),
    edge("bc", "b", "c", USER_A, { edge_type: "ATTENDED", weight: 0.8 }),
    edge("cd", "c", "d", USER_A, { edge_type: "LOCATED_AT", weight: 0.7 }),
    edge("da", "d", "a", USER_A, { edge_type: "RELATED_TO", weight: 0.6 }),
  ],
};

console.log("\nKG-1 knowledge graph substrate");

t("validates Synthetic Sam fixture with provenance", () => {
  const result = validateKnowledgeGraphFixture(synthetic);
  assert.equal(result.ok, true, result.errors.join("\n"));
  assert.equal(result.node_count, 147);
  assert.equal(result.edge_count, 313);
});

t("Synthetic Sam contains explicit Tahoe BLOCKED_BY evidence", () => {
  const tahoe = synthetic.nodes.find((n) => n.external_key === "mission-tahoe-trip");
  assert.ok(tahoe);
  const blockers = synthetic.edges.filter((e) => e.source_id === tahoe.id && e.edge_type === "BLOCKED_BY");
  assert.equal(blockers.length, 2);
  const targets = blockers.map((e) => synthetic.nodes.find((n) => n.id === e.target_id)?.external_key).sort();
  assert.deepEqual(targets, ["evt-q4-board-meeting", "evt-tahoe-storm-forecast"]);
});

t("rejects node missing provenance", () => {
  const bad = {
    user: { id: USER_A },
    nodes: [{ ...node("bad"), source_table: null }],
    edges: [],
  };
  const result = validateKnowledgeGraphFixture(bad);
  assert.equal(result.ok, false);
  assert.match(result.errors.join("\n"), /node missing source_table/);
});

t("rejects edge missing provenance", () => {
  const bad = {
    ...fixture,
    edges: [{ ...fixture.edges[0], source_table: null }],
  };
  const result = validateKnowledgeGraphFixture(bad);
  assert.equal(result.ok, false);
  assert.match(result.errors.join("\n"), /edge missing source_table/);
});

t("rejects cross-user edge", () => {
  const bad = {
    ...fixture,
    edges: [...fixture.edges, edge("cross", "a", "other", USER_A)],
  };
  const result = validateKnowledgeGraphFixture(bad);
  assert.equal(result.ok, false);
  assert.match(result.errors.join("\n"), /cross-user edge forbidden/);
});

t("traverses one hop with edge filter", () => {
  const rows = traverseGraphInMemory({
    fixture,
    user_id: USER_A,
    start_node_id: "a",
    max_hops: 1,
    edge_filter: ["part_of"],
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].node_id, "b");
  assert.equal(rows[0].depth, 1);
});

t("traverses two and three hops with cycle prevention", () => {
  const rows = traverseGraphInMemory({
    fixture,
    user_id: USER_A,
    start_node_id: "a",
    max_hops: 3,
  });
  assert.ok(rows.some((row) => row.path.join(">") === "a>b>c"));
  assert.ok(rows.some((row) => row.path.join(">") === "a>b>c>d"));
  assert.equal(rows.some((row) => row.path.join(">") === "a>b>c>d>a"), false);
});

t("keeps traversal under the p95 budget on Synthetic Sam", () => {
  const starts = synthetic.nodes.slice(0, 40).map((n) => n.id);
  const samples = [];
  for (const start of starts) {
    const t0 = performance.now();
    traverseGraphInMemory({
      fixture: synthetic,
      user_id: synthetic.user.id,
      start_node_id: start,
      max_hops: 3,
      max_results: 50,
    });
    samples.push(performance.now() - t0);
  }
  samples.sort((a, b) => a - b);
  const p95 = samples[Math.floor(samples.length * 0.95)] ?? 0;
  assert.ok(p95 < 1500, `p95 ${p95}ms exceeded 1500ms`);
});

t("scopes synthetic DB seed rows per tenant without fixture id collisions", () => {
  const tenantA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const tenantB = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const nodesA = prepareGraphNodeSeedRows(tenantA, synthetic);
  const nodesB = prepareGraphNodeSeedRows(tenantB, synthetic);

  assert.equal(nodesA.length, 147);
  assert.equal(nodesB.length, 147);
  assert.equal(nodesA.some((row) => "id" in row), false);
  assert.equal(nodesB.some((row) => "id" in row), false);

  const dbNodesA = nodesA.map((row, index) => ({
    id: `a-node-${index}`,
    user_id: row.user_id,
    label: row.label,
    external_key: row.external_key,
  }));
  const dbNodesB = nodesB.map((row, index) => ({
    id: `b-node-${index}`,
    user_id: row.user_id,
    label: row.label,
    external_key: row.external_key,
  }));
  const mapA = buildGraphSeedNodeIdMap(tenantA, synthetic, dbNodesA);
  const mapB = buildGraphSeedNodeIdMap(tenantB, synthetic, dbNodesB);
  const edgesA = prepareGraphEdgeSeedRows(tenantA, synthetic, mapA);
  const edgesB = prepareGraphEdgeSeedRows(tenantB, synthetic, mapB);
  const edgeKeysA = new Set(edgesA.map((row) => `${row.user_id}:${row.source_id}:${row.target_id}:${row.edge_type}`));
  const edgeKeysB = new Set(edgesB.map((row) => `${row.user_id}:${row.source_id}:${row.target_id}:${row.edge_type}`));

  assert.equal(edgesA.length, edgeKeysA.size);
  assert.equal(edgesB.length, edgeKeysB.size);
  assert.equal(edgesA.some((row) => "id" in row), false);
  assert.equal(edgesB.some((row) => "id" in row), false);

  const idsA = new Set(dbNodesA.map((row) => row.id));
  const idsB = new Set(dbNodesB.map((row) => row.id));
  assert.equal([...idsA].some((id) => idsB.has(id)), false);
  assert.equal(edgesA.every((row) => idsA.has(row.source_id) && idsA.has(row.target_id)), true);
  assert.equal(edgesB.every((row) => idsB.has(row.source_id) && idsB.has(row.target_id)), true);
});

t("node seed rows can carry optional 384-dim embeddings without fixture ids", () => {
  const embeddingsByFixtureId = new Map([[synthetic.nodes[0].id, Array.from({ length: 384 }, () => 0.01)]]);
  const rows = prepareGraphNodeSeedRows(USER_A, synthetic, embeddingsByFixtureId);
  assert.equal(rows[0].embedding.length, 384);
  assert.equal(rows[1].embedding, null);
  assert.equal("id" in rows[0], false);
});

t("KG embedding RPCs rely on GRANT boundary, not auth.role predicates", () => {
  const executableSql = migration035
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("--"))
    .join("\n");
  assert.match(migration035, /Authorization is enforced exclusively by the GRANT EXECUTE boundary/);
  assert.equal(/auth\.role\(\)/i.test(executableSql), false);
  assert.match(migration035, /grant execute on function public\.lumo_kg_upsert_node/);
  assert.match(migration035, /grant execute on function public\.lumo_kg_seed_by_embedding/);
  assert.match(migration035, /revoke all on function public\.lumo_kg_seed_by_embedding/);
});

t("fixture reembed uses bounded batches without retry amplification", () => {
  assert.match(knowledgeGraphSource, /const KG_FIXTURE_EMBED_BATCH_SIZE = 16;/);
  assert.match(knowledgeGraphSource, /const KG_FIXTURE_EMBED_MAX_PASSES = 2;/);
  assert.match(knowledgeGraphSource, /const KG_FIXTURE_EMBED_MAX_ATTEMPTS = 1;/);
  assert.match(knowledgeGraphSource, /const KG_FIXTURE_EMBED_TIMEOUT_MS = 30_000;/);
  assert.match(knowledgeGraphSource, /const KG_FIXTURE_EMBED_FAILURE_THRESHOLD = 100;/);
  assert.match(knowledgeGraphSource, /pendingBatches\.map\(\(\{ index \}\) => `embedding_batch_failed:\$\{index\}`\)/);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
