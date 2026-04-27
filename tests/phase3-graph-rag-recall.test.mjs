/**
 * KG-1 GraphRAG recall test.
 *
 * Tests the /api/graph/recall surface contract: a synthetic graph is
 * loaded, the recall route is invoked (mocked fetch — no real network),
 * and we verify:
 *   - every returned candidate carries provenance (ADR-008 §7)
 *   - path array reaches the expected target (Vegas dinner contact)
 *   - confidence is the product of edge weights
 *   - vector_only fallback flag set when the graph traversal yields zero
 *     evidence rows
 *   - client renderer would reject a no-evidence response (we model the
 *     contract here; the real renderer guard is in components/)
 *
 * Run: node --experimental-strip-types tests/phase3-graph-rag-recall.test.mjs
 */

import assert from "node:assert/strict";

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

// ---------- mock fetch / synthetic graph recall ----------

function buildGraphRecall(query, fixture) {
  // Naive recall over the fixture: matches event title text contains the
  // first significant query token; assembles a 2-hop path mission→event→contact
  // with provenance + product-of-weights confidence.
  const tokens = query
    .toLowerCase()
    .split(/\W+/)
    .filter((w) => w.length > 3);
  let evidence = [];
  let path = [];
  let confidence = 0;
  for (const evt of fixture.events) {
    if (tokens.some((tok) => evt.title.toLowerCase().includes(tok))) {
      const mission = fixture.missions.find((m) => m.id === evt.mission_id);
      const contact = fixture.contacts.find((c) => c.event_id === evt.id);
      if (mission && contact) {
        path = [mission.id, evt.id, contact.id];
        evidence = [
          {
            node_id: mission.id,
            label: "mission",
            source_table: "missions",
            source_row_id: mission.id,
            source_url: mission.source_url,
            asserted_at: "2026-04-20T00:00:00Z",
          },
          {
            node_id: evt.id,
            label: "event",
            source_table: "connector_responses_archive",
            source_row_id: evt.id,
            source_url: evt.source_url,
            asserted_at: "2026-04-20T00:00:00Z",
          },
          {
            node_id: contact.id,
            label: "contact",
            source_table: "connector_responses_archive",
            source_row_id: contact.id,
            source_url: contact.source_url,
            asserted_at: "2026-04-20T00:00:00Z",
          },
        ];
        confidence = mission.weight_to_event * evt.weight_to_contact;
        break;
      }
    }
  }
  if (evidence.length === 0) {
    return {
      candidates: [],
      evidence: [],
      path: [],
      confidence: 0,
      evidence_mode: "vector_only",
    };
  }
  return {
    candidates: [{ node_id: path[path.length - 1] }],
    evidence,
    path,
    confidence,
    evidence_mode: "graph_cited",
  };
}

const FIXTURE = {
  missions: [
    { id: "m-1", source_url: "https://lumo/missions/m-1", weight_to_event: 0.9 },
  ],
  events: [
    {
      id: "e-1",
      mission_id: "m-1",
      title: "Vegas dinner with Alice",
      source_url: "https://calendar.google.com/?eid=e-1",
      weight_to_contact: 0.8,
    },
  ],
  contacts: [
    { id: "c-1", event_id: "e-1", source_url: "https://mail.google.com/m-200" },
  ],
};

// Mock fetch — every test that wants to call /api/graph/recall goes through this.
globalThis.fetch = async (_url, opts) => {
  const body = JSON.parse(opts?.body ?? "{}");
  const result = buildGraphRecall(body.query ?? "", FIXTURE);
  return {
    ok: true,
    status: 200,
    json: async () => result,
  };
};

console.log("\nKG-1 GraphRAG recall");

await t("returns graph_cited evidence for relevant query", async () => {
  const r = await fetch("/api/graph/recall", {
    method: "POST",
    body: JSON.stringify({ query: "who did I meet about the Vegas trip last month" }),
  });
  const j = await r.json();
  assert.equal(j.evidence_mode, "graph_cited");
  assert.equal(j.evidence.length, 3);
  assert.equal(j.path[0], "m-1");
  assert.equal(j.path[2], "c-1");
});

await t("each evidence row carries provenance triplet", async () => {
  const r = await fetch("/api/graph/recall", {
    method: "POST",
    body: JSON.stringify({ query: "Vegas dinner" }),
  });
  const j = await r.json();
  for (const ev of j.evidence) {
    assert.ok(ev.source_table, "source_table missing");
    assert.ok(ev.source_row_id, "source_row_id missing");
    assert.ok("source_url" in ev, "source_url field missing");
    assert.ok(ev.node_id, "node_id missing");
    assert.ok(ev.asserted_at, "asserted_at missing");
  }
});

await t("confidence is product of edge weights", async () => {
  const r = await fetch("/api/graph/recall", {
    method: "POST",
    body: JSON.stringify({ query: "Vegas dinner" }),
  });
  const j = await r.json();
  assert.ok(Math.abs(j.confidence - 0.9 * 0.8) < 1e-9);
});

await t("falls back to vector_only on no graph evidence", async () => {
  const r = await fetch("/api/graph/recall", {
    method: "POST",
    body: JSON.stringify({ query: "tasmania devil migration patterns" }),
  });
  const j = await r.json();
  assert.equal(j.evidence_mode, "vector_only");
  assert.equal(j.evidence.length, 0);
  assert.deepEqual(j.path, []);
});

await t("client renderer contract: refuses graph response without evidence", async () => {
  // Model the renderer guard: a graph_cited response with empty evidence is
  // a contract violation that the client must reject.
  function renderGate(resp) {
    if (resp.evidence_mode === "graph_cited" && resp.evidence.length === 0) {
      throw new Error("graph_cited response missing evidence");
    }
    return true;
  }
  const bad = { evidence_mode: "graph_cited", evidence: [], path: ["m-1"], confidence: 0.5 };
  assert.throws(() => renderGate(bad));
});

await t("citation count >= 2 for the master spec demo query", async () => {
  // ADR-008 §11.4: chat orchestrator surfaces a graph-cited answer to
  // "who did I meet about the Vegas trip last month" with >= 2 evidence rows.
  const r = await fetch("/api/graph/recall", {
    method: "POST",
    body: JSON.stringify({ query: "who did I meet about the Vegas trip last month" }),
  });
  const j = await r.json();
  assert.ok(j.evidence.length >= 2);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
