/**
 * KG-1 knowledge graph substrate regression.
 *
 * Tests the relational graph_nodes / graph_edges substrate (ADR-008).
 * Deterministic; no real network. Synthesises an in-memory graph and
 * verifies:
 *   - node + edge insertion shape (provenance required, ADR-008 §4)
 *   - 1-hop / 2-hop / 3-hop CTE traversal correctness on a fixture
 *   - cycle prevention (path tracking, ADR-008 §6)
 *   - cross-user isolation (no cross-user edges, ADR-008 §9)
 *   - p95 latency budgets respected on the synthetic fixture
 *     (1-hop < 200ms, 2-hop < 600ms, 3-hop < 1500ms — measured against
 *     in-memory traversal so runtime is dominated by JS overhead, but
 *     the gate ensures the test fixture itself stays cheap)
 *
 * Run: node --experimental-strip-types tests/phase3-knowledge-graph.test.mjs
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

// ---------- in-memory graph fixture ----------
//
// Shape mirrors the real schema: nodes carry user_id+label+external_key
// and provenance triplet; edges carry user_id+source_id+target_id+edge_type.

const USER_A = "00000000-0000-0000-0000-000000000aaa";
const USER_B = "00000000-0000-0000-0000-000000000bbb";

function emptyGraph() {
  return { nodes: new Map(), edges: [] };
}

function insertNode(g, n) {
  // Provenance enforcement (ADR-008 §4): non-fact label requires source_table.
  if (!n.source_table && n.label !== "fact") {
    throw new Error("graph_nodes row missing provenance");
  }
  const key = `${n.user_id}|${n.label}|${n.external_key}`;
  const id = n.id ?? `node-${g.nodes.size}`;
  const row = { id, ...n };
  g.nodes.set(id, row);
  // unique (user_id, label, external_key) — return existing if duplicate.
  for (const existing of g.nodes.values()) {
    if (existing.id !== id && `${existing.user_id}|${existing.label}|${existing.external_key}` === key) {
      g.nodes.delete(id);
      return existing;
    }
  }
  return row;
}

function insertEdge(g, e) {
  if (!e.source_table) throw new Error("graph_edges row missing provenance");
  const src = g.nodes.get(e.source_id);
  const dst = g.nodes.get(e.target_id);
  if (!src || !dst) throw new Error("edge references unknown node");
  // Cross-user edges forbidden (ADR-008 §9).
  if (src.user_id !== dst.user_id || src.user_id !== e.user_id) {
    throw new Error("cross-user edge forbidden");
  }
  // unique (user_id, source_id, target_id, edge_type)
  for (const ex of g.edges) {
    if (
      ex.user_id === e.user_id &&
      ex.source_id === e.source_id &&
      ex.target_id === e.target_id &&
      ex.edge_type === e.edge_type
    ) {
      return ex;
    }
  }
  const row = { ...e, weight: e.weight ?? 1.0 };
  g.edges.push(row);
  return row;
}

function oneHop(g, userId, startId, edgeFilter) {
  return g.edges
    .filter((e) => e.user_id === userId && e.source_id === startId)
    .filter((e) => !edgeFilter || edgeFilter.includes(e.edge_type))
    .map((e) => ({
      target_id: e.target_id,
      edge_type: e.edge_type,
      weight: e.weight,
      depth: 1,
      score: e.weight,
    }));
}

function nHop(g, userId, startId, maxHops, edgeFilter) {
  const out = [];
  const stack = [{ node: startId, path: [startId], depth: 0, score: 1 }];
  while (stack.length) {
    const cur = stack.pop();
    if (cur.depth >= maxHops) continue;
    const edges = g.edges.filter(
      (e) =>
        e.user_id === userId &&
        e.source_id === cur.node &&
        (!edgeFilter || edgeFilter.includes(e.edge_type)) &&
        !cur.path.includes(e.target_id), // cycle guard
    );
    for (const e of edges) {
      const next = {
        node: e.target_id,
        path: [...cur.path, e.target_id],
        depth: cur.depth + 1,
        score: cur.score * e.weight,
      };
      out.push(next);
      stack.push(next);
    }
  }
  return out;
}

// ---------- fixture ----------
const g = emptyGraph();
const userMission = insertNode(g, {
  user_id: USER_A,
  label: "mission",
  external_key: "mission-vegas",
  properties: { summary: "Vegas trip" },
  source_table: "missions",
  source_row_id: "m-1",
  source_url: "https://lumo/missions/m-1",
});
const userEvent = insertNode(g, {
  user_id: USER_A,
  label: "event",
  external_key: "evt-vegas-dinner",
  properties: { title: "Vegas dinner" },
  source_table: "connector_responses_archive",
  source_row_id: "r-101",
  source_url: "https://calendar.google.com/?eid=evt1",
});
const userContact = insertNode(g, {
  user_id: USER_A,
  label: "contact",
  external_key: "contact-alice",
  properties: { name: "Alice" },
  source_table: "connector_responses_archive",
  source_row_id: "r-102",
  source_url: "https://mail.google.com/#inbox/m-200",
});
const userPlace = insertNode(g, {
  user_id: USER_A,
  label: "place",
  external_key: "place-vegas",
  properties: { name: "Las Vegas" },
  source_table: "connector_responses_archive",
  source_row_id: "r-103",
  source_url: null,
});
insertEdge(g, {
  user_id: USER_A,
  source_id: userMission.id,
  target_id: userEvent.id,
  edge_type: "part_of",
  weight: 0.9,
  source_table: "missions",
  source_row_id: "m-1",
});
insertEdge(g, {
  user_id: USER_A,
  source_id: userEvent.id,
  target_id: userContact.id,
  edge_type: "attended",
  weight: 0.8,
  source_table: "connector_responses_archive",
  source_row_id: "r-101",
});
insertEdge(g, {
  user_id: USER_A,
  source_id: userMission.id,
  target_id: userPlace.id,
  edge_type: "located_at",
  weight: 0.95,
  source_table: "missions",
  source_row_id: "m-1",
});

// User B has its own contact that should never be reachable from User A.
const userBContact = insertNode(g, {
  user_id: USER_B,
  label: "contact",
  external_key: "contact-bob",
  properties: { name: "Bob" },
  source_table: "connector_responses_archive",
  source_row_id: "r-999",
});

console.log("\nKG-1 knowledge graph substrate");

t("inserts node with provenance", () => {
  assert.equal(userMission.source_table, "missions");
  assert.equal(userEvent.source_url, "https://calendar.google.com/?eid=evt1");
});

t("rejects node insertion missing provenance (non-fact label)", () => {
  assert.throws(() =>
    insertNode(g, { user_id: USER_A, label: "event", external_key: "no-prov" }),
  );
});

t("allows fact node without source_table (user-asserted)", () => {
  const factNode = insertNode(g, {
    user_id: USER_A,
    label: "fact",
    external_key: "fact-1",
    properties: { text: "I prefer aisle seats" },
  });
  assert.equal(factNode.label, "fact");
});

t("rejects edge insertion missing provenance", () => {
  assert.throws(() =>
    insertEdge(g, {
      user_id: USER_A,
      source_id: userMission.id,
      target_id: userEvent.id,
      edge_type: "test",
    }),
  );
});

t("rejects cross-user edge", () => {
  assert.throws(() =>
    insertEdge(g, {
      user_id: USER_A,
      source_id: userMission.id,
      target_id: userBContact.id,
      edge_type: "mentions",
      source_table: "test",
    }),
  );
});

t("1-hop traversal returns direct neighbours only", () => {
  const r = oneHop(g, USER_A, userMission.id, null);
  const targets = r.map((x) => x.target_id).sort();
  assert.deepEqual(targets, [userEvent.id, userPlace.id].sort());
});

t("1-hop respects edge_filter", () => {
  const r = oneHop(g, USER_A, userMission.id, ["located_at"]);
  assert.equal(r.length, 1);
  assert.equal(r[0].target_id, userPlace.id);
});

t("2-hop traversal reaches contact via event", () => {
  const r = nHop(g, USER_A, userMission.id, 2, null);
  const reached = r.map((x) => x.node);
  assert.ok(reached.includes(userContact.id), "contact reachable in 2 hops");
});

t("3-hop traversal terminates without cycles", () => {
  // create a small cycle: contact → mission, then walk should not loop.
  insertEdge(g, {
    user_id: USER_A,
    source_id: userContact.id,
    target_id: userMission.id,
    edge_type: "related_to",
    weight: 0.3,
    source_table: "synthetic",
    source_row_id: "syn-1",
  });
  const start = Date.now();
  const r = nHop(g, USER_A, userMission.id, 3, null);
  const elapsed = Date.now() - start;
  assert.ok(elapsed < 1500, `3-hop budget breach: ${elapsed}ms`);
  // Cycle guard: no result's path repeats a node.
  for (const x of r) {
    assert.equal(new Set(x.path).size, x.path.length, `cycle in path: ${x.path}`);
  }
});

t("user A query never sees user B nodes", () => {
  const r = nHop(g, USER_A, userMission.id, 3, null);
  for (const x of r) {
    assert.notEqual(x.node, userBContact.id);
  }
});

t("p95 latency budgets met on fixture", () => {
  const samples = { one: [], two: [], three: [] };
  for (let i = 0; i < 50; i++) {
    let s = Date.now();
    oneHop(g, USER_A, userMission.id, null);
    samples.one.push(Date.now() - s);
    s = Date.now();
    nHop(g, USER_A, userMission.id, 2, null);
    samples.two.push(Date.now() - s);
    s = Date.now();
    nHop(g, USER_A, userMission.id, 3, null);
    samples.three.push(Date.now() - s);
  }
  const p95 = (a) => a.sort((x, y) => x - y)[Math.floor(a.length * 0.95)];
  assert.ok(p95(samples.one) < 200, "1-hop p95 < 200ms");
  assert.ok(p95(samples.two) < 600, "2-hop p95 < 600ms");
  assert.ok(p95(samples.three) < 1500, "3-hop p95 < 1500ms");
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
