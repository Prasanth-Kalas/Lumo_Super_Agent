import { getSupabase } from "./db.ts";
import {
  recallGraphFromFixture,
  validateKnowledgeGraphFixture,
  type KnowledgeGraphEdge,
  type KnowledgeGraphFixture,
  type KnowledgeGraphNode,
  type KnowledgeGraphRecallResult,
  type KnowledgeGraphTraversalRow,
} from "./knowledge-graph-core.ts";

export interface RecallKnowledgeGraphArgs {
  user_id: string;
  question: string;
  max_hops?: number;
  max_results?: number;
}

export interface RebuildKnowledgeGraphResult {
  ok: boolean;
  applied: boolean;
  node_count: number;
  edge_count: number;
  errors: string[];
}

export interface GraphNodeSeedRow {
  user_id: string;
  label: string;
  external_key: string;
  properties: Record<string, unknown>;
  source_table: string | null;
  source_row_id: string | null;
  source_url: string | null;
  asserted_at: string;
}

export interface GraphEdgeSeedRow {
  user_id: string;
  source_id: string;
  target_id: string;
  edge_type: string;
  properties: Record<string, unknown>;
  weight: number;
  source_table: string | null;
  source_row_id: string | null;
  source_url: string | null;
  asserted_at: string;
}

export interface GraphNodeIdentityRow {
  id: string;
  user_id: string;
  label: string;
  external_key: string;
}

export async function recallKnowledgeGraph(
  args: RecallKnowledgeGraphArgs,
): Promise<KnowledgeGraphRecallResult> {
  const db = getSupabase();
  if (!db) {
    return recallGraphFromFixture(args.question, emptyFixture(args.user_id), {
      user_id: args.user_id,
      max_hops: args.max_hops,
      max_results: args.max_results,
    });
  }

  const [nodesResult, edgesResult] = await Promise.all([
    db
      .from("graph_nodes")
      .select("id,user_id,label,external_key,properties,source_table,source_row_id,source_url,asserted_at")
      .eq("user_id", args.user_id)
      .limit(2_000),
    db
      .from("graph_edges")
      .select("id,user_id,source_id,target_id,edge_type,weight,properties,source_table,source_row_id,source_url,asserted_at")
      .eq("user_id", args.user_id)
      .limit(5_000),
  ]);

  if (nodesResult.error || edgesResult.error) {
    console.warn("[knowledge-graph] recall read failed", {
      nodes_error: nodesResult.error?.message,
      edges_error: edgesResult.error?.message,
    });
    return recallGraphFromFixture(args.question, emptyFixture(args.user_id), {
      user_id: args.user_id,
      max_hops: args.max_hops,
      max_results: args.max_results,
    });
  }

  const fixture: KnowledgeGraphFixture = {
    user: { id: args.user_id },
    nodes: normalizeNodeRows(nodesResult.data ?? []),
    edges: normalizeEdgeRows(edgesResult.data ?? []),
  };
  const result = recallGraphFromFixture(args.question, fixture, {
    user_id: args.user_id,
    max_hops: args.max_hops,
    max_results: args.max_results,
  });
  return { ...result, source: result.evidence_mode === "graph_cited" ? "graph" : result.source };
}

export async function seedKnowledgeGraphFixture(
  user_id: string,
  fixture: KnowledgeGraphFixture,
  options: { apply?: boolean } = {},
): Promise<RebuildKnowledgeGraphResult> {
  const validation = validateKnowledgeGraphFixture(fixture);
  if (!validation.ok) {
    return {
      ok: false,
      applied: false,
      node_count: validation.node_count,
      edge_count: validation.edge_count,
      errors: validation.errors,
    };
  }
  if (!options.apply) {
    return {
      ok: true,
      applied: false,
      node_count: validation.node_count,
      edge_count: validation.edge_count,
      errors: [],
    };
  }

  const db = getSupabase();
  if (!db) {
    return {
      ok: false,
      applied: false,
      node_count: validation.node_count,
      edge_count: validation.edge_count,
      errors: ["persistence_not_configured"],
    };
  }

  const nodeRows = prepareGraphNodeSeedRows(user_id, fixture);
  const nodeResult = await db
    .from("graph_nodes")
    .upsert(nodeRows, { onConflict: "user_id,label,external_key" })
    .select("id,user_id,label,external_key");
  if (nodeResult.error) {
    return {
      ok: false,
      applied: false,
      node_count: validation.node_count,
      edge_count: validation.edge_count,
      errors: [nodeResult.error.message],
    };
  }

  let edgeRows: GraphEdgeSeedRow[];
  try {
    const nodeIdByFixtureId = buildGraphSeedNodeIdMap(
      user_id,
      fixture,
      normalizeNodeIdentityRows(nodeResult.data ?? []),
    );
    edgeRows = prepareGraphEdgeSeedRows(user_id, fixture, nodeIdByFixtureId);
  } catch (err) {
    return {
      ok: false,
      applied: false,
      node_count: validation.node_count,
      edge_count: validation.edge_count,
      errors: [err instanceof Error ? err.message : String(err)],
    };
  }
  const edgeResult = await db
    .from("graph_edges")
    .upsert(edgeRows, { onConflict: "user_id,source_id,target_id,edge_type" });
  if (edgeResult.error) {
    return {
      ok: false,
      applied: false,
      node_count: validation.node_count,
      edge_count: validation.edge_count,
      errors: [edgeResult.error.message],
    };
  }

  return {
    ok: true,
    applied: true,
    node_count: validation.node_count,
    edge_count: validation.edge_count,
    errors: [],
  };
}

export function prepareGraphNodeSeedRows(
  user_id: string,
  fixture: KnowledgeGraphFixture,
): GraphNodeSeedRow[] {
  return fixture.nodes.map((node) => ({
    user_id,
    label: node.label.toLowerCase(),
    external_key: node.external_key,
    properties: node.properties ?? {},
    source_table: node.source_table,
    source_row_id: node.source_row_id,
    source_url: node.source_url ?? null,
    asserted_at: node.asserted_at ?? new Date().toISOString(),
  }));
}

export function buildGraphSeedNodeIdMap(
  user_id: string,
  fixture: KnowledgeGraphFixture,
  dbRows: GraphNodeIdentityRow[],
): Map<string, string> {
  const byKey = new Map<string, string>();
  for (const row of dbRows) {
    if (row.user_id !== user_id) continue;
    byKey.set(nodeSeedKey(row.label, row.external_key), row.id);
  }
  const out = new Map<string, string>();
  for (const node of fixture.nodes) {
    const dbId = byKey.get(nodeSeedKey(node.label, node.external_key));
    if (!dbId) {
      throw new Error(`graph_seed_node_id_missing:${node.label}:${node.external_key}`);
    }
    out.set(node.id, dbId);
  }
  return out;
}

export function prepareGraphEdgeSeedRows(
  user_id: string,
  fixture: KnowledgeGraphFixture,
  nodeIdByFixtureId: Map<string, string>,
): GraphEdgeSeedRow[] {
  return fixture.edges.map((edge) => {
    const source_id = nodeIdByFixtureId.get(edge.source_id);
    const target_id = nodeIdByFixtureId.get(edge.target_id);
    if (!source_id || !target_id) {
      throw new Error(`graph_seed_edge_endpoint_missing:${edge.id}`);
    }
    return {
      user_id,
      source_id,
      target_id,
      edge_type: edge.edge_type.toUpperCase(),
      properties: edge.properties ?? {},
      weight: edge.weight ?? 1,
      source_table: edge.source_table,
      source_row_id: edge.source_row_id,
      source_url: edge.source_url ?? null,
      asserted_at: edge.asserted_at ?? new Date().toISOString(),
    };
  });
}

export async function traverseKnowledgeGraph(
  user_id: string,
  start_node_id: string,
  options: { edge_filter?: string[]; max_hops?: number; max_results?: number } = {},
): Promise<KnowledgeGraphTraversalRow[]> {
  const db = getSupabase();
  if (!db) return [];
  const { data, error } = await db.rpc("lumo_kg_traverse", {
    p_user_id: user_id,
    p_start_node_id: start_node_id,
    p_edge_filter: options.edge_filter ?? null,
    p_max_hops: options.max_hops ?? 3,
    p_max_results: options.max_results ?? 50,
  });
  if (error) {
    console.warn("[knowledge-graph] traverse rpc failed", error.message);
    return [];
  }
  return (data ?? []) as KnowledgeGraphTraversalRow[];
}

function normalizeNodeIdentityRows(rows: unknown[]): GraphNodeIdentityRow[] {
  return rows.map((row) => {
    const r = row as Record<string, unknown>;
    return {
      id: String(r.id),
      user_id: String(r.user_id),
      label: String(r.label),
      external_key: String(r.external_key),
    };
  });
}

function normalizeNodeRows(rows: unknown[]): KnowledgeGraphNode[] {
  return rows.map((row) => {
    const r = row as Record<string, unknown>;
    return {
      id: String(r.id),
      user_id: String(r.user_id),
      label: String(r.label),
      external_key: String(r.external_key),
      properties: isRecord(r.properties) ? r.properties : {},
      source_table: typeof r.source_table === "string" ? r.source_table : null,
      source_row_id: typeof r.source_row_id === "string" ? r.source_row_id : null,
      source_url: typeof r.source_url === "string" ? r.source_url : null,
      asserted_at: typeof r.asserted_at === "string" ? r.asserted_at : null,
    };
  });
}

function normalizeEdgeRows(rows: unknown[]): KnowledgeGraphEdge[] {
  return rows.map((row) => {
    const r = row as Record<string, unknown>;
    return {
      id: String(r.id),
      user_id: String(r.user_id),
      source_id: String(r.source_id),
      target_id: String(r.target_id),
      edge_type: String(r.edge_type),
      weight: typeof r.weight === "number" ? r.weight : Number(r.weight ?? 1),
      properties: isRecord(r.properties) ? r.properties : {},
      source_table: typeof r.source_table === "string" ? r.source_table : null,
      source_row_id: typeof r.source_row_id === "string" ? r.source_row_id : null,
      source_url: typeof r.source_url === "string" ? r.source_url : null,
      asserted_at: typeof r.asserted_at === "string" ? r.asserted_at : null,
    };
  });
}

function emptyFixture(user_id: string): KnowledgeGraphFixture {
  return { user: { id: user_id }, nodes: [], edges: [] };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nodeSeedKey(label: string, external_key: string): string {
  return `${label.toLowerCase()}::${external_key}`;
}
