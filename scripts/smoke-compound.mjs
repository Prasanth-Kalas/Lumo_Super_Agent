#!/usr/bin/env node
/**
 * Smoke test for compound-booking orchestration primitives.
 *
 *   - lib/saga.ts         — rollback planner (pure)
 *   - lib/trip-planner.ts — TripSummary assembly + decimal sum (pure)
 *   - lib/trip-state.ts   — per-session store + state machine
 *
 * No network, no Claude, no registry. Fixtures only. Prints ✓/✗ per
 * assertion and exits non-zero on any failure so CI catches regressions.
 *
 *   node scripts/smoke-compound.mjs
 *
 * Implementation notes:
 *
 * The target modules are .ts source. Super Agent is a Next.js app and
 * has no build-to-dist step (Next transpiles at request time). Rather
 * than introduce tsx/esbuild, we use the already-installed `typescript`
 * package to transpile the three files into `.smoke-build/` at startup
 * and dynamic-import the result. Because `.smoke-build/` lives inside
 * Super Agent, the transpiled code's `@lumo/agent-sdk` runtime imports
 * (only `trip-state.ts` actually has one at runtime — the other two
 * files use type-only imports) resolve through the real node_modules.
 */

import { createRequire } from "node:module";
import { readFileSync, rmSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import url from "node:url";

const __filename = url.fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..");
const libDir = path.join(repoRoot, "lib");
const buildDir = path.join(repoRoot, ".smoke-build");

const require_ = createRequire(import.meta.url);
const ts = require_("typescript");

// ── 0. Transpile the three lib modules ─────────────────────────────────
console.log("[0] transpiling lib/{saga,trip-planner,trip-state}.ts → .smoke-build/");

if (existsSync(buildDir)) rmSync(buildDir, { recursive: true, force: true });
mkdirSync(buildDir, { recursive: true });
// Mark the directory ESM so `./foo.js` imports inside transpiled output
// resolve to the sibling .js files as native ESM modules.
writeFileSync(path.join(buildDir, "package.json"), JSON.stringify({ type: "module" }));

function transpileFile(basename) {
  const src = readFileSync(path.join(libDir, basename + ".ts"), "utf8");
  const out = ts.transpileModule(src, {
    compilerOptions: {
      module: ts.ModuleKind.ES2022,
      target: ts.ScriptTarget.ES2022,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      esModuleInterop: true,
      isolatedModules: true,
      verbatimModuleSyntax: false,
      // No declaration emission, no source maps — smoke only cares
      // about runtime behaviour.
    },
    fileName: basename + ".ts",
  });
  if (out.diagnostics && out.diagnostics.length > 0) {
    // transpileModule only surfaces SYNTAX diagnostics (not semantic);
    // a syntax diag here means the source file is broken.
    for (const d of out.diagnostics) {
      console.error("  ✗ transpile diag:", ts.flattenDiagnosticMessageText(d.messageText, "\n"));
    }
    process.exit(1);
  }
  writeFileSync(path.join(buildDir, basename + ".js"), out.outputText);
}

for (const b of ["saga", "trip-planner", "trip-state"]) transpileFile(b);
console.log("  ✓ transpile succeeded\n");

// Dynamic import the transpiled outputs. Use file:// URLs so Node's
// loader doesn't get confused about cwd vs import origin.
const sagaUrl = url.pathToFileURL(path.join(buildDir, "saga.js")).href;
const plannerUrl = url.pathToFileURL(path.join(buildDir, "trip-planner.js")).href;
const stateUrl = url.pathToFileURL(path.join(buildDir, "trip-state.js")).href;

const saga = await import(sagaUrl);
const planner = await import(plannerUrl);
const state = await import(stateUrl);

// The SDK we use for fixture construction — resolve through Super
// Agent's node_modules so we get the exact same hash function the
// planner/state modules will call.
const sdk = await import("@lumo/agent-sdk");

// ── Test harness ───────────────────────────────────────────────────────
let failures = 0;
function assert(cond, msg) {
  if (!cond) {
    console.error("  ✗", msg);
    failures += 1;
  } else {
    console.log("  ✓", msg);
  }
}
function assertThrows(fn, code, msg) {
  try {
    fn();
    assert(false, msg + " (expected throw; none)");
  } catch (err) {
    if (code && err && err.code !== code) {
      assert(false, msg + ` (expected code=${code}, got ${err?.code})`);
    } else {
      assert(true, msg);
    }
  }
}

// ── Fixtures ───────────────────────────────────────────────────────────
const flightSummary = sdk.attachSummary(
  { offer_id: "DUFFEL_OFF_1" },
  {
    kind: "structured-itinerary",
    payload: { flight: "ORD->LAS", depart: "2026-05-01T08:00", total: "287.45" },
  },
)._lumo_summary;

const hotelSummary = sdk.attachSummary(
  { room_id: "MAR_SUI_88" },
  {
    kind: "structured-booking",
    payload: { hotel: "Marriott LAS", nights: 2, total: "489.00" },
  },
)._lumo_summary;

const dinnerSummary = sdk.attachSummary(
  { hold_id: "RESY_42" },
  {
    kind: "structured-booking",
    payload: { venue: "Le Cirque", party: 2, time: "2026-05-01T20:00", total: "471.00" },
  },
)._lumo_summary;

const pricedLegs = [
  {
    agent_id: "flight",
    tool_name: "flight_book_offer",
    order: 1,
    depends_on: [],
    summary: flightSummary,
    leg_amount: "287.45",
    currency: "USD",
  },
  {
    agent_id: "hotel",
    tool_name: "hotel_book_room",
    order: 2,
    depends_on: [1],
    summary: hotelSummary,
    leg_amount: "489.00",
    currency: "USD",
  },
  {
    agent_id: "restaurant",
    tool_name: "restaurant_confirm_reservation",
    order: 3,
    depends_on: [1, 2],
    summary: dinnerSummary,
    leg_amount: "471.00",
    currency: "USD",
  },
];

// ══════════════════════════════════════════════════════════════════════
// SECTION 1: trip-planner
// ══════════════════════════════════════════════════════════════════════

console.log("\n[1] trip-planner — decimal sum helpers");
assert(planner.sumDecimalStrings(["100", "0.50"]) === "100.50", "sum int + frac preserves precision");
assert(planner.sumDecimalStrings(["100.5", "0.005"]) === "100.505", "sum mixed scale expands to max frac");
assert(planner.sumDecimalStrings(["0.01", "0.02"]) === "0.03", "small frac adds correctly");
assert(planner.sumDecimalStrings(["0.99", "0.02"]) === "1.01", "frac carry into int");
assert(planner.sumDecimalStrings(["100"]) === "100", "single int passes through");
assert(planner.sumDecimalStrings([]) === "0", "empty sums to 0");
assert(planner.decimalStringsEqual("247", "247.00"), "decimalStringsEqual ignores trailing zeros");
assert(planner.decimalStringsEqual("247.000", "247"), "decimalStringsEqual symmetric");
assert(!planner.decimalStringsEqual("247", "247.01"), "decimalStringsEqual catches real diffs");

console.log("\n[2] trip-planner — happy path assembly");
const tripPayload = planner.assembleTripSummary({
  trip_title: "Chicago → Las Vegas, May 1–3",
  legs: pricedLegs,
});
assert(tripPayload.trip_title === "Chicago → Las Vegas, May 1–3", "trip_title preserved");
assert(tripPayload.currency === "USD", "currency captured");
assert(tripPayload.total_amount === "1247.45", "total_amount sums legs");
assert(tripPayload.legs.length === 3, "3 legs in payload");
assert(tripPayload.legs[0].order === 1, "legs sorted by order (leg 1 first)");
assert(tripPayload.legs[2].order === 3, "leg 3 last");
assert(tripPayload.legs[2].depends_on.length === 2, "depends_on preserved");

// Caller-provided expected_total that matches sums should pass:
const tripWithExpected = planner.assembleTripSummary({
  trip_title: "Trip",
  legs: pricedLegs,
  expected_total: "1247.450", // different scale but same value
});
assert(tripWithExpected.total_amount === "1247.45", "expected_total at different scale accepted");

// Input-order independence:
const reversedPayload = planner.assembleTripSummary({
  trip_title: "Reversed",
  legs: pricedLegs.slice().reverse(),
});
assert(reversedPayload.legs[0].order === 1, "input array order doesn't affect output ordering");

console.log("\n[3] trip-planner — rejects invalid input");
assertThrows(
  () => planner.assembleTripSummary({ trip_title: "", legs: pricedLegs }),
  "invalid_trip_title",
  "empty trip_title rejected",
);
assertThrows(
  () => planner.assembleTripSummary({ trip_title: "T", legs: [] }),
  "empty_legs",
  "empty legs rejected",
);
assertThrows(
  () =>
    planner.assembleTripSummary({
      trip_title: "T",
      legs: [
        { ...pricedLegs[0], currency: "USD" },
        { ...pricedLegs[1], currency: "EUR" },
      ],
    }),
  "currency_mismatch",
  "mixed-currency trip rejected",
);
assertThrows(
  () =>
    planner.assembleTripSummary({
      trip_title: "T",
      legs: [{ ...pricedLegs[0], leg_amount: "not-a-number" }],
    }),
  "invalid_amount_format",
  "malformed leg_amount rejected",
);
assertThrows(
  () =>
    planner.assembleTripSummary({
      trip_title: "T",
      legs: pricedLegs,
      expected_total: "9999.99",
    }),
  "total_mismatch",
  "expected_total mismatch rejected",
);
assertThrows(
  () =>
    planner.assembleTripSummary({
      trip_title: "T",
      legs: pricedLegs,
      expected_total: "abc",
    }),
  "invalid_amount_format",
  "malformed expected_total rejected",
);

// Assembled payload must pass the SDK's attachTripSummary validation:
const trip = sdk.attachTripSummary({ meta: "test" }, { payload: tripPayload })._lumo_trip_summary;
assert(trip.kind === "structured-trip", "payload accepted by SDK attachTripSummary");
assert(/^[0-9a-f]{64}$/.test(trip.hash), "SDK produced well-formed hash");

// ══════════════════════════════════════════════════════════════════════
// SECTION 2: trip-state
// ══════════════════════════════════════════════════════════════════════

console.log("\n[4] trip-state — happy path draft → confirmed → dispatching → committed");
state.__resetForTesting();
const draft = state.createDraftTrip("sess-1", tripPayload);
assert(draft.status === "draft", "new trip is draft");
assert(draft.trip_id.startsWith("trip_"), "trip id minted");
assert(draft.legs.every((l) => l.status === "pending"), "all legs pending on create");
assert(draft.hash === trip.hash, "state hash matches SDK hash");

state.confirmTrip(draft.trip_id, draft.hash);
assert(state.getTripById(draft.trip_id).status === "confirmed", "confirmTrip advances status");

state.beginDispatch(draft.trip_id);
assert(state.getTripById(draft.trip_id).status === "dispatching", "beginDispatch advances status");

// Walk leg-by-leg through the happy path.
state.updateLeg(draft.trip_id, 1, { status: "in_flight" });
state.updateLeg(draft.trip_id, 1, { status: "committed", booking_id: "FLT_001" });
state.updateLeg(draft.trip_id, 2, { status: "in_flight" });
state.updateLeg(draft.trip_id, 2, { status: "committed", booking_id: "HTL_001" });
state.updateLeg(draft.trip_id, 3, { status: "in_flight" });
state.updateLeg(draft.trip_id, 3, { status: "committed", booking_id: "RES_001" });
const snap = state.snapshot(draft.trip_id);
assert(snap.every((l) => l.status === "committed"), "all legs committed in snapshot");
assert(snap.find((l) => l.order === 2).booking_id === "HTL_001", "booking_id persisted");

state.finalizeTrip(draft.trip_id, "committed");
assert(state.getTripById(draft.trip_id).status === "committed", "finalize to committed");

console.log("\n[5] trip-state — rejects illegal transitions");
state.__resetForTesting();
const t2 = state.createDraftTrip("sess-2", tripPayload);
// Wrong hash on confirm.
assertThrows(
  () => state.confirmTrip(t2.trip_id, "0".repeat(64)),
  "hash_mismatch",
  "confirmTrip rejects wrong hash",
);
// Confirm twice: second call illegal.
state.confirmTrip(t2.trip_id, t2.hash);
assertThrows(
  () => state.confirmTrip(t2.trip_id, t2.hash),
  "illegal_transition",
  "cannot re-confirm an already-confirmed trip",
);
// Dispatch twice: second illegal.
state.beginDispatch(t2.trip_id);
assertThrows(
  () => state.beginDispatch(t2.trip_id),
  "illegal_transition",
  "cannot re-begin dispatch",
);
// Illegal leg move: pending → committed without in_flight.
assertThrows(
  () => state.updateLeg(t2.trip_id, 1, { status: "committed", booking_id: "X" }),
  "illegal_leg_transition",
  "pending → committed rejected (must go through in_flight)",
);
// Nonexistent leg.
assertThrows(
  () => state.updateLeg(t2.trip_id, 99, { status: "in_flight" }),
  "unknown_leg",
  "updateLeg on missing order rejected",
);
// Unknown trip.
assertThrows(
  () => state.confirmTrip("trip_nope", "0".repeat(64)),
  "trip_not_found",
  "lookup unknown trip fails cleanly",
);

console.log("\n[6] trip-state — snapshot is a deep copy");
state.__resetForTesting();
const t3 = state.createDraftTrip("sess-3", tripPayload);
const snap1 = state.snapshot(t3.trip_id);
snap1[0].status = "committed"; // tamper
snap1[0].depends_on.push(999);
const snap2 = state.snapshot(t3.trip_id);
assert(snap2[0].status === "pending", "snapshot mutation does not leak to store");
assert(!snap2[0].depends_on.includes(999), "snapshot depends_on mutation isolated");

console.log("\n[7] trip-state — replacing a draft is allowed; replacing a confirmed is not");
state.__resetForTesting();
state.createDraftTrip("sess-4", tripPayload);
state.createDraftTrip("sess-4", tripPayload); // replace draft — ok
state.createDraftTrip("sess-5", tripPayload);
const t5 = state.getTripBySession("sess-5");
state.confirmTrip(t5.trip_id, t5.hash);
assertThrows(
  () => state.createDraftTrip("sess-5", tripPayload),
  "illegal_transition",
  "cannot replace a confirmed trip's draft",
);

// ══════════════════════════════════════════════════════════════════════
// SECTION 3: saga.planRollback
// ══════════════════════════════════════════════════════════════════════

/**
 * Minimal ToolRoutingEntry shape — the saga only reads `.cancels`,
 * `.compensation_kind`, and `.agent_id`. Anything else is ignored.
 */
const routing = {
  flight_book_offer: {
    agent_id: "flight",
    tool_name: "flight_book_offer",
    method: "POST",
    path: "/api/tools/flight_book_offer",
    cost_tier: "money-moving",
    requires_confirmation: true,
    pii_required: ["name", "email"],
    cancels: "flight_cancel_booking",
  },
  flight_cancel_booking: {
    agent_id: "flight",
    tool_name: "flight_cancel_booking",
    method: "POST",
    path: "/api/tools/flight_cancel_booking",
    cost_tier: "free",
    requires_confirmation: false,
    pii_required: [],
    cancel_for: "flight_book_offer",
    compensation_kind: "best-effort",
  },
  hotel_book_room: {
    agent_id: "hotel",
    tool_name: "hotel_book_room",
    method: "POST",
    path: "/api/tools/hotel_book_room",
    cost_tier: "money-moving",
    requires_confirmation: true,
    pii_required: ["name"],
    cancels: "hotel_cancel_room",
  },
  hotel_cancel_room: {
    agent_id: "hotel",
    tool_name: "hotel_cancel_room",
    method: "POST",
    path: "/api/tools/hotel_cancel_room",
    cost_tier: "free",
    requires_confirmation: false,
    pii_required: [],
    cancel_for: "hotel_book_room",
    compensation_kind: "perfect",
  },
  restaurant_confirm_reservation: {
    agent_id: "restaurant",
    tool_name: "restaurant_confirm_reservation",
    method: "POST",
    path: "/api/tools/restaurant_confirm_reservation",
    cost_tier: "money-moving",
    requires_confirmation: true,
    pii_required: ["name"],
    cancels: "restaurant_cancel_reservation",
  },
  restaurant_cancel_reservation: {
    agent_id: "restaurant",
    tool_name: "restaurant_cancel_reservation",
    method: "POST",
    path: "/api/tools/restaurant_cancel_reservation",
    cost_tier: "free",
    requires_confirmation: false,
    pii_required: [],
    cancel_for: "restaurant_confirm_reservation",
    compensation_kind: "manual", // requires human follow-up (seat-level)
  },
};
const lookup = { routing };

console.log("\n[8] saga — single committed leg produces one step");
const plan1 = saga.planRollback(
  [
    { order: 1, agent_id: "flight", tool_name: "flight_book_offer", depends_on: [], status: "committed", booking_id: "FLT_001" },
  ],
  lookup,
);
assert(plan1.steps.length === 1, "one step");
assert(plan1.manual_escalations.length === 0, "no escalations");
assert(plan1.steps[0].tool_name === "flight_cancel_booking", "cancel tool resolved");
assert(plan1.steps[0].body.booking_id === "FLT_001", "booking_id threaded through");
assert(plan1.steps[0].compensation_kind === "best-effort", "compensation_kind preserved");
assert(plan1.expected_refund_legs === 1, "expected_refund_legs counts this leg");

console.log("\n[9] saga — reverse-topological ordering (deepest leg first)");
// All three committed, leg 1 failed would not trigger rollback — but
// simulate a post-commit user-abort where all three legs committed and
// we need to roll everything back.
const fullCommitSnap = [
  { order: 1, agent_id: "flight", tool_name: "flight_book_offer", depends_on: [], status: "committed", booking_id: "FLT_001" },
  { order: 2, agent_id: "hotel", tool_name: "hotel_book_room", depends_on: [1], status: "committed", booking_id: "HTL_001" },
  { order: 3, agent_id: "restaurant", tool_name: "restaurant_confirm_reservation", depends_on: [1, 2], status: "committed", booking_id: "RES_001" },
];
const plan2 = saga.planRollback(fullCommitSnap, lookup);
// restaurant has compensation_kind=manual → escalation, not step.
assert(plan2.steps.length === 2, "two auto-cancels (flight + hotel)");
assert(plan2.manual_escalations.length === 1, "one manual escalation");
assert(plan2.manual_escalations[0].order === 3, "restaurant escalated");
assert(plan2.manual_escalations[0].reason === "compensation_kind_manual", "correct reason");
// Hotel depends on flight, so hotel (depth 1) cancels before flight (depth 0).
assert(plan2.steps[0].order === 2, "depth-1 leg (hotel) cancels first");
assert(plan2.steps[1].order === 1, "depth-0 leg (flight) cancels last");
assert(plan2.expected_refund_legs === 2, "two refundable legs");

console.log("\n[10] saga — determinism: same input → byte-identical output");
const plan2b = saga.planRollback(fullCommitSnap, lookup);
assert(JSON.stringify(plan2) === JSON.stringify(plan2b), "deterministic output");

console.log("\n[11] saga — escalation classifications");
// (a) missing booking_id on committed leg
const planA = saga.planRollback(
  [
    { order: 1, agent_id: "flight", tool_name: "flight_book_offer", depends_on: [], status: "committed" /* no booking_id */ },
  ],
  lookup,
);
assert(planA.steps.length === 0 && planA.manual_escalations.length === 1, "missing booking_id escalates");
assert(planA.manual_escalations[0].reason === "missing_booking_id", "missing_booking_id reason code");

// (b) forward tool has no `cancels` link
const fakeRouting = {
  no_cancel_tool: {
    agent_id: "x",
    tool_name: "no_cancel_tool",
    method: "POST",
    path: "/x",
    cost_tier: "money-moving",
    requires_confirmation: true,
    pii_required: [],
    // no cancels field
  },
};
const planB = saga.planRollback(
  [{ order: 1, agent_id: "x", tool_name: "no_cancel_tool", depends_on: [], status: "committed", booking_id: "X1" }],
  { routing: fakeRouting },
);
assert(planB.manual_escalations[0].reason === "no_cancel_tool", "no_cancel_tool reason when forward has no cancels");

// (c) cancels points at a tool not in routing map
const brokenRouting = {
  broken_book: {
    agent_id: "x",
    tool_name: "broken_book",
    method: "POST",
    path: "/x",
    cost_tier: "money-moving",
    requires_confirmation: true,
    pii_required: [],
    cancels: "does_not_exist",
  },
};
const planC = saga.planRollback(
  [{ order: 1, agent_id: "x", tool_name: "broken_book", depends_on: [], status: "committed", booking_id: "X2" }],
  { routing: brokenRouting },
);
assert(planC.manual_escalations[0].reason === "cancel_tool_missing", "cancel_tool_missing reason");

console.log("\n[12] saga — rollback_failed legs included in replan (idempotency)");
// Simulates: first rollback attempt handled leg 2 but leg 1's cancel
// failed. On retry the snapshot has leg 1 status="rollback_failed",
// leg 2 status="rolled_back". Plan should still include leg 1.
const retrySnap = [
  { order: 1, agent_id: "flight", tool_name: "flight_book_offer", depends_on: [], status: "rollback_failed", booking_id: "FLT_001" },
  { order: 2, agent_id: "hotel", tool_name: "hotel_book_room", depends_on: [1], status: "rolled_back", booking_id: "HTL_001" },
];
const planRetry = saga.planRollback(retrySnap, lookup);
assert(planRetry.steps.length === 1 && planRetry.steps[0].order === 1, "retry includes rollback_failed leg, excludes rolled_back");

console.log("\n[13] saga — reason string is stable and references the failing leg");
// Add a failed leg so buildReason uses the leg-reference branch.
const snapWithFail = [
  { order: 1, agent_id: "flight", tool_name: "flight_book_offer", depends_on: [], status: "committed", booking_id: "FLT_001" },
  { order: 2, agent_id: "hotel", tool_name: "hotel_book_room", depends_on: [1], status: "failed", error_detail: { code: "PRICE_CHANGED" } },
];
const planFail = saga.planRollback(snapWithFail, lookup);
assert(planFail.steps[0].body.reason === "trip_rollback:leg_2_hotel_book_room_failed", "reason references failing leg");

// ── Summary ────────────────────────────────────────────────────────────
console.log("");
if (failures === 0) {
  console.log(`\nsmoke-compound: all assertions passed`);
  // Clean up transpiled output — leaving .smoke-build around would
  // confuse eslint/next. Idempotent if re-run.
  rmSync(buildDir, { recursive: true, force: true });
  process.exit(0);
} else {
  console.error(`\nsmoke-compound: ${failures} assertion(s) failed`);
  // Keep .smoke-build around on failure so the operator can inspect
  // the transpiled output for debugging.
  process.exit(1);
}
