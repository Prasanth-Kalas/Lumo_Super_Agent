/**
 * PLAN-CLIENT-TS-PARALLEL-WRITE-1 regression suite.
 *
 * Run: node --experimental-strip-types tests/plan-client-parallel-write.test.mjs
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { callPlan } from "../lib/lumo-ml/plan-client.ts";
import {
  buildPlanCompareInsertRow,
  buildPlanRequest,
} from "../lib/lumo-ml/plan-compare.ts";

let pass = 0;
let fail = 0;
const t = async (name, fn) => {
  try {
    await fn();
    pass++;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    fail++;
    console.log(`  ✗ ${name}\n    ${error.stack ?? error.message}`);
  }
};

console.log("\nplan client parallel write");

const oldSecret = process.env.LUMO_ML_SERVICE_JWT_SECRET;
const oldMlUrl = process.env.LUMO_ML_AGENT_URL;
const migration054 = readFileSync(
  "../../db/migrations/054_agent_plan_compare.sql",
  "utf8",
);
const orchestratorSource = readFileSync("lib/orchestrator.ts", "utf8");

const baseReq = {
  user_message: "look up a flight to Vegas from Chicago next week",
  session_id: "sess_test",
  user_id: "00000000-0000-0000-0000-000000000001",
  history: [
    { role: "user", content: "look up a flight to Vegas from Chicago next week" },
  ],
  approvals: [],
  planning_step_hint: null,
};

await t("callPlan returns ok:true with latency and stub header detection", async () => {
  process.env.LUMO_ML_SERVICE_JWT_SECRET = "test-secret";
  let now = 1_000;
  const result = await callPlan(baseReq, {
    mlBaseUrl: "https://ml.example.test/",
    nowMs: () => {
      now += 25;
      return now;
    },
    fetchImpl: async (url, init) => {
      assert.equal(String(url), "https://ml.example.test/api/tools/plan");
      assert.match(String(init?.headers?.authorization), /^Bearer /);
      assert.equal(init?.headers?.["content-type"], "application/json");
      assert.equal(JSON.parse(String(init?.body)).session_id, "sess_test");
      return Response.json(
        {
          intent_bucket: "tool_path",
          planning_step: "clarification",
          suggestions: [],
          system_prompt_addendum: null,
          compound_graph: null,
          profile_summary_hints: null,
        },
        { headers: { "X-Lumo-Plan-Stub": "1" } },
      );
    },
  });
  assert.equal(result.ok, true);
  assert.equal(result.was_stub, true);
  assert.equal(result.response.intent_bucket, "tool_path");
  assert.ok(result.latency_ms >= 0);
});

await t("callPlan times out without throwing", async () => {
  process.env.LUMO_ML_SERVICE_JWT_SECRET = "test-secret";
  const result = await callPlan(baseReq, {
    mlBaseUrl: "https://ml.example.test",
    timeout_ms: 1,
    fetchImpl: (_url, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          const error = new Error("aborted");
          error.name = "AbortError";
          reject(error);
        });
      }),
  });
  assert.deepEqual(
    { ok: result.ok, error: result.ok ? null : result.error },
    { ok: false, error: "timeout" },
  );
});

await t("callPlan maps HTTP failures and JWT failures to ok:false", async () => {
  process.env.LUMO_ML_SERVICE_JWT_SECRET = "test-secret";
  const unauthorized = await callPlan(baseReq, {
    mlBaseUrl: "https://ml.example.test",
    fetchImpl: async () => new Response("nope", { status: 401 }),
  });
  assert.equal(unauthorized.ok, false);
  assert.equal(unauthorized.error, "http_401");

  delete process.env.LUMO_ML_SERVICE_JWT_SECRET;
  const jwtFailure = await callPlan(baseReq, {
    mlBaseUrl: "https://ml.example.test",
    fetchImpl: async () => {
      throw new Error("should not fetch when JWT cannot be signed");
    },
  });
  assert.equal(jwtFailure.ok, false);
  assert.equal(jwtFailure.error, "service_jwt_not_configured");
});

await t("migration 054 declares schema, RLS, service-role grants, and append-only trigger", () => {
  assert.match(migration054, /create table if not exists public\.agent_plan_compare/);
  for (const column of [
    "session_id",
    "turn_id",
    "ts_intent_bucket",
    "py_intent_bucket",
    "agreement_bucket",
    "py_was_stub",
    "py_error",
  ]) {
    assert.match(migration054, new RegExp(`\\b${column}\\b`));
  }
  assert.match(migration054, /alter table public\.agent_plan_compare enable row level security/);
  assert.match(migration054, /revoke all on public\.agent_plan_compare from anon, authenticated/);
  assert.match(migration054, /grant select, insert, delete on public\.agent_plan_compare to service_role/);
  assert.match(migration054, /AGENT_PLAN_COMPARE_APPEND_ONLY/);
});

await t("buildPlanRequest carries bounded history and session approvals", () => {
  const request = buildPlanRequest({
    input: {
      session_id: "sess_req",
      user_id: "user_1",
      user_region: "US",
      device_kind: "web",
      user_pii: {},
      messages: [
        { role: "assistant", content: "x".repeat(2500) },
        { role: "user", content: "book a flight" },
      ],
    },
    approvals: [
      {
        user_id: "user_1",
        session_id: "sess_req",
        agent_id: "lumo-flights",
        granted_scopes: ["name", "payment_method_id"],
        approved_at: "2026-05-02T00:00:00.000Z",
        connected_at: "2026-05-02T00:00:01.000Z",
        connection_provider: "duffel",
      },
    ],
    planningStepHint: "selection",
  });
  assert.equal(request.user_message, "book a flight");
  assert.equal(request.history?.[0]?.content.length, 2000);
  assert.equal(request.approvals?.[0]?.agent_id, "lumo-flights");
  assert.equal(request.planning_step_hint, "selection");
});

await t("comparison row preserves TS authority and records Python error/stub outcomes", () => {
  const okRow = buildPlanCompareInsertRow({
    planPromise: Promise.resolve({ ok: false, error: "unused", latency_ms: 0 }),
    sessionId: "sess row",
    turnId: "turn row",
    userId: "00000000-0000-0000-0000-000000000001",
    tsIntentBucket: "tool_path",
    tsPlanningStep: "selection",
    tsLatencyMs: 42,
    pyResult: {
      ok: true,
      latency_ms: 103,
      was_stub: true,
      response: {
        intent_bucket: "tool_path",
        planning_step: "clarification",
        suggestions: [],
        system_prompt_addendum: null,
        compound_graph: null,
        profile_summary_hints: null,
      },
    },
  });
  assert.equal(okRow.session_id, "sess_row");
  assert.equal(okRow.agreement_bucket, true);
  assert.equal(okRow.agreement_step, false);
  assert.equal(okRow.py_was_stub, true);
  assert.equal(okRow.ts_latency_ms, 42);

  const errorRow = buildPlanCompareInsertRow({
    planPromise: Promise.resolve({ ok: false, error: "unused", latency_ms: 0 }),
    sessionId: "sess_error",
    turnId: "turn_error",
    userId: null,
    tsIntentBucket: "reasoning_path",
    tsPlanningStep: null,
    tsLatencyMs: 7,
    pyResult: { ok: false, error: "timeout", latency_ms: 701 },
  });
  assert.equal(errorRow.py_error, "timeout");
  assert.equal(errorRow.py_was_stub, null);
  assert.equal(errorRow.agreement_bucket, null);
});

await t("orchestrator starts /plan recorder and flushes without awaiting it", () => {
  assert.match(orchestratorSource, /createPlanCompareRecorder/);
  assert.match(orchestratorSource, /planCompare\.captureTsIntent/);
  assert.match(orchestratorSource, /planCompare\.flush/);
  assert.doesNotMatch(orchestratorSource, /await\s+planCompare\.flush/);
});

process.env.LUMO_ML_SERVICE_JWT_SECRET = oldSecret;
if (oldMlUrl === undefined) delete process.env.LUMO_ML_AGENT_URL;
else process.env.LUMO_ML_AGENT_URL = oldMlUrl;

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
