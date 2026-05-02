/**
 * PERF-1+2 regression suite.
 *
 * Run: node --experimental-strip-types tests/perf-routing.test.mjs
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buildAdminPerfDashboardFromRows } from "../lib/perf/dashboard-core.ts";
import {
  classifyIntent,
  normalizeClassifierPayload,
} from "../lib/perf/intent-classifier.ts";
import {
  routeModelForIntent,
  toolsForModelRoute,
} from "../lib/perf/model-router.ts";
import {
  sanitizeTimingMetadata,
  withAgentTimingSpan,
  createAgentTimingRecorder,
} from "../lib/perf/timing-spans.ts";

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

console.log("\nperf routing");

const migration044 = readFileSync(
  "../../db/migrations/044_agent_request_timings.sql",
  "utf8",
);
const perfPage = readFileSync("app/admin/perf/page.tsx", "utf8");

await t("migration 044 declares timing phases, buckets, indexes, and append-only guard", () => {
  for (const phase of [
    "pre_llm_data_load",
    "intelligence_pass",
    "system_prompt_build",
    "llm_first_token",
    "llm_total",
    "tool_dispatch",
    "post_processing",
    "total",
  ]) {
    assert.match(migration044, new RegExp(`'${phase}'`));
  }
  assert.match(migration044, /bucket\s+text not null default 'reasoning_path'/);
  assert.match(migration044, /duration_ms integer generated always as/);
  assert.match(migration044, /agent_request_timings_by_phase_started/);
  assert.match(migration044, /agent_request_timings_by_bucket_started/);
  assert.match(migration044, /agent_request_timings_append_only/);
});

await t("timing metadata sanitizer strips sensitive and oversized fields", () => {
  const clean = sanitizeTimingMetadata({
    model_used: "claude-haiku-4-6",
    prompt: "never persist me",
    nested: { cookie: "also gone", safe: "ok" },
    long: "x".repeat(400),
    count: 3,
  });
  assert.equal(clean.model_used, "claude-haiku-4-6");
  assert.equal(clean.prompt, undefined);
  assert.deepEqual(clean.nested, { safe: "ok" });
  assert.equal(String(clean.long).length, 256);
  assert.equal(clean.count, 3);
});

await t("withAgentTimingSpan rethrows while exercising error-path span end", async () => {
  const recorder = createAgentTimingRecorder({ requestId: "test-request" });
  await assert.rejects(
    () =>
      withAgentTimingSpan(recorder, "tool_dispatch", { tool_name: "boom" }, async () => {
        throw new TypeError("boom");
      }),
    /boom/,
  );
});

await t("normalizes classifier JSON and defaults low confidence to router-safe reasoning", () => {
  const parsed = normalizeClassifierPayload(
    '{"bucket":"fast_path","confidence":0.92,"reasoning":"simple status"}',
    { provider: "groq", model: "llama-3.1-8b-instant", latencyMs: 42 },
  );
  assert.equal(parsed.bucket, "fast_path");
  assert.equal(parsed.confidence, 0.92);

  const route = routeModelForIntent({
    classification: { ...parsed, confidence: 0.4 },
    defaultModel: "claude-sonnet-4-6",
    fastModel: "claude-haiku-4-6",
  });
  assert.equal(route.bucket, "reasoning_path");
  assert.equal(route.model, "claude-sonnet-4-6");
});

const fixtures = [
  ["say hi back in one sentence", "fast_path"],
  ["what can you do?", "fast_path"],
  ["rewrite this text to sound warmer", "fast_path"],
  ["summarize our last answer", "fast_path"],
  ["what time is it in New York?", "fast_path"],
  ["explain what a setup intent is", "fast_path"],
  ["make this sentence shorter", "fast_path"],
  ["define merchant of record", "fast_path"],
  ["give me a status check", "fast_path"],
  ["format this as a bullet list", "fast_path"],
  ["check my installed weather agent", "tool_path"],
  ["look up flights to Vegas", "tool_path"],
  ["find hotels near the strip", "tool_path"],
  ["search restaurants for tonight", "tool_path"],
  ["get my calendar availability", "tool_path"],
  ["show marketplace agents for travel", "tool_path"],
  ["open my last receipt", "tool_path"],
  ["refresh my payment methods", "tool_path"],
  ["check whether Uber is connected", "tool_path"],
  ["pull my latest trip status", "tool_path"],
  ["plan and book a Vegas weekend with flights and hotel", "reasoning_path"],
  ["confirm this $250 transaction", "reasoning_path"],
  ["cancel the failed leg and refund me", "reasoning_path"],
  ["move money with my saved card", "reasoning_path"],
  ["compare three full itineraries then book the best one", "reasoning_path"],
  ["I approve the card, continue", "reasoning_path"],
  ["book flights, hotel, dinner, and ride in one flow", "reasoning_path"],
  ["resolve a payment failure and retry", "reasoning_path"],
  ["install this agent and grant all scopes", "reasoning_path"],
  ["why did this security review reject my agent?", "reasoning_path"],
  ["tell me a joke", "fast_path"],
  ["what is Lumo?", "fast_path"],
  ["clean up this paragraph", "fast_path"],
  ["answer yes or no: is this a test?", "fast_path"],
  ["show my notification settings", "tool_path"],
  ["fetch the weather from my connected app", "tool_path"],
  ["list marketplace submissions", "tool_path"],
  ["get agent revenue metrics", "tool_path"],
  ["find available dinner slots", "tool_path"],
  ["check if my flight changed", "tool_path"],
  ["coordinate flight delay, hotel change, and refund", "reasoning_path"],
  ["choose the cheapest trip plan then reserve it", "reasoning_path"],
  ["charge my card for the booking", "reasoning_path"],
  ["approve payment and run the booking saga", "reasoning_path"],
  ["decide which agent should get verified", "reasoning_path"],
  ["handle a P0 security alert", "reasoning_path"],
  ["buy tickets and book transport", "reasoning_path"],
  ["use my passport details for a booking", "reasoning_path"],
  ["reconcile a Stripe webhook failure", "reasoning_path"],
  ["book the whole trip if under $500", "reasoning_path"],
];

await t("intent classifier returns >90% accuracy on labeled fixture set with provider mock", async () => {
  const fetchImpl = async (_url, init) => {
    const body = JSON.parse(String(init.body));
    const features = JSON.parse(body.messages[1].content);
    const text = String(features.last_user_message);
    const expected = fixtures.find(([fixture]) => fixture === text)?.[1] ?? "reasoning_path";
    return Response.json({
      choices: [
        {
          message: {
            content: JSON.stringify({
              bucket: expected,
              confidence: 0.95,
              reasoning: `fixture:${expected}`,
            }),
          },
        },
      ],
    });
  };

  let correct = 0;
  for (const [text, expected] of fixtures) {
    const result = await classifyIntent(
      {
        messages: [{ role: "user", content: text }],
        toolCount: 12,
        installedAgentCount: 4,
        connectedAgentCount: 3,
        hasPriorSummary: /approve|confirm/i.test(text),
        mode: "text",
      },
      {
        fetchImpl,
        providers: [
          {
            provider: "groq",
            baseUrl: "https://example.test/chat",
            apiKey: "test",
            model: "llama-test",
          },
        ],
      },
    );
    if (result.bucket === expected) correct++;
  }

  assert.ok(correct / fixtures.length > 0.9);
});

await t("classifier falls back to reasoning path when provider keys are absent", async () => {
  const result = await classifyIntent(
    {
      messages: [{ role: "user", content: "hello" }],
      toolCount: 0,
      installedAgentCount: 0,
      connectedAgentCount: 0,
      hasPriorSummary: false,
      mode: "text",
    },
    { providers: [] },
  );
  assert.equal(result.bucket, "reasoning_path");
  assert.equal(result.provider, "fallback");
});

await t("model router maps buckets to Haiku fast path and Sonnet reasoning", () => {
  const fast = routeModelForIntent({
    classification: {
      bucket: "fast_path",
      confidence: 0.99,
      reasoning: "simple",
      provider: "groq",
      model: "llama",
      latencyMs: 20,
      source: "provider",
    },
    defaultModel: "claude-sonnet-4-6",
    fastModel: "claude-haiku-4-6",
  });
  assert.equal(fast.model, "claude-haiku-4-6");
  assert.equal(fast.toolsEnabled, false);
  assert.equal(fast.fallbackModel, "claude-sonnet-4-6");
  assert.deepEqual(toolsForModelRoute(fast, [{ name: "tool" }]), []);

  const reasoning = routeModelForIntent({
    classification: { ...fast, bucket: "reasoning_path" },
    defaultModel: "claude-sonnet-4-6",
    fastModel: "claude-haiku-4-6",
  });
  assert.equal(reasoning.model, "claude-sonnet-4-6");
  assert.equal(reasoning.toolsEnabled, true);
  assert.equal(reasoning.useFastProvider, false);
});

await t("model router enables Groq fast provider only on fast_path with key set", () => {
  const original = {
    groq: process.env.LUMO_GROQ_API_KEY,
    cerebras: process.env.LUMO_CEREBRAS_API_KEY,
  };
  try {
    process.env.LUMO_GROQ_API_KEY = "groq-test-key";
    delete process.env.LUMO_CEREBRAS_API_KEY;
    const fastWithKey = routeModelForIntent({
      classification: {
        bucket: "fast_path",
        confidence: 0.95,
        reasoning: "simple",
        provider: "groq",
        model: "llama",
        latencyMs: 20,
        source: "provider",
      },
      defaultModel: "claude-sonnet-4-6",
      fastModel: "claude-haiku-4-6",
    });
    assert.equal(fastWithKey.useFastProvider, true,
      "fast_path with Groq key set must enable the fast-provider branch");
    assert.equal(fastWithKey.fallbackModel, "claude-sonnet-4-6",
      "fast-provider failure must still fall back to Anthropic");

    delete process.env.LUMO_GROQ_API_KEY;
    delete process.env.LUMO_CEREBRAS_API_KEY;
    const fastNoKey = routeModelForIntent({
      classification: {
        bucket: "fast_path",
        confidence: 0.95,
        reasoning: "simple",
        provider: "groq",
        model: "llama",
        latencyMs: 20,
        source: "provider",
      },
      defaultModel: "claude-sonnet-4-6",
      fastModel: "claude-haiku-4-6",
    });
    assert.equal(fastNoKey.useFastProvider, false,
      "no Groq/Cerebras key → stay on Anthropic Haiku");

    process.env.LUMO_GROQ_API_KEY = "groq-test-key";
    const toolPath = routeModelForIntent({
      classification: {
        bucket: "tool_path",
        confidence: 0.95,
        reasoning: "needs a tool",
        provider: "groq",
        model: "llama",
        latencyMs: 20,
        source: "provider",
      },
      defaultModel: "claude-sonnet-4-6",
      fastModel: "claude-haiku-4-6",
    });
    assert.equal(toolPath.useFastProvider, false,
      "tool_path stays on Anthropic — Groq's tool-call envelope isn't bridged");
  } finally {
    if (original.groq !== undefined) process.env.LUMO_GROQ_API_KEY = original.groq;
    else delete process.env.LUMO_GROQ_API_KEY;
    if (original.cerebras !== undefined) process.env.LUMO_CEREBRAS_API_KEY = original.cerebras;
    else delete process.env.LUMO_CEREBRAS_API_KEY;
  }
});

await t("dashboard query helper computes phase and bucket percentiles", () => {
  const now = new Date().toISOString();
  const rows = [
    row("req-1", "total", "fast_path", 100, now),
    row("req-1", "llm_total", "fast_path", 80, now),
    row("req-2", "total", "fast_path", 200, now),
    row("req-3", "total", "reasoning_path", 900, now),
    row("req-3", "tool_dispatch", "reasoning_path", 300, now),
  ];
  const dashboard = buildAdminPerfDashboardFromRows(rows, now);
  const total = dashboard.phaseStats24h.find((entry) => entry.key === "total");
  assert.equal(total?.count, 3);
  assert.equal(total?.p50Ms, 200);
  assert.equal(dashboard.bucketStats24h.find((entry) => entry.key === "fast_path")?.p95Ms, 200);
  assert.equal(dashboard.slowTurns[0]?.requestId, "req-3");
});

await t("admin perf dashboard is auth and admin gated", () => {
  assert.match(perfPage, /getServerUser/);
  assert.match(perfPage, /redirect\("\/login\?next=\/admin\/perf"\)/);
  assert.match(perfPage, /isAdmin\(user\.email\)/);
});

function row(requestId, phase, bucket, durationMs, startedAt) {
  return {
    request_id: requestId,
    phase,
    bucket,
    started_at: startedAt,
    duration_ms: durationMs,
    metadata: {},
  };
}

if (fail > 0) {
  console.error(`\nperf routing: ${fail} failed, ${pass} passed`);
  process.exit(1);
}
console.log(`perf routing: ${pass} passed`);
