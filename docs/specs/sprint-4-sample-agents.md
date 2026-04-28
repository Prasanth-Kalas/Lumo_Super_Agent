# Sprint 4 SAMPLE-AGENTS — Three reference agents

**Status:** Design draft, written during Kalas-Cowork session 2026-04-28, pending Kalas seal.
**Author:** Claude coworker (Cowork session), reviewed by Kalas.
**Implements:** Phase 4 W2 deliverable per `docs/specs/phase-4-master.md`
§2 (SAMPLE-AGENTS) and ADR-013 §11 acceptance criterion 2.
**Precondition:** SDK-1 shipped (`packages/lumo-agent-sdk@1.0.0` on `main`).

---

## Goal

Three reference agents under `samples/`, each demonstrating a distinct
trust tier, runtime posture, and capability shape. They are the patterns
external developers copy. After SAMPLE-AGENTS ships, the
`docs/developers/quickstart.md` "first agent in 15 minutes" path resolves
to a real, runnable, scaffold-ready set of examples — and Lumo's own
team has a canonical "everything-feature-shown" agent
(`lumo-rentals-trip-planner`) to point at when explaining the SDK.

The agents also serve a CI purpose: they run on every SDK PR (against
both in-process and `--sandbox` modes), so any SDK regression that
would break a real partner agent fails the build.

---

## What previous sprints already shipped

- **SDK-1** — `packages/lumo-agent-sdk@1.0.0` with `defineAgent`,
  `LumoAgent` runtime class, `ctx.brain` / `ctx.connectors` /
  `ctx.state` / `ctx.confirm` / `ctx.askUser` / `ctx.history`,
  manifest validator, `lumo-agent` CLI (`init`, `dev`, `validate`,
  `submit`), E2B sandbox runner, migration 027.
- **`docs/developers/`** — 13-file docs pack already drafted; the
  `example-agents.md` page is a placeholder waiting for these three
  agents to materialise.
- **Brain SDK** (Phase 3 SDK-1) — provides `lumo_recall_unified`,
  `lumo_personalize_rank`, the typed Brain client agents call.
- **Connector dispatcher** (`lib/integrations/registry.ts`) — exposes
  Gmail, Calendar, weather, mapping, and other connectors the samples
  consume.
- **Confirmation card pipeline** (D3, `1475bcd`) — the surface
  `lumo-rentals-trip-planner` exercises end-to-end.

---

## What this sprint adds

Three agents under `samples/`, each its own subdirectory:

### 1. `samples/weather-now/` — experimental tier

Smallest possible agent. One capability: `whats_the_weather_now`. Reads
the user's last-asked location from `ctx.brain.lumo_recall_unified` and
calls a public weather connector. Read-only. No confirmation card.

- Manifest: `trust_tier_target: "experimental"`,
  `requires.brain_tools: ["lumo_recall_unified"]`,
  `requires.connectors: ["open-weather"]`,
  `requires.scopes: ["read.recall", "read.location.current"]`,
  `cost_model.max_cost_usd_per_invocation: 0.005`.
- Demonstrates: minimal manifest, minimal entrypoint, single `ctx.brain`
  call, single `ctx.connectors` call. ~50 lines of TypeScript.

### 2. `samples/summarize-emails-daily/` — verified tier

Reads unread Gmail and produces a morning digest grouped by sender
importance. Two capabilities: `summarize_unread_inbox` (read-only) and
`prepare_morning_digest` (read-only, calls the first internally).

- Manifest: `trust_tier_target: "verified"`,
  `requires.brain_tools: ["lumo_recall_unified", "lumo_personalize_rank"]`,
  `requires.connectors: ["gmail"]`,
  `requires.scopes: ["read.email.headers", "read.email.bodies", "read.contacts"]`,
  `cost_model.max_cost_usd_per_invocation: 0.04`.
- Uses `ctx.state` for idempotency: stores last-run-timestamp keyed by
  user; second invocation within 1 hour returns the cached digest.
- Demonstrates: scope-ask shape, multi-tool invocation, idempotency via
  `ctx.state`, manifest with cost ceiling, capability with two scopes.

### 3. `samples/lumo-rentals-trip-planner/` — official tier

Self-reinforcing reference: plans a Lumo Rentals trip end-to-end. Three
capabilities: `find_rental_for_trip`, `book_rental`, `confirm_booking`.

- Manifest: `trust_tier_target: "official"`,
  `requires.brain_tools: ["lumo_recall_unified", "lumo_personalize_rank", "lumo_optimize_trip"]`,
  `requires.connectors: ["lumo-rentals", "stripe", "google-calendar"]`,
  `requires.scopes: ["read.calendar.events", "write.calendar.events", "write.financial.transfer.up_to_per_invocation:500_usd:per_day:1500_usd"]`,
  `cost_model.max_cost_usd_per_invocation: 0.25`.
- `book_rental` is side-effecting. Returns `status: needs_confirmation`
  with a `confirmation_card` summarising the rental, dates, total cost,
  and reversibility (`compensating` — refund flow exists).
- `confirm_booking` runs after the user approves the confirmation card.
  Calls Stripe + Lumo Rentals + Calendar in sequence; emits provenance
  for every step.
- Runs in-process (`runtime: "node18"` plus the `system: true` flag on
  installation, per ADR-013 §6.3 carve-out — official-tier agents may
  run in-process after security review).
- Demonstrates: side-effect with `ctx.confirm()`, multi-step mission
  integration, multi-connector orchestration, idempotency (the
  `request_id` ties Stripe charge → Lumo Rentals reservation →
  Calendar event so a retry doesn't double-book), official-tier
  in-process posture.

---

## Architecture

Each agent is an independent module under `samples/` with the layout:

```
samples/<agent>/
├── lumo-agent.json
├── README.md
├── package.json                # depends on @lumo/agent-sdk: workspace:*
├── tsconfig.json
├── src/
│   └── index.ts                # default export from defineAgent({...})
└── tests/
    ├── unit.test.mts           # capability-level tests
    └── e2e.test.mts            # against the dev harness
```

The `samples/` directory is added to the monorepo root `package.json`
workspaces array. CI builds and tests every sample on every SDK PR.

### `weather-now` entrypoint sketch

```ts
import { defineAgent } from "@lumo/agent-sdk";

export default defineAgent({
  manifest: () => import("./lumo-agent.json"),
  capabilities: {
    whats_the_weather_now: async (inputs, ctx) => {
      const lastLocation = await ctx.brain.lumo_recall_unified({
        query: "user's last-asked location for weather",
        limit: 1,
      });
      const location = lastLocation.results[0]?.text ?? inputs.fallback_location ?? "current";
      const weather = await ctx.connectors["open-weather"].current({ location });
      return {
        status: "succeeded",
        outputs: { location, summary: weather.summary, temp_f: weather.temp_f },
        provenance_evidence: {
          sources: [
            { type: "brain.recall", ref: "lumo_recall_unified", hash: lastLocation.hash },
            { type: "connector.open-weather", ref: location },
          ],
          redaction_applied: false,
        },
        cost_actuals: { /* populated by SDK */ },
      };
    },
  },
});
```

### `summarize-emails-daily` — idempotency pattern

```ts
import { defineAgent, withIdempotency } from "@lumo/agent-sdk";

export default defineAgent({
  manifest: () => import("./lumo-agent.json"),
  capabilities: {
    summarize_unread_inbox: withIdempotency(
      "summarize_unread_inbox",
      async (inputs, ctx) => {
        // capability body
      },
      { ttl_minutes: 60 } // re-runs within 60 minutes return cached
    ),
    prepare_morning_digest: async (inputs, ctx) => {
      // calls summarize_unread_inbox internally via ctx.history(missionId)
    },
  },
});
```

### `lumo-rentals-trip-planner` — confirmation card pattern

```ts
import { defineAgent, buildConfirmationCard } from "@lumo/agent-sdk";

export default defineAgent({
  manifest: () => import("./lumo-agent.json"),
  capabilities: {
    find_rental_for_trip: async (inputs, ctx) => { /* ... */ },
    book_rental: async (inputs, ctx) => {
      const rental = await ctx.brain.lumo_optimize_trip({ /* ... */ });
      return ctx.confirm(buildConfirmationCard({
        title: `Book ${rental.vehicle} for ${rental.dates}`,
        body: `Pickup ${rental.pickup} → Return ${rental.return}. Total ${rental.total_usd}.`,
        side_effect_summary: `Charges ${rental.total_usd} to Stripe and creates a calendar event.`,
        reversibility: "compensating",
        expires_at: ctx.helpers.in(15, "minutes"),
      }));
    },
    confirm_booking: async (inputs, ctx) => { /* runs after card approved */ },
  },
});
```

---

## Acceptance

Per `phase-4-master.md` §2 (SAMPLE-AGENTS):

1. All three agents pass `lumo-agent validate` clean (zero rejections
   from any of the 10 manifest validator rules).
2. All three install and invoke successfully on the Vegas synthetic
   test user (the user persona used by `scripts/synthetic-vegas-data/`).
3. `lumo-rentals-trip-planner` exercises a confirmation card
   end-to-end — proves the card linkage in migration 024 works for an
   external-shaped agent. The integration test asserts:
   - `book_rental` returns `status: needs_confirmation` with a
     well-formed card.
   - The card is inserted into the existing confirmation-card system
     and linked via `mission_steps.confirmation_card_id`.
   - On user-approve, `confirm_booking` runs and emits the provenance
     chain (Stripe charge → rental reservation → calendar event).
4. Each agent has its README at `samples/<agent>/README.md` documenting
   its manifest line-by-line. These READMEs become the basis for the
   `docs/developers/example-agents.md` walkthrough.
5. CI runs all three samples in both modes (`lumo-agent dev` and
   `lumo-agent dev --sandbox`) on every SDK PR; identical outputs
   asserted.
6. `lumo-rentals-trip-planner` exercises every ADR-013 surface: Brain
   SDK call, connector dispatcher call, confirmation card,
   per-agent KV (`ctx.state`), idempotency on retry within 24h. The
   spec calls out every surface in the README so it can serve as the
   "everything-feature-shown" agent.
7. One commit on `main`: `feat(samples): add three reference agents`.
   The commit body references SDK-1 + `phase-4-master.md` §2 by hash.

---

## Out of scope

- Publishing these to the marketplace as `published` rows. That's
  MARKETPLACE-1; samples ship in `samples/` but aren't yet
  end-user-installable from the marketplace UI. The Vegas test user
  bypasses the marketplace UI and installs them directly via the dev
  harness.
- Rating these agents 5 stars in the marketplace. Phase 4 doesn't
  ship rating UX (post-MVP).
- Promoting `lumo-rentals-trip-planner` to a real production-shipped
  agent. That's a separate ops task; the sample stays a sample.
- Python port of any of these. Node18 only in v1 per ADR-013 §12.

---

## File map

New files:

- `samples/weather-now/lumo-agent.json`
- `samples/weather-now/README.md`
- `samples/weather-now/package.json`
- `samples/weather-now/tsconfig.json`
- `samples/weather-now/src/index.ts`
- `samples/weather-now/tests/unit.test.mts`
- `samples/weather-now/tests/e2e.test.mts`
- `samples/summarize-emails-daily/` (same layout)
- `samples/lumo-rentals-trip-planner/` (same layout, plus a
  `samples/lumo-rentals-trip-planner/fixtures/` dir of recorded
  Stripe/Calendar/Lumo Rentals responses for the test cases)
- `tests/sample-agents-ci.test.mjs` — CI driver that runs every sample
  in both modes against the dev harness.

Modified files:

- `package.json` (root) — add `samples/*` to workspaces array.
- `docs/developers/example-agents.md` — replace placeholder text with
  per-sample walkthroughs derived from each sample's README.

Touched read-only:

- `packages/lumo-agent-sdk/` — every sample depends on this; SDK is
  not modified.
- `lib/orchestrator.ts`, `lib/integrations/registry.ts`,
  `lib/brain-sdk/` — invariant surfaces; samples consume them.
