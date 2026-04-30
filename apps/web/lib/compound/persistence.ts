import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  replayCompoundTransaction,
  type CompoundLegSnapshot,
  type CompoundLegStatus,
  type CompoundReplayPlan,
  type CompoundTransactionReplaySnapshot,
} from "../saga.ts";
import {
  legStatusFrameFromRow,
  type LegStatusEventRow,
  type LegStatusFrameV2,
} from "../sse/leg-status.ts";

export const COMPOUND_TERMINAL_STATUSES = [
  "committed",
  "rolled_back",
  "failed",
  "cancelled",
] as const;

export type CompoundTerminalStatus = typeof COMPOUND_TERMINAL_STATUSES[number];

export const COMPOUND_EDGE_TYPES = [
  "requires_arrival_time",
  "requires_destination",
  "requires_payment_authorization",
  "requires_user_confirmation",
  "requires_provider_reference",
  "custom",
] as const;

export type CompoundEdgeType = typeof COMPOUND_EDGE_TYPES[number];

export const MERCHANT_PROVIDERS = [
  "duffel",
  "booking",
  "expedia_partner_solutions",
  "uber_for_business",
  "stripe_issuing",
  "stripe_payments",
  "mock_merchant",
] as const;

export type MerchantProvider = typeof MERCHANT_PROVIDERS[number];

export interface CompoundGraphLegInput {
  client_leg_id: string;
  agent_id: string;
  agent_version: string;
  provider: MerchantProvider;
  capability_id: string;
  compensation_capability_id: string | null;
  amount_cents: number;
  currency: string;
  line_items: unknown[];
  idempotency_key: string | null;
  step_order: number;
  depends_on: string[];
  depends_on_orders: number[];
  compensation_kind: "perfect" | "best-effort" | "manual";
  failure_policy: "rollback" | "manual_review";
}

export interface CompoundGraphDependencyInput {
  dependency_client_leg_id: string;
  dependent_client_leg_id: string;
  edge_type: CompoundEdgeType;
  evidence: Record<string, unknown>;
}

export interface CompoundCreateInput {
  mission_id: string | null;
  session_id: string | null;
  idempotency_key: string;
  currency: string;
  line_items: unknown[];
  confirmation_digest: string | null;
  failure_policy: "rollback" | "manual_review";
  legs: CompoundGraphLegInput[];
  dependencies: CompoundGraphDependencyInput[];
  graph_hash: string;
  replay_plan: CompoundReplayPlan;
  authorized_amount_cents: number;
}

export interface CompoundCreateResult {
  compound_transaction_id: string;
  status: CompoundTransactionReplaySnapshot["status"];
  graph_hash: string;
  existing: boolean;
}

export interface LegStatusEventRecord extends LegStatusEventRow {
  id: number;
  compound_transaction_id: string;
}

export class CompoundPersistenceError extends Error {
  readonly code: string;
  readonly status: number;
  readonly details: Record<string, unknown> | undefined;

  constructor(
    code: string,
    status = 400,
    message = code,
    details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "CompoundPersistenceError";
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

export function normalizeCompoundCreatePayload(raw: unknown): CompoundCreateInput {
  if (!isRecord(raw)) throw new CompoundPersistenceError("invalid_body", 400);

  const currency = normalizeCurrency(raw.currency);
  const lineItems = normalizeLineItems(raw.line_items);
  const confirmationDigest = optionalHexDigest(raw.confirmation_digest, "confirmation_digest");
  const failurePolicy = normalizeFailurePolicy(raw.failure_policy);
  const idempotencyKey = requiredString(raw.idempotency_key, "idempotency_key", 240);
  const legsRaw = Array.isArray(raw.legs) ? raw.legs : null;
  if (!legsRaw || legsRaw.length === 0) {
    throw new CompoundPersistenceError("invalid_legs", 400);
  }

  const dependencies = normalizeDependencies(raw.dependencies);
  const dependencyMap = new Map<string, Set<string>>();
  for (const dependency of dependencies) {
    const list = dependencyMap.get(dependency.dependent_client_leg_id) ?? new Set<string>();
    list.add(dependency.dependency_client_leg_id);
    dependencyMap.set(dependency.dependent_client_leg_id, list);
  }

  const seenLegIds = new Set<string>();
  const legs = legsRaw.map((legRaw, index) => {
    if (!isRecord(legRaw)) throw new CompoundPersistenceError("invalid_leg", 400);
    const clientLegId = requiredString(legRaw.client_leg_id, "client_leg_id", 120);
    if (seenLegIds.has(clientLegId)) {
      throw new CompoundPersistenceError("duplicate_leg_id", 400);
    }
    seenLegIds.add(clientLegId);
    const explicitDependsOn = stringArray(legRaw.depends_on, "depends_on");
    const dependsOn = Array.from(new Set([
      ...explicitDependsOn,
      ...(dependencyMap.get(clientLegId) ? Array.from(dependencyMap.get(clientLegId)!) : []),
    ])).sort();
    const legLineItems = Array.isArray(legRaw.line_items)
      ? normalizeLineItems(legRaw.line_items)
      : lineItems;
    const amount = optionalNonNegativeInt(legRaw.amount_cents) ?? totalLineItems(legLineItems);
    return {
      client_leg_id: clientLegId,
      agent_id: requiredString(legRaw.agent_id, "agent_id", 120),
      agent_version: optionalString(legRaw.agent_version, 80) ?? "1.0.0",
      provider: normalizeProvider(legRaw.provider),
      capability_id: requiredString(legRaw.capability_id, "capability_id", 120),
      compensation_capability_id: optionalString(legRaw.compensation_capability_id, 120),
      amount_cents: amount,
      currency: normalizeCurrency(legRaw.currency ?? currency),
      line_items: legLineItems,
      idempotency_key: optionalString(legRaw.idempotency_key, 240),
      step_order: optionalNonNegativeInt(legRaw.step_order) ?? index + 1,
      depends_on: dependsOn,
      depends_on_orders: [],
      compensation_kind: normalizeCompensationKind(legRaw.compensation_kind),
      failure_policy: normalizeFailurePolicy(legRaw.failure_policy ?? failurePolicy),
    } satisfies CompoundGraphLegInput;
  });

  for (const dependency of dependencies) {
    if (!seenLegIds.has(dependency.dependency_client_leg_id) || !seenLegIds.has(dependency.dependent_client_leg_id)) {
      throw new CompoundPersistenceError("missing_dependency", 400);
    }
  }
  for (const leg of legs) {
    for (const dependency of leg.depends_on) {
      if (!seenLegIds.has(dependency)) {
        throw new CompoundPersistenceError("missing_dependency", 400);
      }
    }
  }

  const orderByClientId = new Map(legs.map((leg) => [leg.client_leg_id, leg.step_order]));
  const withDependencyOrders = legs.map((leg) => ({
    ...leg,
    depends_on_orders: leg.depends_on
      .map((dependency) => orderByClientId.get(dependency))
      .filter((order): order is number => typeof order === "number")
      .sort((a, b) => a - b),
  }));

  const normalizedForHash = {
    currency,
    failure_policy: failurePolicy,
    confirmation_digest: confirmationDigest,
    line_items: lineItems,
    legs: withDependencyOrders.map((leg) => ({
      client_leg_id: leg.client_leg_id,
      agent_id: leg.agent_id,
      agent_version: leg.agent_version,
      provider: leg.provider,
      capability_id: leg.capability_id,
      compensation_capability_id: leg.compensation_capability_id,
      amount_cents: leg.amount_cents,
      currency: leg.currency,
      line_items: leg.line_items,
      step_order: leg.step_order,
      depends_on: leg.depends_on,
      compensation_kind: leg.compensation_kind,
      failure_policy: leg.failure_policy,
    })),
    dependencies,
  };
  const graphHash = sha256Hex(stableStringify(normalizedForHash));
  const replayPlan = replayCompoundTransaction(
    buildCompoundReplaySnapshot({
      compound_transaction_id: `request:${graphHash}`,
      status: confirmationDigest ? "authorized" : "awaiting_confirmation",
      failure_policy: failurePolicy,
      legs: withDependencyOrders,
    }),
  );

  if (!replayPlan.graph_valid) {
    throw new CompoundPersistenceError(replayPlan.graph_error ?? "invalid_compound_graph", 400);
  }

  return {
    mission_id: optionalString(raw.mission_id, 80),
    session_id: optionalString(raw.session_id, 200),
    idempotency_key: idempotencyKey,
    currency,
    line_items: lineItems,
    confirmation_digest: confirmationDigest,
    failure_policy: failurePolicy,
    legs: withDependencyOrders,
    dependencies,
    graph_hash: graphHash,
    replay_plan: replayPlan,
    authorized_amount_cents: withDependencyOrders.reduce((sum, leg) => sum + leg.amount_cents, 0),
  };
}

export function buildCompoundReplaySnapshot(input: {
  compound_transaction_id: string;
  status: CompoundTransactionReplaySnapshot["status"];
  failure_policy: "rollback" | "manual_review";
  legs: CompoundGraphLegInput[];
}): CompoundTransactionReplaySnapshot {
  return {
    compound_transaction_id: input.compound_transaction_id,
    status: input.status,
    failure_policy: input.failure_policy,
    legs: input.legs.map((leg): CompoundLegSnapshot => ({
      leg_id: leg.client_leg_id,
      transaction_id: `request:${leg.client_leg_id}`,
      order: leg.step_order,
      agent_id: leg.agent_id,
      capability_id: leg.capability_id,
      compensation_capability_id: leg.compensation_capability_id,
      depends_on: leg.depends_on,
      status: "pending",
      compensation_kind: leg.compensation_kind,
      failure_policy: leg.failure_policy,
    })),
  };
}

export async function createCompoundTransaction(input: {
  db: SupabaseClient;
  userId: string;
  payload: unknown;
}): Promise<CompoundCreateResult> {
  const normalized = normalizeCompoundCreatePayload(input.payload);
  const status: CompoundTransactionReplaySnapshot["status"] =
    normalized.confirmation_digest ? "authorized" : "awaiting_confirmation";
  const rpcPayload = {
    user_id: input.userId,
    mission_id: normalized.mission_id,
    session_id: normalized.session_id,
    idempotency_key: normalized.idempotency_key,
    graph_hash: normalized.graph_hash,
    confirmation_digest: normalized.confirmation_digest,
    currency: normalized.currency,
    failure_policy: normalized.failure_policy,
    status,
    line_items: normalized.line_items,
    authorized_amount_cents: normalized.authorized_amount_cents,
    current_replay_hash: normalized.replay_plan.replay_hash,
    legs: normalized.legs,
    dependencies: normalized.dependencies,
  };
  const { data, error } = await input.db.rpc("create_compound_transaction_from_graph", {
    payload: rpcPayload,
  });
  if (error) {
    const conflict = parseIdempotencyConflict(error);
    if (conflict) {
      throw new CompoundPersistenceError(
        "idempotency_key_conflict",
        409,
        "idempotency key already belongs to a different compound graph",
        { existing_compound_id: conflict.existing_compound_id },
      );
    }
    throw new CompoundPersistenceError("compound_persist_failed", 500, error.message);
  }
  return parseCreateResult(data);
}

function parseIdempotencyConflict(error: {
  message?: string | null;
  hint?: string | null;
}): { existing_compound_id: string } | null {
  if (error.message !== "INVALID_COMPOUND_GRAPH_HASH_CONFLICT") return null;
  const match = /(?:^|\b)existing_compound_id=([0-9a-f-]{36})(?:\b|$)/i.exec(error.hint ?? "");
  const existingCompoundId = match?.[1] ?? "";
  return { existing_compound_id: existingCompoundId };
}

export async function loadCompoundSnapshot(
  db: SupabaseClient,
  compoundId: string,
): Promise<CompoundTransactionReplaySnapshot> {
  const compound = await readCompoundRow(db, compoundId);
  if (!compound) {
    throw new CompoundPersistenceError("compound_not_found", 404);
  }
  return shapeCompoundSnapshot(db, compound);
}

export async function loadCompoundSnapshotForUser(
  db: SupabaseClient,
  compoundId: string,
  userId: string,
): Promise<CompoundTransactionReplaySnapshot | null> {
  const compound = await readCompoundRow(db, compoundId, userId);
  if (!compound) return null;
  return shapeCompoundSnapshot(db, compound);
}

export async function readCompoundStatusForUser(
  db: SupabaseClient,
  compoundId: string,
  userId: string,
): Promise<CompoundTransactionReplaySnapshot["status"] | null> {
  const compound = await readCompoundRow(db, compoundId, userId);
  return compound?.status ?? null;
}

export async function loadLegStatusEvents(
  db: SupabaseClient,
  compoundId: string,
  afterId = 0,
): Promise<LegStatusEventRecord[]> {
  let query = db
    .from("leg_status_events")
    .select("id, compound_transaction_id, transaction_id, leg_id, agent_id, capability_id, status, provider_reference, evidence, occurred_at, created_at")
    .eq("compound_transaction_id", compoundId);
  if (afterId > 0) query = query.gt("id", afterId);
  const { data, error } = await query
    .order("occurred_at", { ascending: true })
    .order("id", { ascending: true });
  if (error) {
    throw new CompoundPersistenceError("leg_status_events_read_failed", 500, error.message);
  }
  return ((data ?? []) as unknown[]).map(asLegStatusEventRecord);
}

export function legStatusFramesFromEvents(rows: LegStatusEventRecord[]): LegStatusFrameV2[] {
  return rows.map((row) => legStatusFrameFromRow(row));
}

export function isTerminalCompoundStatus(
  status: string | null | undefined,
): status is CompoundTerminalStatus {
  return COMPOUND_TERMINAL_STATUSES.includes(status as CompoundTerminalStatus);
}

export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
    .join(",")}}`;
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

interface CompoundRow {
  id: string;
  status: CompoundTransactionReplaySnapshot["status"];
  failure_policy: "rollback" | "manual_review";
}

interface TransactionRow {
  id: string;
  agent_id: string;
  capability_id: string | null;
  status: string;
}

interface TransactionLegRow {
  id: string;
  transaction_id: string;
  step_order: number;
  capability_id: string;
  compensation_capability_id: string | null;
  status: string;
  provider_reference: string | null;
  evidence: unknown;
}

interface DependencyRow {
  dependency_leg_id: string;
  dependent_leg_id: string;
}

async function readCompoundRow(
  db: SupabaseClient,
  compoundId: string,
  userId?: string,
): Promise<CompoundRow | null> {
  let query = db
    .from("compound_transactions")
    .select("id, status, failure_policy")
    .eq("id", compoundId);
  if (userId) query = query.eq("user_id", userId);
  const { data, error } = await query.maybeSingle();
  if (error) {
    throw new CompoundPersistenceError("compound_read_failed", 500, error.message);
  }
  return (data as CompoundRow | null) ?? null;
}

async function shapeCompoundSnapshot(
  db: SupabaseClient,
  compound: CompoundRow,
): Promise<CompoundTransactionReplaySnapshot> {
  const { data: transactions, error: txError } = await db
    .from("transactions")
    .select("id, agent_id, capability_id, status")
    .eq("compound_transaction_id", compound.id)
    .order("created_at", { ascending: true });
  if (txError) {
    throw new CompoundPersistenceError("transactions_read_failed", 500, txError.message);
  }
  const txRows = (transactions ?? []) as TransactionRow[];
  const txById = new Map(txRows.map((row) => [row.id, row]));
  const txIds = txRows.map((row) => row.id);
  if (txIds.length === 0) {
    return {
      compound_transaction_id: compound.id,
      status: compound.status,
      failure_policy: compound.failure_policy,
      legs: [],
    };
  }

  const [{ data: legs, error: legsError }, { data: dependencies, error: depsError }, events] =
    await Promise.all([
      db
        .from("transaction_legs")
        .select("id, transaction_id, step_order, capability_id, compensation_capability_id, status, provider_reference, evidence")
        .in("transaction_id", txIds)
        .order("step_order", { ascending: true }),
      db
        .from("compound_transaction_dependencies")
        .select("dependency_leg_id, dependent_leg_id")
        .eq("compound_transaction_id", compound.id),
      loadLegStatusEvents(db, compound.id),
    ]);
  if (legsError) {
    throw new CompoundPersistenceError("transaction_legs_read_failed", 500, legsError.message);
  }
  if (depsError) {
    throw new CompoundPersistenceError("compound_dependencies_read_failed", 500, depsError.message);
  }

  const depsByDependent = new Map<string, string[]>();
  for (const dependency of (dependencies ?? []) as DependencyRow[]) {
    const list = depsByDependent.get(dependency.dependent_leg_id) ?? [];
    list.push(dependency.dependency_leg_id);
    depsByDependent.set(dependency.dependent_leg_id, list);
  }
  for (const list of depsByDependent.values()) list.sort();

  const latestEventByLeg = new Map<string, LegStatusEventRecord>();
  for (const event of events) {
    latestEventByLeg.set(event.leg_id, event);
  }

  const snapshotLegs = ((legs ?? []) as TransactionLegRow[])
    .map((leg): CompoundLegSnapshot => {
      const transaction = txById.get(leg.transaction_id);
      const latestEvent = latestEventByLeg.get(leg.id);
      const evidence = isRecord(leg.evidence) ? leg.evidence : {};
      return {
        leg_id: leg.id,
        transaction_id: leg.transaction_id,
        order: leg.step_order,
        agent_id: transaction?.agent_id ?? "unknown",
        capability_id: leg.capability_id ?? transaction?.capability_id ?? "unknown",
        compensation_capability_id: leg.compensation_capability_id,
        depends_on: depsByDependent.get(leg.id) ?? [],
        status: normalizeLegStatus(latestEvent?.status ?? leg.status),
        provider_reference: latestEvent?.provider_reference ?? leg.provider_reference ?? null,
        compensation_kind: normalizeCompensationKind(evidence.compensation_kind),
        failure_policy: normalizeFailurePolicy(evidence.failure_policy ?? compound.failure_policy),
      };
    })
    .sort((a, b) => {
      if (a.order !== b.order) return a.order - b.order;
      return a.leg_id.localeCompare(b.leg_id);
    });

  return {
    compound_transaction_id: compound.id,
    status: compound.status,
    failure_policy: compound.failure_policy,
    legs: snapshotLegs,
  };
}

function parseCreateResult(data: unknown): CompoundCreateResult {
  const row = Array.isArray(data) ? data[0] : data;
  if (!isRecord(row)) {
    throw new CompoundPersistenceError("compound_persist_invalid_response", 500);
  }
  return {
    compound_transaction_id: requiredString(row.compound_transaction_id, "compound_transaction_id", 80),
    status: normalizeCompoundStatus(row.status),
    graph_hash: requiredString(row.graph_hash, "graph_hash", 64),
    existing: row.existing === true,
  };
}

function normalizeDependencies(raw: unknown): CompoundGraphDependencyInput[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw new CompoundPersistenceError("invalid_dependencies", 400);
  return raw.map((value) => {
    if (!isRecord(value)) throw new CompoundPersistenceError("invalid_dependency", 400);
    const dependency = requiredString(value.dependency_client_leg_id, "dependency_client_leg_id", 120);
    const dependent = requiredString(value.dependent_client_leg_id, "dependent_client_leg_id", 120);
    if (dependency === dependent) throw new CompoundPersistenceError("self_dependency", 400);
    return {
      dependency_client_leg_id: dependency,
      dependent_client_leg_id: dependent,
      edge_type: normalizeEdgeType(value.edge_type),
      evidence: isRecord(value.evidence) ? value.evidence : {},
    };
  });
}

function normalizeLineItems(raw: unknown): unknown[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw new CompoundPersistenceError("invalid_line_items", 400);
  return raw.map((item) => (isRecord(item) ? item : { value: item }));
}

function totalLineItems(items: unknown[]): number {
  return items.reduce<number>((sum, item) => {
    if (!isRecord(item)) return sum;
    const amount = optionalNonNegativeInt(item.amountCents ?? item.amount_cents);
    return sum + (amount ?? 0);
  }, 0);
}

function normalizeProvider(raw: unknown): MerchantProvider {
  const value = requiredString(raw, "provider", 120);
  if (!MERCHANT_PROVIDERS.includes(value as MerchantProvider)) {
    throw new CompoundPersistenceError("invalid_provider", 400);
  }
  return value as MerchantProvider;
}

function normalizeEdgeType(raw: unknown): CompoundEdgeType {
  const value = optionalString(raw, 80) ?? "custom";
  if (!COMPOUND_EDGE_TYPES.includes(value as CompoundEdgeType)) {
    throw new CompoundPersistenceError("invalid_edge_type", 400);
  }
  return value as CompoundEdgeType;
}

function normalizeCompensationKind(raw: unknown): "perfect" | "best-effort" | "manual" {
  if (raw === "perfect" || raw === "best-effort" || raw === "manual") return raw;
  return "best-effort";
}

function normalizeFailurePolicy(raw: unknown): "rollback" | "manual_review" {
  if (raw === "manual_review") return "manual_review";
  return "rollback";
}

function normalizeLegStatus(raw: unknown): CompoundLegStatus {
  const value = typeof raw === "string" ? raw : "pending";
  if (
    value === "pending" ||
    value === "awaiting_confirmation" ||
    value === "authorized" ||
    value === "in_flight" ||
    value === "committed" ||
    value === "failed" ||
    value === "rollback_pending" ||
    value === "rollback_in_flight" ||
    value === "rolled_back" ||
    value === "rollback_failed" ||
    value === "manual_review" ||
    value === "skipped"
  ) {
    return value;
  }
  return "manual_review";
}

function normalizeCompoundStatus(raw: unknown): CompoundTransactionReplaySnapshot["status"] {
  const value = typeof raw === "string" ? raw : "draft";
  if (
    value === "draft" ||
    value === "awaiting_confirmation" ||
    value === "authorized" ||
    value === "executing" ||
    value === "partially_committed" ||
    value === "committed" ||
    value === "rolling_back" ||
    value === "rolled_back" ||
    value === "rollback_failed" ||
    value === "failed" ||
    value === "manual_review" ||
    value === "cancelled"
  ) {
    return value;
  }
  return "manual_review";
}

function normalizeCurrency(raw: unknown): string {
  const value = optionalString(raw, 3)?.toUpperCase() ?? "USD";
  if (!/^[A-Z]{3}$/.test(value)) throw new CompoundPersistenceError("invalid_currency", 400);
  return value;
}

function optionalHexDigest(raw: unknown, field: string): string | null {
  const value = optionalString(raw, 64);
  if (!value) return null;
  if (!/^[a-f0-9]{64}$/i.test(value)) throw new CompoundPersistenceError(`invalid_${field}`, 400);
  return value.toLowerCase();
}

function stringArray(raw: unknown, field: string): string[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw new CompoundPersistenceError(`invalid_${field}`, 400);
  return raw.map((value) => requiredString(value, field, 120));
}

function optionalString(raw: unknown, maxLength: number): string | null {
  if (typeof raw !== "string") return null;
  const value = raw.trim();
  if (!value) return null;
  return value.slice(0, maxLength);
}

function requiredString(raw: unknown, field: string, maxLength: number): string {
  const value = optionalString(raw, maxLength);
  if (!value) throw new CompoundPersistenceError(`missing_${field}`, 400);
  if (/\s/.test(value)) throw new CompoundPersistenceError(`invalid_${field}`, 400);
  return value;
}

function optionalNonNegativeInt(raw: unknown): number | null {
  const value = Number(raw);
  if (!Number.isFinite(value)) return null;
  const integer = Math.trunc(value);
  if (integer < 0) throw new CompoundPersistenceError("invalid_amount", 400);
  return integer;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asLegStatusEventRecord(value: unknown): LegStatusEventRecord {
  if (!isRecord(value)) throw new CompoundPersistenceError("invalid_leg_status_event", 500);
  return {
    id: Number(value.id ?? 0),
    compound_transaction_id: String(value.compound_transaction_id ?? ""),
    transaction_id: String(value.transaction_id ?? ""),
    leg_id: String(value.leg_id ?? ""),
    agent_id: String(value.agent_id ?? ""),
    capability_id: String(value.capability_id ?? ""),
    status: String(value.status ?? "pending"),
    provider_reference: typeof value.provider_reference === "string" ? value.provider_reference : null,
    evidence: value.evidence,
    occurred_at: typeof value.occurred_at === "string" ? value.occurred_at : null,
    created_at: typeof value.created_at === "string" ? value.created_at : null,
  };
}
