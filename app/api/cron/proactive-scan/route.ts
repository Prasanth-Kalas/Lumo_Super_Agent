/**
 * /api/cron/proactive-scan — Sprint 2 proactive intelligence scan.
 *
 * Every 30 minutes, scan recent user metrics for anomalies, persist
 * findings, and create bounded proactive moments. The cron also keeps
 * the legacy trip/token notification rules alive until their consumers
 * migrate to proactive_moments.
 */

import { type NextRequest, NextResponse } from "next/server";
import { detectMetricAnomalies, type MetricPointInput } from "@/lib/anomaly-detection";
import { forecastMetricForUser } from "@/lib/forecasting";
import { getSupabase } from "@/lib/db";
import { deliver } from "@/lib/notifications";
import { recordCronRun } from "@/lib/ops";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const ENDPOINT = "/api/cron/proactive-scan";
const MAX_METRIC_GROUPS = 200;
const MAX_POINTS_PER_GROUP = 720;
const USER_MOMENT_CAP = 3;

interface MetricRow {
  user_id: string;
  metric_key: string;
  ts: string;
  value: number;
  dimensions: Record<string, unknown> | null;
}

interface CalendarArchiveRow {
  user_id: string;
  agent_id: string | null;
  endpoint: string;
  response_body: unknown;
  fetched_at: string;
}

interface TripCalendarEvent {
  user_id: string;
  title: string;
  start_at: string;
  end_at: string | null;
  source_agent_id: string | null;
}

interface Counts extends Record<string, number> {
  disabled: number;
  metric_groups: number;
  metric_groups_scanned: number;
  anomaly_findings: number;
  proactive_moments: number;
  forecast_groups: number;
  trip_time_to_act_moments: number;
  trip_stuck: number;
  trip_rolled_back: number;
  token_expiring: number;
}

export async function GET(req: NextRequest) {
  const auth = authorizeCron(req);
  if (!auth.ok) {
    return NextResponse.json({ error: auth.error }, { status: auth.status });
  }

  const startedAt = new Date();
  const counts: Counts = {
    disabled: 0,
    metric_groups: 0,
    metric_groups_scanned: 0,
    anomaly_findings: 0,
    proactive_moments: 0,
    forecast_groups: 0,
    trip_time_to_act_moments: 0,
    trip_stuck: 0,
    trip_rolled_back: 0,
    token_expiring: 0,
  };
  const errors: string[] = [];

  if (process.env.LUMO_PROACTIVE_SCAN_ENABLED !== "true") {
    counts.disabled = 1;
    await recordCronRun({
      endpoint: ENDPOINT,
      started_at: startedAt,
      finished_at: new Date(),
      ok: true,
      counts,
      errors,
    });
    return NextResponse.json({
      ok: true,
      skipped: "disabled",
      message: "Set LUMO_PROACTIVE_SCAN_ENABLED=true to run proactive intelligence scans.",
      counts,
    });
  }

  const db = getSupabase();
  if (!db) {
    await recordCronRun({
      endpoint: ENDPOINT,
      started_at: startedAt,
      finished_at: new Date(),
      ok: true,
      counts: { ...counts, persistence_disabled: 1 },
      errors,
    });
    return NextResponse.json({ ok: true, skipped: "persistence_disabled", counts });
  }

  const momentBudget = new Map<string, number>();
  let metricGroups = new Map<string, MetricRow[]>();

  try {
    metricGroups = await loadMetricGroups(db);
    counts.metric_groups = metricGroups.size;
    for (const [key, rows] of metricGroups) {
      if (rows.length < 14) continue;
      counts.metric_groups_scanned++;
      const { user_id, metric_key } = splitMetricKey(key);
      const points = rowsToPoints(rows);
      const result = await detectMetricAnomalies({
        user_id,
        input: {
          metric_key,
          points,
          context: { expected_frequency: inferFrequency(points), min_points: 14 },
        },
        recordUsage: false,
      });

      for (const finding of result.findings) {
        const findingId = await persistAnomalyFinding(db, {
          user_id,
          metric_key,
          finding,
          model_version: result.model,
        });
        if (findingId) counts.anomaly_findings++;
        if (finding.confidence < 0.8 || !takeMomentBudget(momentBudget, user_id)) continue;
        const created = await createProactiveMoment(db, {
          user_id,
          moment_type: "anomaly_alert",
          title: anomalyTitle(metric_key, finding.finding_type),
          body: anomalyBody(metric_key, finding),
          urgency: urgencyForZ(finding.z_score),
          evidence: {
            dedup_key: `anomaly:${user_id}:${metric_key}:${finding.finding_type}:${finding.anomaly_ts}`,
            finding_id: findingId,
            metric_key,
            finding,
          },
        });
        if (created) counts.proactive_moments++;
      }
    }
  } catch (err) {
    errors.push(`metrics:${messageFor(err)}`);
  }

  try {
    const tripEvents = await loadTripCalendarEvents(db);
    const bookingPriceGroups = new Map(
      Array.from(metricGroups.entries())
        .filter(([key]) => key.endsWith("|travel.booking_price"))
        .map(([key, rows]) => [splitMetricKey(key).user_id, rows]),
    );
    for (const event of tripEvents) {
      const rows = bookingPriceGroups.get(event.user_id);
      if (!rows || rows.length < 14 || !takeMomentBudget(momentBudget, event.user_id)) continue;
      counts.forecast_groups++;
      const points = rowsToPoints(rows);
      const forecast = await forecastMetricForUser({
        user_id: event.user_id,
        input: {
          metric_key: "travel.booking_price",
          points,
          horizon_days: 14,
          context: { expected_frequency: inferFrequency(points) },
        },
        recordUsage: false,
      });
      const current = rows.at(-1)?.value ?? 0;
      const peak = Math.max(...forecast.forecast.map((point) => point.predicted_value), current);
      if (current <= 0 || peak < current * 1.05) continue;
      const created = await createProactiveMoment(db, {
        user_id: event.user_id,
        moment_type: "time_to_act",
        title: "Travel prices may rise soon",
        body: `${event.title} is coming up. Forecasted booking prices may rise from ${formatAmount(current)} to ${formatAmount(peak)} in the next two weeks.`,
        urgency: peak >= current * 1.15 ? "high" : "medium",
        evidence: {
          dedup_key: `time_to_act:${event.user_id}:${event.start_at}:${event.title}`,
          event,
          metric_key: "travel.booking_price",
          current,
          peak,
          forecast_source: forecast.source,
        },
      });
      if (created) {
        counts.proactive_moments++;
        counts.trip_time_to_act_moments++;
      }
    }
  } catch (err) {
    errors.push(`calendar_forecast:${messageFor(err)}`);
  }

  try {
    const legacy = await runLegacyNotificationRules(db);
    counts.trip_stuck = legacy.trip_stuck;
    counts.trip_rolled_back = legacy.trip_rolled_back;
    counts.token_expiring = legacy.token_expiring;
    errors.push(...legacy.errors);
  } catch (err) {
    errors.push(`legacy:${messageFor(err)}`);
  }

  const ok = errors.length === 0;
  await recordCronRun({
    endpoint: ENDPOINT,
    started_at: startedAt,
    finished_at: new Date(),
    ok,
    counts,
    errors: errors.slice(0, 20),
  });

  return NextResponse.json(
    {
      ok,
      counts,
      errors: errors.length ? errors.slice(0, 20) : undefined,
      latency_ms: Date.now() - startedAt.getTime(),
      ran_at: new Date().toISOString(),
    },
    { status: ok ? 200 : 500 },
  );
}

function authorizeCron(req: NextRequest):
  | { ok: true }
  | { ok: false; status: number; error: string } {
  const expected = process.env.CRON_SECRET ?? process.env.LUMO_CRON_SECRET;
  if (!expected) return { ok: false, status: 503, error: "cron_secret_missing" };
  const bearer = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
  const provided = bearer ?? req.headers.get("x-vercel-cron") ?? "";
  if (provided !== expected) return { ok: false, status: 401, error: "unauthorized" };
  return { ok: true };
}

async function loadMetricGroups(db: ReturnType<typeof getSupabase>): Promise<Map<string, MetricRow[]>> {
  if (!db) return new Map();
  const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  const { data, error } = await db
    .from("time_series_metrics")
    .select("user_id, metric_key, ts, value, dimensions")
    .gte("ts", since)
    .order("ts", { ascending: true })
    .limit(MAX_METRIC_GROUPS * MAX_POINTS_PER_GROUP);
  if (error) throw error;
  const groups = new Map<string, MetricRow[]>();
  for (const row of (data ?? []) as MetricRow[]) {
    const key = `${row.user_id}|${row.metric_key}`;
    const bucket = groups.get(key) ?? [];
    if (bucket.length < MAX_POINTS_PER_GROUP) bucket.push(row);
    groups.set(key, bucket);
  }
  return groups;
}

function splitMetricKey(key: string): { user_id: string; metric_key: string } {
  const separator = key.indexOf("|");
  return {
    user_id: key.slice(0, separator),
    metric_key: key.slice(separator + 1),
  };
}

function rowsToPoints(rows: MetricRow[]): MetricPointInput[] {
  return rows.map((row) => ({
    ts: row.ts,
    value: Number(row.value),
    dimensions: row.dimensions ?? {},
  }));
}

function inferFrequency(points: MetricPointInput[]): "daily" | "hourly" | "weekly" {
  if (points.length < 2) return "daily";
  const diffs = points
    .slice(1)
    .map((point, index) => Date.parse(point.ts) - Date.parse(points[index]!.ts))
    .filter((value) => Number.isFinite(value) && value > 0);
  const median = diffs.sort((a, b) => a - b)[Math.floor(diffs.length / 2)] ?? 86_400_000;
  if (median <= 2 * 60 * 60 * 1000) return "hourly";
  if (median >= 5 * 24 * 60 * 60 * 1000) return "weekly";
  return "daily";
}

async function persistAnomalyFinding(
  db: NonNullable<ReturnType<typeof getSupabase>>,
  args: {
    user_id: string;
    metric_key: string;
    finding: {
      finding_type: string;
      anomaly_ts: string;
      expected_value: number;
      actual_value: number;
      z_score: number;
      confidence: number;
    };
    model_version: string;
  },
): Promise<string | null> {
  const { data: existing } = await db
    .from("anomaly_findings")
    .select("id")
    .eq("user_id", args.user_id)
    .eq("metric_key", args.metric_key)
    .eq("finding_type", args.finding.finding_type)
    .eq("anomaly_ts", args.finding.anomaly_ts)
    .maybeSingle();
  if (existing?.id) return String(existing.id);

  const { data, error } = await db
    .from("anomaly_findings")
    .insert({
      user_id: args.user_id,
      metric_key: args.metric_key,
      finding_type: args.finding.finding_type,
      anomaly_ts: args.finding.anomaly_ts,
      expected_value: args.finding.expected_value,
      actual_value: args.finding.actual_value,
      z_score: args.finding.z_score,
      confidence: args.finding.confidence,
      model_version: args.model_version,
      evidence: { source: "proactive-scan" },
    })
    .select("id")
    .single();
  if (error) throw error;
  return data?.id ? String(data.id) : null;
}

async function createProactiveMoment(
  db: NonNullable<ReturnType<typeof getSupabase>>,
  args: {
    user_id: string;
    moment_type: "anomaly_alert" | "time_to_act";
    title: string;
    body: string;
    urgency: "low" | "medium" | "high";
    evidence: Record<string, unknown>;
  },
): Promise<boolean> {
  const dedup_key = String(args.evidence.dedup_key ?? "");
  if (dedup_key) {
    const { data: existing } = await db
      .from("proactive_moments")
      .select("id")
      .eq("user_id", args.user_id)
      .eq("moment_type", args.moment_type)
      .contains("evidence", { dedup_key })
      .in("status", ["pending", "surfaced"])
      .limit(1)
      .maybeSingle();
    if (existing?.id) return false;
  }
  const { error } = await db.from("proactive_moments").insert({
    user_id: args.user_id,
    moment_type: args.moment_type,
    title: args.title,
    body: args.body,
    urgency: args.urgency,
    evidence: args.evidence,
    valid_until: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
  });
  if (error) throw error;
  return true;
}

function takeMomentBudget(budget: Map<string, number>, user_id: string): boolean {
  const used = budget.get(user_id) ?? 0;
  if (used >= USER_MOMENT_CAP) return false;
  budget.set(user_id, used + 1);
  return true;
}

async function loadTripCalendarEvents(
  db: NonNullable<ReturnType<typeof getSupabase>>,
): Promise<TripCalendarEvent[]> {
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const { data, error } = await db
    .from("connector_responses_archive")
    .select("user_id, agent_id, endpoint, response_body, fetched_at")
    .eq("endpoint", "calendar.events.next3")
    .gte("fetched_at", since)
    .order("fetched_at", { ascending: false })
    .limit(500);
  if (error) throw error;
  const out: TripCalendarEvent[] = [];
  for (const row of (data ?? []) as CalendarArchiveRow[]) {
    out.push(...extractTripEvents(row));
  }
  return out;
}

function extractTripEvents(row: CalendarArchiveRow): TripCalendarEvent[] {
  const body = row.response_body;
  const rawEvents =
    body && typeof body === "object" && Array.isArray((body as { items?: unknown }).items)
      ? ((body as { items: unknown[] }).items)
      : body && typeof body === "object" && Array.isArray((body as { value?: unknown }).value)
        ? ((body as { value: unknown[] }).value)
        : [];
  return rawEvents.flatMap((raw) => normalizeTripEvent(row, raw));
}

function normalizeTripEvent(
  row: CalendarArchiveRow,
  raw: unknown,
): TripCalendarEvent[] {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return [];
  const item = raw as Record<string, unknown>;
  const title = stringValue(item.summary) || stringValue(item.subject);
  if (!title || !/\b(trip|vacation|travel)\b/i.test(title)) return [];
  const start_at = dateValue(item.start);
  if (!start_at) return [];
  const start = Date.parse(start_at);
  const now = Date.now();
  if (start < now + 7 * 24 * 60 * 60 * 1000 || start > now + 14 * 24 * 60 * 60 * 1000) {
    return [];
  }
  return [
    {
      user_id: row.user_id,
      title,
      start_at,
      end_at: dateValue(item.end),
      source_agent_id: row.agent_id,
    },
  ];
}

function dateValue(value: unknown): string | null {
  if (typeof value === "string" && Number.isFinite(Date.parse(value))) return value;
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const item = value as Record<string, unknown>;
  const candidate = stringValue(item.dateTime) || stringValue(item.date);
  if (!candidate || !Number.isFinite(Date.parse(candidate))) return null;
  return new Date(candidate).toISOString();
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

async function runLegacyNotificationRules(
  db: NonNullable<ReturnType<typeof getSupabase>>,
): Promise<{
  trip_stuck: number;
  trip_rolled_back: number;
  token_expiring: number;
  errors: string[];
}> {
  let trip_stuck = 0;
  let trip_rolled_back = 0;
  let token_expiring = 0;
  const errors: string[] = [];

  try {
    const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    const { data, error } = await db
      .from("trips")
      .select("trip_id, user_id, updated_at, payload")
      .eq("status", "dispatching")
      .lt("updated_at", fiveMinAgo)
      .limit(200);
    if (error) throw error;
    for (const row of data ?? []) {
      const n = await deliver({
        user_id: String((row as { user_id?: string }).user_id),
        kind: "trip_stuck",
        title: "A trip is taking longer than expected",
        body: "Lumo started booking your trip but hasn't finished. Tap to cancel or retry.",
        payload: { trip_id: (row as { trip_id?: string }).trip_id },
        dedup_key: `trip_stuck:${(row as { trip_id?: string }).trip_id}`,
        expires_at: new Date(Date.now() + 6 * 60 * 60 * 1000),
      });
      if (n) trip_stuck++;
    }
  } catch (err) {
    errors.push(`R1:${messageFor(err)}`);
  }

  try {
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const { data, error } = await db
      .from("trips")
      .select("trip_id, user_id, updated_at, payload")
      .eq("status", "rolled_back")
      .gt("updated_at", oneHourAgo)
      .limit(200);
    if (error) throw error;
    for (const row of data ?? []) {
      const n = await deliver({
        user_id: String((row as { user_id?: string }).user_id),
        kind: "trip_rolled_back",
        title: "Your trip was rolled back",
        body: "One leg failed so Lumo undid the rest automatically. No charges held.",
        payload: { trip_id: (row as { trip_id?: string }).trip_id },
        dedup_key: `trip_rolled_back:${(row as { trip_id?: string }).trip_id}`,
        expires_at: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000),
      });
      if (n) trip_rolled_back++;
    }
  } catch (err) {
    errors.push(`R2:${messageFor(err)}`);
  }

  try {
    const in24h = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    const { data, error } = await db
      .from("agent_connections")
      .select("id, user_id, agent_id, expires_at")
      .eq("status", "active")
      .not("expires_at", "is", null)
      .lt("expires_at", in24h)
      .gt("expires_at", new Date().toISOString())
      .limit(500);
    if (error) throw error;
    for (const row of data ?? []) {
      const id = String((row as { id?: string }).id);
      const agent_id = String((row as { agent_id?: string }).agent_id);
      const user_id = String((row as { user_id?: string }).user_id);
      const exp = (row as { expires_at?: string }).expires_at;
      const n = await deliver({
        user_id,
        kind: "token_expiring",
        title: `Reconnect ${agent_id} soon`,
        body: `Your connection to ${agent_id} expires within a day. Reconnect to keep using it.`,
        payload: { connection_id: id, agent_id },
        dedup_key: `token_expiring:${id}`,
        expires_at: exp ? new Date(exp) : null,
      });
      if (n) token_expiring++;
    }
  } catch (err) {
    errors.push(`R3:${messageFor(err)}`);
  }

  return { trip_stuck, trip_rolled_back, token_expiring, errors };
}

function anomalyTitle(metric_key: string, findingType: string): string {
  const label = metricLabel(metric_key);
  if (findingType === "drop") return `${label} dropped unexpectedly`;
  if (findingType === "spike") return `${label} spiked unexpectedly`;
  return `${label} changed unexpectedly`;
}

function anomalyBody(
  metric_key: string,
  finding: { expected_value: number; actual_value: number; confidence: number },
): string {
  return `${metricLabel(metric_key)} came in at ${formatAmount(finding.actual_value)} vs an expected ${formatAmount(finding.expected_value)} (${Math.round(finding.confidence * 100)}% confidence).`;
}

function metricLabel(metric_key: string): string {
  if (metric_key === "stripe.revenue") return "Stripe revenue";
  if (metric_key === "travel.booking_price") return "Travel pricing";
  if (metric_key === "content.views") return "Content views";
  return metric_key.replace(/[._-]+/g, " ");
}

function urgencyForZ(zScore: number): "low" | "medium" | "high" {
  const magnitude = Math.abs(zScore);
  if (magnitude >= 5) return "high";
  if (magnitude >= 3.5) return "medium";
  return "low";
}

function formatAmount(value: number): string {
  return Number.isFinite(value)
    ? value.toLocaleString("en-US", { maximumFractionDigits: 2 })
    : "0";
}

function messageFor(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
