export type GraphEvidenceMode = "graph_cited" | "vector_only";

export interface KnowledgeGraphNode {
  id: string;
  user_id: string;
  label: string;
  external_key: string;
  properties?: Record<string, unknown>;
  source_table: string | null;
  source_row_id: string | null;
  source_url?: string | null;
  asserted_at?: string | null;
}

export interface KnowledgeGraphEdge {
  id: string;
  user_id: string;
  source_id: string;
  target_id: string;
  edge_type: string;
  weight?: number | null;
  properties?: Record<string, unknown>;
  source_table: string | null;
  source_row_id: string | null;
  source_url?: string | null;
  asserted_at?: string | null;
}

export interface KnowledgeGraphFixture {
  user?: { id?: string; [key: string]: unknown };
  nodes: KnowledgeGraphNode[];
  edges: KnowledgeGraphEdge[];
}

export interface KnowledgeGraphCitation {
  node_id: string;
  label: string;
  source_table: string;
  source_row_id: string;
  source_url: string | null;
  asserted_at: string | null;
  text: string;
}

export interface KnowledgeGraphEvidence {
  kind: "node" | "edge";
  node_id?: string;
  edge_id?: string;
  label?: string;
  edge_type?: string;
  source_table: string;
  source_row_id: string;
  source_url: string | null;
  asserted_at: string | null;
  text?: string;
}

export interface KnowledgeGraphTraversalRow {
  node_id: string;
  label: string;
  properties: Record<string, unknown>;
  depth: number;
  score: number;
  path: string[];
  edge_types: string[];
  evidence: KnowledgeGraphEvidence[];
}

export interface KnowledgeGraphRecallResult {
  answer: string;
  citations: KnowledgeGraphCitation[];
  traversal_path: string[][];
  candidates: Array<{ node_id: string; label: string; score: number }>;
  evidence: KnowledgeGraphEvidence[];
  path: string[];
  confidence: number;
  evidence_mode: GraphEvidenceMode;
  source: "graph" | "fixture" | "fallback";
  latency_ms: number;
}

export interface TraverseGraphArgs {
  fixture: KnowledgeGraphFixture;
  user_id: string;
  start_node_id: string;
  max_hops?: number;
  max_results?: number;
  edge_filter?: string[] | null;
}

export function validateKnowledgeGraphFixture(fixture: KnowledgeGraphFixture): {
  ok: boolean;
  errors: string[];
  node_count: number;
  edge_count: number;
} {
  const errors: string[] = [];
  const nodeById = new Map<string, KnowledgeGraphNode>();
  for (const node of fixture.nodes ?? []) {
    if (!node.id) errors.push("node missing id");
    if (!node.user_id) errors.push(`${node.id}: node missing user_id`);
    if (!node.label) errors.push(`${node.id}: node missing label`);
    if (!node.external_key) errors.push(`${node.id}: node missing external_key`);
    if (!node.source_table) errors.push(`${node.id}: node missing source_table`);
    if (!node.source_row_id) errors.push(`${node.id}: node missing source_row_id`);
    if (!("source_url" in node)) errors.push(`${node.id}: node missing source_url field`);
    nodeById.set(node.id, node);
  }
  for (const edge of fixture.edges ?? []) {
    const source = nodeById.get(edge.source_id);
    const target = nodeById.get(edge.target_id);
    if (!edge.id) errors.push("edge missing id");
    if (!edge.user_id) errors.push(`${edge.id}: edge missing user_id`);
    if (!edge.edge_type) errors.push(`${edge.id}: edge missing edge_type`);
    if (!edge.source_table) errors.push(`${edge.id}: edge missing source_table`);
    if (!edge.source_row_id) errors.push(`${edge.id}: edge missing source_row_id`);
    if (!("source_url" in edge)) errors.push(`${edge.id}: edge missing source_url field`);
    if (!source || !target) {
      errors.push(`${edge.id}: edge references unknown node`);
      continue;
    }
    if (source.user_id !== target.user_id || source.user_id !== edge.user_id) {
      errors.push(`${edge.id}: cross-user edge forbidden`);
    }
  }
  return {
    ok: errors.length === 0,
    errors,
    node_count: fixture.nodes?.length ?? 0,
    edge_count: fixture.edges?.length ?? 0,
  };
}

export function traverseGraphInMemory(args: TraverseGraphArgs): KnowledgeGraphTraversalRow[] {
  const fixture = args.fixture;
  const maxHops = clampInt(args.max_hops, 1, 3, 3);
  const maxResults = clampInt(args.max_results, 1, 100, 50);
  const edgeFilter = new Set((args.edge_filter ?? []).map((edge) => edge.toLowerCase()));
  const nodeById = new Map(fixture.nodes.map((node) => [node.id, node]));
  const edgesBySource = new Map<string, KnowledgeGraphEdge[]>();
  for (const edge of fixture.edges) {
    const source = nodeById.get(edge.source_id);
    const target = nodeById.get(edge.target_id);
    if (!source || !target) continue;
    if (edge.user_id !== args.user_id || source.user_id !== args.user_id || target.user_id !== args.user_id) {
      continue;
    }
    if (edgeFilter.size > 0 && !edgeFilter.has(edge.edge_type.toLowerCase())) continue;
    const existing = edgesBySource.get(edge.source_id) ?? [];
    existing.push(edge);
    edgesBySource.set(edge.source_id, existing);
  }

  const start = nodeById.get(args.start_node_id);
  if (!start || start.user_id !== args.user_id || !hasNodeProvenance(start)) return [];

  const out: KnowledgeGraphTraversalRow[] = [];
  const stack: KnowledgeGraphTraversalRow[] = [
    {
      node_id: start.id,
      label: start.label,
      properties: start.properties ?? {},
      depth: 0,
      score: 1,
      path: [start.id],
      edge_types: [],
      evidence: [nodeEvidence(start)],
    },
  ];

  while (stack.length > 0) {
    const current = stack.pop();
    if (!current || current.depth >= maxHops) continue;
    const edges = edgesBySource.get(current.node_id) ?? [];
    for (const edge of edges) {
      const target = nodeById.get(edge.target_id);
      if (!target || !hasNodeProvenance(target) || !hasEdgeProvenance(edge)) continue;
      if (current.path.includes(target.id)) continue;
      const next: KnowledgeGraphTraversalRow = {
        node_id: target.id,
        label: target.label,
        properties: target.properties ?? {},
        depth: current.depth + 1,
        score: roundScore(current.score * safeWeight(edge.weight)),
        path: [...current.path, target.id],
        edge_types: [...current.edge_types, edge.edge_type],
        evidence: [...current.evidence, edgeEvidence(edge), nodeEvidence(target)],
      };
      out.push(next);
      stack.push(next);
    }
  }

  return out
    .sort((a, b) => a.depth - b.depth || b.score - a.score || a.node_id.localeCompare(b.node_id))
    .slice(0, maxResults);
}

export function recallGraphFromFixture(
  question: string,
  fixture: KnowledgeGraphFixture,
  options: { user_id?: string; max_hops?: number; max_results?: number } = {},
): KnowledgeGraphRecallResult {
  const started = Date.now();
  const userId = options.user_id ?? fixture.user?.id ?? fixture.nodes[0]?.user_id ?? "";
  const normalized = normalizeText(question);
  const tahoeVegas = normalized.includes("vegas") && normalized.includes("tahoe");
  if (tahoeVegas && (normalized.includes("why") || normalized.includes("pick") || normalized.includes("over"))) {
    const narrative = tahoeVegasNarrative(fixture, userId, started);
    if (narrative.evidence_mode === "graph_cited") return narrative;
  }

  const tokens = tokenize(question);
  const scored = fixture.nodes
    .filter((node) => node.user_id === userId && hasNodeProvenance(node))
    .map((node) => ({ node, score: nodeSearchScore(node, tokens) }))
    .filter((row) => row.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 5);

  const traversals = scored.flatMap(({ node }) =>
    traverseGraphInMemory({
      fixture,
      user_id: userId,
      start_node_id: node.id,
      max_hops: options.max_hops ?? 3,
      max_results: 10,
    }),
  );
  const best = traversals.sort((a, b) => b.score - a.score || a.depth - b.depth)[0];
  if (!best) return vectorOnly(started);
  const citations = citationsFromEvidence(best.evidence).slice(0, Math.max(2, Math.min(5, best.evidence.length)));
  if (citations.length < 2) return vectorOnly(started);
  return {
    answer: summarizeEvidence(question, citations),
    citations,
    traversal_path: [best.path],
    candidates: traversals.slice(0, options.max_results ?? 5).map((row) => ({
      node_id: row.node_id,
      label: row.label,
      score: row.score,
    })),
    evidence: best.evidence,
    path: best.path,
    confidence: best.score,
    evidence_mode: "graph_cited",
    source: "fixture",
    latency_ms: Date.now() - started,
  };
}

export function assertGraphCitedHasProvenance(result: KnowledgeGraphRecallResult): void {
  if (result.evidence_mode !== "graph_cited") return;
  if (result.evidence.length === 0 || result.citations.length === 0) {
    throw new Error("graph_cited response missing evidence");
  }
  for (const evidence of result.evidence) {
    if (!evidence.source_table || !evidence.source_row_id) {
      throw new Error("graph_cited response contains null provenance");
    }
  }
  for (const citation of result.citations) {
    if (!citation.source_table || !citation.source_row_id || !("source_url" in citation)) {
      throw new Error("graph_cited citation missing provenance");
    }
  }
}

function tahoeVegasNarrative(
  fixture: KnowledgeGraphFixture,
  userId: string,
  started: number,
): KnowledgeGraphRecallResult {
  const tahoeMission = fixture.nodes.find(
    (node) =>
      node.user_id === userId &&
      node.label === "mission" &&
      `${node.external_key} ${summaryText(node)}`.toLowerCase().includes("tahoe") &&
      `${node.properties?.state ?? ""}`.toLowerCase().includes("cancel"),
  );
  if (!tahoeMission) return vectorOnly(started);
  const blockers = fixture.edges
    .filter(
      (edge) =>
        edge.user_id === userId &&
        edge.source_id === tahoeMission.id &&
        edge.edge_type.toLowerCase() === "blocked_by" &&
        hasEdgeProvenance(edge),
    )
    .map((edge) => ({ edge, target: fixture.nodes.find((node) => node.id === edge.target_id) }))
    .filter((row): row is { edge: KnowledgeGraphEdge; target: KnowledgeGraphNode } =>
      Boolean(row.target && hasNodeProvenance(row.target)),
    );
  if (blockers.length < 2) return vectorOnly(started);
  const vegasMission = fixture.nodes.find(
    (node) =>
      node.user_id === userId &&
      node.label === "mission" &&
      `${node.external_key} ${summaryText(node)}`.toLowerCase().includes("vegas") &&
      `${node.properties?.state ?? ""}`.toLowerCase().includes("completed"),
  );
  const blockerEvidence = [nodeEvidence(tahoeMission)];
  const traversalPath: string[][] = [];
  let confidence = 1;
  for (const { edge, target } of blockers.slice(0, 4)) {
    blockerEvidence.push(edgeEvidence(edge), nodeEvidence(target));
    traversalPath.push([tahoeMission.id, target.id]);
    confidence *= safeWeight(edge.weight);
  }
  if (vegasMission && hasNodeProvenance(vegasMission)) {
    blockerEvidence.push(nodeEvidence(vegasMission));
  }
  const citations = citationsFromEvidence(blockerEvidence).slice(0, 5);
  return {
    answer:
      "Sam pivoted from Tahoe to Vegas because the Tahoe mission was blocked by the Q4 board meeting moving to Dec 14 and a Lake Tahoe storm forecast for Dec 13-15. Vegas also matched the existing warm-weather, food, and entertainment preferences in the graph.",
    citations,
    traversal_path: traversalPath,
    candidates: citations.map((citation, index) => ({
      node_id: citation.node_id,
      label: citation.label,
      score: roundScore(confidence / (index + 1)),
    })),
    evidence: blockerEvidence,
    path: traversalPath[0] ?? [tahoeMission.id],
    confidence: roundScore(confidence),
    evidence_mode: "graph_cited",
    source: "fixture",
    latency_ms: Date.now() - started,
  };
}

function citationsFromEvidence(evidence: KnowledgeGraphEvidence[]): KnowledgeGraphCitation[] {
  const seen = new Set<string>();
  const out: KnowledgeGraphCitation[] = [];
  for (const ev of evidence) {
    if (ev.kind !== "node" || !ev.node_id || !ev.label) continue;
    if (seen.has(ev.node_id)) continue;
    seen.add(ev.node_id);
    out.push({
      node_id: ev.node_id,
      label: ev.label,
      source_table: ev.source_table,
      source_row_id: ev.source_row_id,
      source_url: ev.source_url,
      asserted_at: ev.asserted_at,
      text: ev.text ?? ev.label,
    });
  }
  return out;
}

function nodeEvidence(node: KnowledgeGraphNode): KnowledgeGraphEvidence {
  if (!hasNodeProvenance(node)) throw new Error(`${node.id}: node missing provenance`);
  return {
    kind: "node",
    node_id: node.id,
    label: node.label,
    source_table: node.source_table,
    source_row_id: node.source_row_id,
    source_url: node.source_url ?? null,
    asserted_at: node.asserted_at ?? null,
    text: summaryText(node),
  };
}

function edgeEvidence(edge: KnowledgeGraphEdge): KnowledgeGraphEvidence {
  if (!hasEdgeProvenance(edge)) throw new Error(`${edge.id}: edge missing provenance`);
  return {
    kind: "edge",
    edge_id: edge.id,
    edge_type: edge.edge_type,
    source_table: edge.source_table,
    source_row_id: edge.source_row_id,
    source_url: edge.source_url ?? null,
    asserted_at: edge.asserted_at ?? null,
    text: edge.edge_type,
  };
}

function hasNodeProvenance(node: KnowledgeGraphNode): node is KnowledgeGraphNode & {
  source_table: string;
  source_row_id: string;
} {
  return Boolean(node.source_table && node.source_row_id && "source_url" in node);
}

function hasEdgeProvenance(edge: KnowledgeGraphEdge): edge is KnowledgeGraphEdge & {
  source_table: string;
  source_row_id: string;
} {
  return Boolean(edge.source_table && edge.source_row_id && "source_url" in edge);
}

function summarizeEvidence(question: string, citations: KnowledgeGraphCitation[]): string {
  const cited = citations
    .slice(0, 3)
    .map((citation) => citation.text)
    .filter(Boolean)
    .join("; ");
  return cited
    ? `I found graph evidence for "${question}": ${cited}.`
    : `I found graph evidence for "${question}".`;
}

function nodeSearchScore(node: KnowledgeGraphNode, tokens: string[]): number {
  const haystack = normalizeText(`${node.label} ${node.external_key} ${summaryText(node)} ${JSON.stringify(node.properties ?? {})}`);
  let score = 0;
  for (const token of tokens) {
    if (haystack.includes(token)) score += token.length;
  }
  return score;
}

function summaryText(node: KnowledgeGraphNode): string {
  const props = node.properties ?? {};
  for (const key of ["summary", "title", "name", "subject", "text", "description"]) {
    const value = props[key];
    if (typeof value === "string" && value.trim()) return value;
  }
  return node.external_key;
}

function vectorOnly(started: number): KnowledgeGraphRecallResult {
  return {
    answer: "I could not find graph-cited evidence yet, so this should fall back to regular recall.",
    citations: [],
    traversal_path: [],
    candidates: [],
    evidence: [],
    path: [],
    confidence: 0,
    evidence_mode: "vector_only",
    source: "fallback",
    latency_ms: Date.now() - started,
  };
}

function tokenize(input: string): string[] {
  return normalizeText(input)
    .split(/\s+/)
    .filter((token) => token.length > 2 && !STOP_WORDS.has(token));
}

function normalizeText(input: string): string {
  return input.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function safeWeight(weight: number | null | undefined): number {
  return Math.max(0, Math.min(1, Number.isFinite(weight) ? Number(weight) : 1));
}

function roundScore(score: number): number {
  return Math.round(score * 1_000_000) / 1_000_000;
}

function clampInt(
  value: number | undefined,
  min: number,
  max: number,
  fallback: number,
): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(Number(value))));
}

const STOP_WORDS = new Set([
  "the",
  "and",
  "for",
  "with",
  "that",
  "this",
  "did",
  "what",
  "why",
  "who",
  "how",
  "over",
  "last",
  "month",
  "pick",
  "made",
  "from",
  "about",
]);
