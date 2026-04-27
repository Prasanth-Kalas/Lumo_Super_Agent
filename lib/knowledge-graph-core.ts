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

export interface KnowledgeGraphSynthesis {
  answer: string;
  citations?: KnowledgeGraphCitation[];
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
  const queryEmbedding = hashTextEmbedding(question);
  const edgeFilter = inferKnowledgeGraphEdgeFilter(question);
  const scored = fixture.nodes
    .filter((node) => node.user_id === userId && hasNodeProvenance(node))
    .map((node) => ({ node, score: cosineSimilarity(queryEmbedding, hashTextEmbedding(nodeSearchText(node))) }))
    .filter((row) => row.score > 0.24)
    .sort((a, b) => b.score - a.score)
    .slice(0, 10);

  const traversals = scored.flatMap(({ node }) =>
    traverseGraphInMemory({
      fixture,
      user_id: userId,
      start_node_id: node.id,
      max_hops: options.max_hops ?? 3,
      max_results: 10,
      edge_filter: edgeFilter.length > 0 ? edgeFilter : null,
    }),
  );
  return recallFromTraversalRows(question, traversals, started, "fixture", options.max_results);
}

export function recallFromTraversalRows(
  question: string,
  traversals: KnowledgeGraphTraversalRow[],
  started: number,
  source: "graph" | "fixture",
  maxResults = 5,
  synthesis?: KnowledgeGraphSynthesis | null,
): KnowledgeGraphRecallResult {
  const selectedRows = selectTraversalRows(question, traversals, maxResults);
  if (selectedRows.length === 0) return vectorOnly(started);
  const evidence = dedupeEvidence(selectedRows.flatMap((row) => row.evidence)).slice(0, 30);
  const citations = (synthesis?.citations?.length ? synthesis.citations : citationsFromEvidence(evidence)).slice(0, 8);
  if (citations.length < 2) return vectorOnly(started);
  const paths = selectedRows.map((row) => row.path);
  const confidence = selectedRows.length > 1
    ? roundScore(selectedRows.reduce((product, row) => product * row.score, 1))
    : selectedRows[0]?.score ?? 0;
  return {
    answer: synthesis?.answer?.trim() || summarizeEvidence(question, citations),
    citations,
    traversal_path: paths,
    candidates: selectedRows.slice(0, maxResults).map((row) => ({
      node_id: row.node_id,
      label: row.label,
      score: row.score,
    })),
    evidence,
    path: paths[0] ?? [],
    confidence,
    evidence_mode: "graph_cited",
    source,
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
    .slice(0, 4)
    .map((citation) => citation.text)
    .filter(Boolean)
    .join("; ");
  return cited
    ? `I found graph evidence for "${question}": ${cited}.`
    : `I found graph evidence for "${question}".`;
}

export function inferKnowledgeGraphEdgeFilter(question: string): string[] {
  const tokens = new Set(normalizeText(question).split(/\s+/).filter(Boolean));
  if (
    tokens.has("why") ||
    tokens.has("made") ||
    tokens.has("over") ||
    tokens.has("blocked") ||
    tokens.has("block") ||
    tokens.has("cancelled") ||
    tokens.has("canceled")
  ) {
    return ["BLOCKED_BY", "LED_TO", "RELATED_TO"];
  }
  if (tokens.has("where") || tokens.has("place") || tokens.has("location")) {
    return ["OCCURS_AT", "RELATED_TO", "MENTIONS"];
  }
  if (tokens.has("prefer") || tokens.has("preference") || tokens.has("picked") || tokens.has("pick")) {
    return ["PREFERS", "LED_TO", "RELATED_TO"];
  }
  return [];
}

export function hashTextEmbedding(text: string, dimensions = 384): number[] {
  const values = Array.from({ length: dimensions }, () => 0);
  for (const token of tokenize(text)) {
    const hash = fnv1a(token);
    const index = hash % dimensions;
    const sign = (hash & 1) === 0 ? 1 : -1;
    values[index] = (values[index] ?? 0) + sign * Math.max(1, Math.min(3, token.length / 4));
  }
  const norm = Math.sqrt(values.reduce((sum, value) => sum + value * value, 0)) || 1;
  return values.map((value) => Math.round((value / norm) * 1_000_000) / 1_000_000);
}

export function summaryText(node: KnowledgeGraphNode): string {
  const props = node.properties ?? {};
  for (const key of ["summary", "title", "name", "subject", "text", "description"]) {
    const value = props[key];
    if (typeof value === "string" && value.trim()) return value;
  }
  return node.external_key;
}

export function vectorOnly(started: number): KnowledgeGraphRecallResult {
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

function selectTraversalRows(
  question: string,
  traversals: KnowledgeGraphTraversalRow[],
  maxResults: number,
): KnowledgeGraphTraversalRow[] {
  const edgeFilter = inferKnowledgeGraphEdgeFilter(question);
  const causal = traversals
    .filter((row) => row.edge_types.some((edge) => edge.toUpperCase() === "BLOCKED_BY"))
    .sort((a, b) => a.depth - b.depth || b.score - a.score);
  if (causal.length >= 2) {
    const sourceKey = (row: KnowledgeGraphTraversalRow) => row.path[0] ?? "";
    const counts = new Map<string, number>();
    for (const row of causal) counts.set(sourceKey(row), (counts.get(sourceKey(row)) ?? 0) + 1);
    const bestSource = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0];
    if (bestSource) return causal.filter((row) => sourceKey(row) === bestSource).slice(0, Math.max(2, maxResults));
  }
  const hinted = traversals
    .filter((row) => row.edge_types.some((edge) => edgeFilter.includes(edge.toUpperCase())))
    .sort((a, b) => a.depth - b.depth || b.score - a.score);
  if (hinted.length >= 2) {
    const sourceKey = (row: KnowledgeGraphTraversalRow) => row.path[0] ?? "";
    const counts = new Map<string, number>();
    for (const row of hinted) counts.set(sourceKey(row), (counts.get(sourceKey(row)) ?? 0) + 1);
    const bestSource = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0];
    if (bestSource) return hinted.filter((row) => sourceKey(row) === bestSource).slice(0, Math.max(2, maxResults));
  }
  return traversals
    .slice()
    .sort((a, b) => b.score - a.score || a.depth - b.depth || a.node_id.localeCompare(b.node_id))
    .slice(0, Math.max(1, maxResults));
}

function dedupeEvidence(evidence: KnowledgeGraphEvidence[]): KnowledgeGraphEvidence[] {
  const seen = new Set<string>();
  const out: KnowledgeGraphEvidence[] = [];
  for (const item of evidence) {
    const key = `${item.kind}:${item.node_id ?? item.edge_id ?? item.source_table}:${item.source_row_id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

function searchText(node: KnowledgeGraphNode): string {
  return `${node.label} ${node.external_key} ${summaryText(node)} ${JSON.stringify(node.properties ?? {})}`;
}

function nodeSearchText(node: KnowledgeGraphNode): string {
  return searchText(node);
}

function cosineSimilarity(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  let dot = 0;
  let an = 0;
  let bn = 0;
  for (let i = 0; i < n; i++) {
    const av = a[i] ?? 0;
    const bv = b[i] ?? 0;
    dot += av * bv;
    an += av * av;
    bn += bv * bv;
  }
  if (an <= 0 || bn <= 0) return 0;
  return roundScore(dot / (Math.sqrt(an) * Math.sqrt(bn)));
}

function fnv1a(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
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
