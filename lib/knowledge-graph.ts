import { randomUUID } from "node:crypto";
import { getSupabase } from "./db.ts";
import { createBrainSdk } from "./brain-sdk/index.ts";
import { signLumoServiceJwt } from "./service-jwt.ts";
import {
  inferKnowledgeGraphEdgeFilter,
  recallGraphFromFixture,
  recallFromTraversalRows,
  summaryText,
  validateKnowledgeGraphFixture,
  vectorOnly,
  type KnowledgeGraphEdge,
  type KnowledgeGraphFixture,
  type KnowledgeGraphNode,
  type KnowledgeGraphCitation,
  type KnowledgeGraphEvidence,
  type KnowledgeGraphRecallResult,
  type KnowledgeGraphSynthesis,
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
  embedding_count?: number;
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
  embedding?: number[] | null;
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

interface KgSeedRow {
  node_id: string;
  label: string;
  properties: Record<string, unknown> | null;
  score: number;
  source_table: string | null;
  source_row_id: string | null;
  source_url: string | null;
  asserted_at: string | null;
}

interface EmbedResponse {
  dimensions?: number;
  embeddings?: number[][];
}

interface KgSynthesizeResponse {
  answer?: string;
  citations?: KnowledgeGraphCitation[];
}

const LUMO_ML_AGENT_ID = "lumo-ml";
const LUMO_EMBED_TOOL = "lumo_embed";
const LUMO_KG_SYNTHESIZE_TOOL = "lumo_kg_synthesize";
const KG_EMBED_TIMEOUT_MS = 8_000;
const KG_SYNTHESIZE_TIMEOUT_MS = 8_000;
const KG_FIXTURE_EMBED_BATCH_SIZE = 16;
const KG_FIXTURE_EMBED_MAX_ATTEMPTS = 1;
const DEFAULT_SEED_COUNT = 5;

export async function recallKnowledgeGraph(
  args: RecallKnowledgeGraphArgs,
): Promise<KnowledgeGraphRecallResult> {
  const started = Date.now();
  const db = getSupabase();
  if (!db) {
    return recallGraphFromFixture(args.question, emptyFixture(args.user_id), {
      user_id: args.user_id,
      max_hops: args.max_hops,
      max_results: args.max_results,
    });
  }

  const queryEmbedding = await embedKgText(args.user_id, args.question);
  if (!queryEmbedding) return vectorOnly(started);

  const seeds = await seedNodesByEmbedding(args.user_id, queryEmbedding, DEFAULT_SEED_COUNT);
  if (seeds.length === 0) return vectorOnly(started);

  const edgeFilter = inferKnowledgeGraphEdgeFilter(args.question);
  const traversalGroups = await Promise.all(
    seeds.map((seed) =>
      traverseKnowledgeGraph(args.user_id, seed.node_id, {
        edge_filter: edgeFilter.length > 0 ? edgeFilter : undefined,
        max_hops: args.max_hops ?? 3,
        max_results: 20,
      }),
    ),
  );
  const traversals = traversalGroups
    .flat()
    .sort((a, b) => b.score - a.score || a.depth - b.depth)
    .slice(0, 30);
  if (traversals.length === 0) return vectorOnly(started);
  const synthesis = await synthesizeGraphAnswer(args.user_id, args.question, traversals);
  const result = recallFromTraversalRows(
    args.question,
    traversals,
    started,
    "graph",
    args.max_results ?? 5,
    synthesis,
  );
  return result;
}

export async function embedKnowledgeGraphFixtureNodes(
  user_id: string,
  fixture: KnowledgeGraphFixture,
): Promise<{ embeddingsByFixtureId: Map<string, number[]>; errors: string[] }> {
  const errors: string[] = [];
  const embeddingsByFixtureId = new Map<string, number[]>();
  const nodes = fixture.nodes.filter((node) => node.user_id === (fixture.user?.id ?? node.user_id));
  for (let index = 0; index < nodes.length; index += KG_FIXTURE_EMBED_BATCH_SIZE) {
    const batch = nodes.slice(index, index + KG_FIXTURE_EMBED_BATCH_SIZE);
    const embeddings = await embedKgTexts(
      user_id,
      batch.map((node) => summaryText(node)),
      { surface: "kg-fixture-reembed" },
      { maxAttempts: KG_FIXTURE_EMBED_MAX_ATTEMPTS },
    );
    if (!embeddings || embeddings.length !== batch.length) {
      errors.push(`embedding_batch_failed:${index}`);
      continue;
    }
    for (let i = 0; i < batch.length; i++) {
      const node = batch[i];
      const embedding = embeddings[i];
      if (node && embedding) embeddingsByFixtureId.set(node.id, embedding);
    }
  }
  return { embeddingsByFixtureId, errors };
}

export async function seedKnowledgeGraphFixture(
  user_id: string,
  fixture: KnowledgeGraphFixture,
  options: { apply?: boolean; embeddingsByFixtureId?: Map<string, number[]> } = {},
): Promise<RebuildKnowledgeGraphResult> {
  const validation = validateKnowledgeGraphFixture(fixture);
  if (!validation.ok) {
    return {
      ok: false,
      applied: false,
      node_count: validation.node_count,
      edge_count: validation.edge_count,
      embedding_count: 0,
      errors: validation.errors,
    };
  }
  if (!options.apply) {
    return {
      ok: true,
      applied: false,
      node_count: validation.node_count,
      edge_count: validation.edge_count,
      embedding_count: 0,
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
      embedding_count: 0,
      errors: ["persistence_not_configured"],
    };
  }

  const nodeRows = prepareGraphNodeSeedRows(user_id, fixture, options.embeddingsByFixtureId);
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
      embedding_count: 0,
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
      embedding_count: 0,
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
      embedding_count: options.embeddingsByFixtureId?.size ?? 0,
      errors: [edgeResult.error.message],
    };
  }

  return {
    ok: true,
    applied: true,
    node_count: validation.node_count,
    edge_count: validation.edge_count,
    embedding_count: options.embeddingsByFixtureId?.size ?? 0,
    errors: [],
  };
}

export function prepareGraphNodeSeedRows(
  user_id: string,
  fixture: KnowledgeGraphFixture,
  embeddingsByFixtureId?: Map<string, number[]>,
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
    embedding: embeddingsByFixtureId?.get(node.id) ?? null,
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
  const rows: GraphEdgeSeedRow[] = [];
  const seen = new Set<string>();
  for (const edge of fixture.edges) {
    const source_id = nodeIdByFixtureId.get(edge.source_id);
    const target_id = nodeIdByFixtureId.get(edge.target_id);
    if (!source_id || !target_id) {
      throw new Error(`graph_seed_edge_endpoint_missing:${edge.id}`);
    }
    const row = {
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
    const key = edgeSeedKey(row.user_id, row.source_id, row.target_id, row.edge_type);
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push(row);
  }
  return rows;
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
  return normalizeTraversalRows(data ?? []);
}

async function seedNodesByEmbedding(
  user_id: string,
  queryEmbedding: number[],
  k: number,
): Promise<KgSeedRow[]> {
  const db = getSupabase();
  if (!db) return [];
  const { data, error } = await db.rpc("lumo_kg_seed_by_embedding", {
    p_user_id: user_id,
    p_query_embedding: queryEmbedding,
    p_k: k,
  });
  if (error) {
    console.warn("[knowledge-graph] seed embedding rpc failed", error.message);
    return [];
  }
  return ((data ?? []) as unknown[]).map((row) => {
    const r = row as Record<string, unknown>;
    return {
      node_id: String(r.node_id),
      label: String(r.label),
      properties: isRecord(r.properties) ? r.properties : {},
      score: typeof r.score === "number" ? r.score : Number(r.score ?? 0),
      source_table: typeof r.source_table === "string" ? r.source_table : null,
      source_row_id: typeof r.source_row_id === "string" ? r.source_row_id : null,
      source_url: typeof r.source_url === "string" ? r.source_url : null,
      asserted_at: typeof r.asserted_at === "string" ? r.asserted_at : null,
    };
  });
}

async function embedKgText(user_id: string, text: string): Promise<number[] | null> {
  const embeddings = await embedKgTexts(user_id, [text], { surface: "kg-recall" });
  return embeddings?.[0] ?? null;
}

async function embedKgTexts(
  user_id: string,
  texts: string[],
  source_metadata: Record<string, unknown>,
  options: { maxAttempts?: number } = {},
): Promise<number[][] | null> {
  const baseUrl = resolveMlBaseUrl();
  const authorizationHeader = serviceAuthorizationHeader(user_id, LUMO_EMBED_TOOL);
  if (!baseUrl || !authorizationHeader || texts.length === 0) return null;
  try {
    const sdk = createBrainSdk({
      user_id,
      baseUrl,
      timeoutMs: KG_EMBED_TIMEOUT_MS,
      callerSurface: "knowledge-graph",
    });
    const body = await sdk.embed(
      { texts, source_metadata },
      { authorizationHeader, timeoutMs: KG_EMBED_TIMEOUT_MS, maxAttempts: options.maxAttempts },
    ) as EmbedResponse;
    if (body.dimensions !== 384 || !Array.isArray(body.embeddings)) return null;
    return body.embeddings;
  } catch (err) {
    console.warn("[knowledge-graph] embed failed", err instanceof Error ? err.message : String(err));
    return null;
  }
}

async function synthesizeGraphAnswer(
  user_id: string,
  question: string,
  traversals: KnowledgeGraphTraversalRow[],
): Promise<KnowledgeGraphSynthesis | null> {
  const baseUrl = resolveMlBaseUrl();
  const authorizationHeader = serviceAuthorizationHeader(user_id, LUMO_KG_SYNTHESIZE_TOOL);
  if (!baseUrl || !authorizationHeader || traversals.length === 0) return null;
  try {
    const sdk = createBrainSdk({
      user_id,
      baseUrl,
      timeoutMs: KG_SYNTHESIZE_TIMEOUT_MS,
      callerSurface: "knowledge-graph",
    });
    const body = await sdk.kgSynthesize(
      { question, traversal: traversals.slice(0, 30) },
      { authorizationHeader, timeoutMs: KG_SYNTHESIZE_TIMEOUT_MS },
    ) as KgSynthesizeResponse;
    if (!body || typeof body.answer !== "string") return null;
    return {
      answer: body.answer,
      citations: Array.isArray(body.citations) ? normalizeCitations(body.citations) : undefined,
    };
  } catch (err) {
    console.warn("[knowledge-graph] synthesize failed", err instanceof Error ? err.message : String(err));
    return null;
  }
}

function normalizeTraversalRows(rows: unknown[]): KnowledgeGraphTraversalRow[] {
  return rows.map((row) => {
    const r = row as Record<string, unknown>;
    return {
      node_id: String(r.node_id),
      label: String(r.label),
      properties: isRecord(r.properties) ? r.properties : {},
      depth: typeof r.depth === "number" ? r.depth : Number(r.depth ?? 0),
      score: typeof r.score === "number" ? r.score : Number(r.score ?? 0),
      path: Array.isArray(r.path) ? r.path.map(String) : [],
      edge_types: Array.isArray(r.edge_types) ? r.edge_types.map(String) : [],
      evidence: Array.isArray(r.evidence) ? normalizeEvidenceRows(r.evidence) : [],
    };
  });
}

function normalizeEvidenceRows(rows: unknown[]): KnowledgeGraphEvidence[] {
  return rows.map((row) => {
    const r = row as Record<string, unknown>;
    const kind = r.kind === "edge" ? "edge" : "node";
    return {
      kind,
      node_id: typeof r.node_id === "string" ? r.node_id : r.node_id ? String(r.node_id) : undefined,
      edge_id: typeof r.edge_id === "string" ? r.edge_id : r.edge_id ? String(r.edge_id) : undefined,
      label: typeof r.label === "string" ? r.label : undefined,
      edge_type: typeof r.edge_type === "string" ? r.edge_type : undefined,
      source_table: String(r.source_table ?? ""),
      source_row_id: String(r.source_row_id ?? ""),
      source_url: typeof r.source_url === "string" ? r.source_url : null,
      asserted_at: typeof r.asserted_at === "string" ? r.asserted_at : null,
      text: typeof r.text === "string" ? r.text : undefined,
    };
  });
}

function normalizeCitations(citations: KnowledgeGraphCitation[]): KnowledgeGraphCitation[] {
  return citations
    .filter((citation) => citation && citation.node_id && citation.source_table && citation.source_row_id)
    .map((citation) => ({
      node_id: String(citation.node_id),
      label: String(citation.label),
      source_table: String(citation.source_table),
      source_row_id: String(citation.source_row_id),
      source_url: citation.source_url ?? null,
      asserted_at: citation.asserted_at ?? null,
      text: String(citation.text ?? citation.label),
    }));
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

function edgeSeedKey(user_id: string, source_id: string, target_id: string, edge_type: string): string {
  return `${user_id}::${source_id}::${target_id}::${edge_type.toUpperCase()}`;
}

function resolveMlBaseUrl(): string {
  return (process.env.LUMO_ML_AGENT_URL ?? "").replace(/\/+$/, "");
}

function serviceAuthorizationHeader(user_id: string, scope: string): string | null {
  try {
    return `Bearer ${signLumoServiceJwt({
      audience: LUMO_ML_AGENT_ID,
      user_id,
      scope,
      request_id: `kg:${randomUUID()}`,
      ttl_seconds: 120,
    })}`;
  } catch {
    return null;
  }
}
