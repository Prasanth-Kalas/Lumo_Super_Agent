# Sprint 4 SDK-1 — Agent SDK v1

**Status:** Design draft, written during Kalas-Cowork session 2026-04-28, pending Kalas seal.
**Author:** Claude coworker (Cowork session), reviewed by Kalas.
**Implements:** Phase 4 W1 deliverable per `docs/specs/phase-4-master.md`
§1 (SDK-1 — Agent SDK v1) and the binding contract in
`docs/specs/adr-013-agent-runtime-contract.md`.
**Precondition:** `docs/specs/sprint-4-pre-seal-phase-4.md` lands first
so the ADRs this sprint cites are tracked in `git`.

---

## Goal

Replace the placeholder `@lumo/agent-sdk` git+https stub in
`package.json` with a real, in-tree, versioned package
`packages/lumo-agent-sdk@1.0.0`. The SDK is the contract surface every
external developer reads: types, runtime helpers, manifest validator,
local dev harness, E2B sandbox runner, submission CLI.

After SDK-1 ships, a non-Lumo developer can run
`npm create lumo-agent`, scaffold a working Node18 agent, validate its
manifest locally, run it against a mock Brain + mock connectors, and
publish to the `community` tier — without touching the core repo and
without reading core source. That capability is the platform thesis;
SDK-1 is the platform thesis becoming executable.

The downstream Phase 4 deliverables (SAMPLE-AGENTS, MARKETPLACE-1,
DEV-DASH, TRUST-1, DOCS) all consume this SDK. SDK-1 is the dependency
root of Phase 4.

---

## What previous sprints already shipped

- **`Lumo_Agent_SDK@0.4.0`** (separate repo, last commit `9ebf421
  2026-04-27 feat: add mission rollback tool metadata`). This is the
  stub the platform's `package.json` currently points at via git+https.
  SDK-1 supersedes it. The standalone repo will be archived once the
  in-tree package is published.
- **`lib/orchestrator.ts`, `lib/registry-config.ts`,
  `lib/service-jwt.ts`** — the orchestrator, registry, and JWT signing
  the SDK calls into. SDK-1 does not modify these; it consumes them.
- **`lib/brain-sdk/`** (Phase 3 SDK-1, `7685833 feat: typed brain sdk
  with resilient telemetry`) — the Brain SDK that this Phase 4 SDK-1
  agent SDK depends on at runtime. The two are peers under
  `packages/`: `lumo-brain-sdk` (Phase 3) and `lumo-agent-sdk` (this
  sprint).
- **Mission state machine** (`db/migrations/023_durable_missions.sql`,
  `024_mission_confirmation_ready.sql`, `025_mission_rollback.sql`)
  — the substrate every agent invocation plugs into via
  `mission_steps.agent_id`.
- **`run_python_sandbox`** — E2B is already configured in production
  for the brain sandbox. SDK-1 extends E2B's role to the default agent
  runtime per ADR-013 §6.1.
- **`docs/developers/`** — 13-file docs pack (`appstore-platform.md`,
  `authoring-guide.md`, `oauth-integration.md`, `publishing.md`,
  `quickstart.md`, `sdk-reference.md`, `testing-your-agent.md`,
  `example-agents.md`, `faq.md`, `lumo-id-integration.md`,
  `open-api-agent-candidates.md`, `contributing.md`, `README.md`).
  These were drafted ahead of SDK-1; they reference the package by
  name. SDK-1 makes those docs runnable.
- **`app/publisher/page.tsx`, `lib/developer-platform-ui.ts`,
  `tests/developer-platform-ui.test.mjs`** (commit `06a31d5 feat:
  add developer platform launchpad`, 2026-04-28) — the publisher
  landing surface. SDK-1 makes the "Get the SDK" link on this page
  resolve to a real package.

---

## What this sprint adds

Six things, in dependency order. Each is a logical commit Codex can
review independently.

1. **`packages/lumo-agent-sdk@1.0.0`** — TypeScript package, exported
   types, runtime helpers, semver-pinned, no git+https.
2. **`bin/lumo-agent`** — CLI entrypoint with four subcommands:
   `init`, `dev`, `validate`, `submit`.
3. **Manifest validator** — `lumo-agent validate` and a programmatic
   `validateManifest()` helper. Enforces every rejection rule in
   ADR-013 §3.2.
4. **Local dev harness** — `lumo-agent dev` runs an agent against a
   mock Brain + mock connectors, hot-reloads on change. Default
   in-process for fast iteration; `--sandbox` flag exercises E2B
   locally.
5. **E2B sandbox runner** — production-equivalent invocation path that
   spawns an E2B sandbox, pipes the request envelope on stdin, reads
   the response on stdout, enforces the resource limits in ADR-013 §6.2.
6. **Migration 027** — `agent_lifecycle_events` and `agent_state` tables
   per ADR-013 §4 and §7. The SDK reads/writes these via a service-role
   helper; agents access `agent_state` via `ctx.state.get/set`.

SDK-1 does **not** include:
- The submission *server* (the endpoint `lumo-agent submit` POSTs to);
  that lives in MARKETPLACE-1 (Phase 4 W3 backend). For this sprint,
  `submit` POSTs to a stub endpoint that returns `501` until
  MARKETPLACE-1 lands. The CLI behaviour is otherwise final.
- The marketplace browse / install UX. That's MARKETPLACE-1.
- Reference agents in `samples/`. That's SAMPLE-AGENTS (Phase 4 W2).
- The permission grant UI. That's PERM-1 (Phase 4 W2-W3).

---

## Architecture

### Package layout

```
packages/lumo-agent-sdk/
├── package.json                # name: "@lumo/agent-sdk", version: "1.0.0"
├── tsconfig.json
├── README.md                   # mirrors Lumo_Agent_SDK/README.md, points at this in-tree package
├── src/
│   ├── index.ts                # public exports
│   ├── manifest/
│   │   ├── schema.ts           # zod schemas, generated from lumo-agent.json shape
│   │   ├── validator.ts        # validateManifest(input): Result
│   │   └── types.ts            # AgentManifest, AgentRequires, AgentCapability, AgentCostModel
│   ├── runtime/
│   │   ├── lumo-agent.ts       # LumoAgent class, defineAgent() helper
│   │   ├── ctx.ts              # ctx.brain, ctx.connectors, ctx.state, ctx.confirm, ctx.askUser, ctx.history
│   │   ├── envelope.ts         # AgentInvocationRequest / AgentInvocationResponse types + zod
│   │   └── errors.ts           # typed error envelope per ADR-013 §5.5
│   ├── harness/
│   │   ├── dev-server.ts       # in-process dev harness
│   │   ├── mock-brain.ts       # mock Brain SDK that returns fixture responses
│   │   ├── mock-connectors.ts  # mock connector dispatcher
│   │   └── reload.ts           # chokidar-based hot-reload
│   ├── sandbox/
│   │   ├── e2b-runner.ts       # spawn E2B, pipe envelope, enforce limits
│   │   └── policies.ts         # egress allowlist, timeout/memory caps
│   ├── cli/
│   │   ├── index.ts            # bin entry; routes subcommand
│   │   ├── init.ts             # scaffolds a new agent project
│   │   ├── dev.ts              # invokes harness/dev-server
│   │   ├── validate.ts         # invokes manifest/validator
│   │   └── submit.ts           # bundles tarball, POSTs to platform
│   └── helpers/
│       ├── idempotency.ts      # request_id → outcome short-circuit using ctx.state
│       └── confirmation.ts     # buildConfirmationCard(...): ConfirmationSummary
├── templates/
│   └── starter/                # scaffolded by `lumo-agent init`
│       ├── lumo-agent.json     # example manifest
│       ├── src/index.ts        # minimal entrypoint
│       ├── package.json
│       └── tsconfig.json
└── tests/
    ├── manifest-validator.test.mts
    ├── envelope.test.mts
    ├── ctx.test.mts
    ├── harness.test.mts
    ├── sandbox.test.mts
    └── cli/
        ├── init.test.mts
        ├── dev.test.mts
        ├── validate.test.mts
        └── submit.test.mts
```

The `packages/` directory is new at the repo root. `tsconfig.base.json`
gets a `paths` entry so the rest of the monorepo can `import { ... }
from "@lumo/agent-sdk"`. The git+https reference in the root
`package.json` is replaced with `"@lumo/agent-sdk": "workspace:*"`
(or the pnpm/npm equivalent the repo already uses).

### Public exports — `src/index.ts`

```ts
export {
  defineAgent,
  LumoAgent,
} from "./runtime/lumo-agent";

export {
  AgentManifest,
  AgentCapability,
  AgentRequires,
  AgentCostModel,
  AgentRuntime,
  AgentTrustTier,
} from "./manifest/types";

export { validateManifest, ManifestValidationError } from "./manifest/validator";

export {
  AgentInvocationRequest,
  AgentInvocationResponse,
  AgentInvocationStatus,
  ConfirmationCard,
  UserInputRequest,
  ProvenanceEvidence,
  CostActuals,
} from "./runtime/envelope";

export { AgentErrorCode, AgentError } from "./runtime/errors";

export { buildConfirmationCard } from "./helpers/confirmation";
export { withIdempotency } from "./helpers/idempotency";
```

### `LumoAgent` runtime class

```ts
import { defineAgent } from "@lumo/agent-sdk";

export default defineAgent({
  manifest: () => import("./lumo-agent.json"),
  capabilities: {
    summarize_unread_inbox: async (inputs, ctx) => {
      const recent = await ctx.brain.lumo_recall_unified({ ... });
      const messages = await ctx.connectors.gmail.listUnread({ ... });
      const summary = await ctx.brain.lumo_personalize_rank({ ... });
      return { ok: true, outputs: { summary } };
    },
  },
});
```

`ctx.brain` is a typed proxy whose method names are the union of
`manifest.requires.brain_tools`. Calls outside that allowlist are a
TypeScript error at compile time and a runtime `BRAIN_TOOL_NOT_GRANTED`
error if they get through.

`ctx.connectors` is the same shape for `manifest.requires.connectors`.

`ctx.state.get(key)` and `ctx.state.set(key, value)` are scoped by
`(user_id, agent_id)` per ADR-013 §7. The 10 MB limit is enforced
server-side by the trigger in migration 027; the client returns a
typed `STATE_QUOTA_EXCEEDED` error.

`ctx.confirm({ title, body, side_effect_summary, reversibility })`
returns the `needs_confirmation` envelope; the agent should `return`
it directly.

`ctx.askUser({ prompt, schema })` returns the `needs_user_input`
envelope; same pattern.

`ctx.history(missionId)` returns prior steps in the same mission via a
service-role helper. Read-only.

### CLI subcommands

| Command | Behaviour |
|---|---|
| `lumo-agent init [dir]` | Copies `templates/starter/` into `dir` (default `./my-agent`), prompts for `manifest.id`/`manifest.author.email`, runs `npm install`. |
| `lumo-agent dev` | Starts the in-process harness on port 4090, watches the entrypoint and manifest, reloads on change. `--sandbox` flag swaps the harness for the E2B runner. |
| `lumo-agent validate` | Runs `validateManifest()` against `./lumo-agent.json`. Exit 0 on pass, exit 1 on any rejection. Prints a numbered list of errors with file/line. |
| `lumo-agent submit` | Bundles entrypoint + dependencies + manifest into a tarball, signs with the author's submission key (read from `~/.lumo-agent/credentials`), POSTs to `https://api.lumo.rentals/v1/marketplace/submissions` (stub returns 501 until MARKETPLACE-1). Returns a tracking URL. |

### Manifest validator — rejection rules (ADR-013 §3.2)

The validator MUST reject:

1. Unknown `requires.brain_tools[]` — must match a tool registered in
   `lib/brain-sdk/` (validator queries `/api/_internal/brain-tools`
   manifest at validate time, or reads a vendored snapshot if offline).
2. Unknown `requires.connectors[]` — must match
   `lib/integrations/registry.ts`. Vendored snapshot fallback for offline.
3. Unknown `requires.scopes[]` — must match the ADR-014 scope
   taxonomy. (For SDK-1, ADR-014's scope list is vendored as
   `src/manifest/scope-taxonomy.json`. SDK consumes it; ADR-014's
   eventual API endpoint replaces the vendor in v1.1.)
4. `cost_model.max_cost_usd_per_invocation > 1.00` for
   `trust_tier_target` in `community` or `experimental`.
5. `trust_tier_target = "official"` without an authenticated Lumo-team
   author signature (the validator checks for a `LUMO_AUTHOR_SIGNATURE`
   env var or `~/.lumo-agent/credentials` Lumo-team flag; missing → reject).
6. Manifest schema violations (zod errors).
7. Unknown `runtime` (only `node18`, `python311`, `e2b` accepted in v1).
8. Capability `id` collision within the same manifest.
9. Capability scope superset — every entry in `capabilities[].scopes[]`
   MUST also appear in `requires.scopes[]`. The platform refuses
   scope-asks declared at capability granularity that the user wasn't
   asked to grant.
10. Manifest `sdk_version` requirement that does not satisfy the
    installed SDK's semver (e.g., manifest says `"^2.0.0"` while SDK is
    `1.0.0`).

Each rejection returns a typed `ManifestValidationError` with `code`
matching the rule number above for tooling consumers.

### Local dev harness

`lumo-agent dev` boots an Express-like server on port 4090. It exposes:

- `POST /invoke` — accepts an `AgentInvocationRequest` envelope, runs
  the agent's matching `capabilities[capability_id]` function with a
  mock `ctx`, returns the response envelope.
- `GET /manifest` — returns the parsed manifest as JSON.
- `GET /capabilities` — returns the capability list.
- `GET /healthz` — `{ ok: true, sdk_version: "1.0.0" }`.

Mock `ctx.brain` returns fixture responses from
`./fixtures/brain/<tool_name>.json` if the file exists; otherwise
returns a deterministic stub with a `__mock: true` marker.

Mock `ctx.connectors` returns fixture responses from
`./fixtures/connectors/<connector_id>/<method>.json`; same fallback
shape.

`ctx.state.get/set` is backed by an in-memory `Map` per dev session.
Survives hot-reload but not process restart.

`ctx.confirm` and `ctx.askUser` print the envelope to the dev terminal
in a readable form so the developer can see exactly what end users
will be asked.

`--sandbox` flag swaps the in-process harness for the E2B runner. Same
HTTP surface, real E2B sandbox underneath. Slower but exercises the
production code path. Nightly CI runs the sample agents under both
modes and asserts identical outputs (per ADR-013 §1 risk).

### E2B sandbox runner

`src/sandbox/e2b-runner.ts` exports `runInSandbox(request, agent):
Promise<AgentInvocationResponse>`:

1. Spawn an E2B sandbox with the runtime image matching
   `manifest.runtime` (`node18` → `lumo-agent-node18:latest`,
   `python311` → `lumo-agent-python311:latest`, `e2b` → generic
   sandbox).
2. Upload the agent bundle (entrypoint + dependencies) to the sandbox.
3. Inject `LUMO_*`-prefixed env vars only (per ADR-013 §6.2).
4. Pipe the request envelope to the bundle's stdin.
5. Set `wallClockTimeoutMs` from
   `manifest.capabilities[].timeout_ms_override` if present, else 60_000;
   memory limit from manifest if present, else 256 MB.
6. Configure egress allowlist: Brain SDK URL, every connector MCP URL
   in `requires.connectors`, `*.lumo.rentals`. Block everything else.
7. Read stdout to EOF, parse as `AgentInvocationResponse`.
8. Tear down the sandbox.
9. Return the response. Wrap any error in the typed error envelope per
   ADR-013 §5.5.

The E2B image build is out of scope for SDK-1; use the existing
`run_python_sandbox` image as the `python311` base, vendor a Node18
image alongside it.

### Migration 027

```sql
-- db/migrations/027_agent_lifecycle.sql

create table public.agent_lifecycle_events (
  id           bigint generated by default as identity primary key,
  user_id      uuid references public.profiles(id) on delete cascade,
  agent_id     text not null,
  agent_version text not null,
  event_type   text not null,
  evidence     jsonb not null default '{}'::jsonb,
  created_at   timestamptz not null default now()
);

create index agent_lifecycle_events_by_user_agent
  on public.agent_lifecycle_events (user_id, agent_id, created_at desc);

create table public.agent_state (
  user_id    uuid not null references public.profiles(id) on delete cascade,
  agent_id   text not null,
  key        text not null,
  value      jsonb not null,
  size_bytes integer not null default 0,
  updated_at timestamptz not null default now(),
  primary key (user_id, agent_id, key)
);

create index agent_state_size_check
  on public.agent_state (user_id, agent_id);

-- Quota trigger: 10 MB per (user, agent) per ADR-013 §7
create or replace function public.enforce_agent_state_quota()
returns trigger language plpgsql as $$
declare
  total_bytes bigint;
begin
  select coalesce(sum(size_bytes), 0)
    into total_bytes
    from public.agent_state
    where user_id = new.user_id
      and agent_id = new.agent_id
      and (TG_OP = 'INSERT' or key <> new.key);
  if total_bytes + new.size_bytes > 10 * 1024 * 1024 then
    raise exception 'STATE_QUOTA_EXCEEDED'
      using hint = format(
        'agent %s for user %s would exceed 10 MB cap',
        new.agent_id, new.user_id
      );
  end if;
  return new;
end$$;

create trigger agent_state_quota_check
  before insert or update on public.agent_state
  for each row execute function public.enforce_agent_state_quota();

-- service-role-only access; RLS off (helpers run as service role)
alter table public.agent_lifecycle_events enable row level security;
alter table public.agent_state enable row level security;

-- No policies = deny by default for non-service-role connections.
-- The Brain-SDK-style helper in lib/agent-state.ts uses the service-role key.
```

The migration also must be re-runnable safely — check for the
`if not exists` pattern across every `create`.

### Service-role helpers

Two new files in `lib/` (the platform side, not the SDK package):

- `lib/agent-lifecycle.ts` — `recordLifecycleEvent({ user_id, agent_id,
  agent_version, event_type, evidence })`. Called from the orchestrator
  on every invocation, install, configure, revoke, uninstall.
- `lib/agent-state.ts` — `getAgentStateValue({ user_id, agent_id, key })`
  and `setAgentStateValue({ user_id, agent_id, key, value })`. Called
  from the SDK runtime via the service-JWT-signed callback path.

Both files use the existing service-role Supabase client.

---

## State transitions / lifecycle ownership

SDK-1 owns these lifecycle events (per ADR-013 §4):

| Event | Trigger |
|---|---|
| `lifecycle_register` | `lumo-agent submit` succeeds (stub returns 501 until MARKETPLACE-1; for SDK-1 testing, this fires from a local mock submit endpoint) |
| `lifecycle_invoked` | Every `mission_steps` dispatch where `agent_id` matches a manifest |

The other six lifecycle events (`published`, `installed`, `configured`,
`active`, `revoked`, `uninstalled`) are owned by MARKETPLACE-1, PERM-1,
and TRUST-1. SDK-1 only writes the two it generates.

---

## Failure modes + error envelope

The SDK exports `AgentError` with the codes from ADR-013 §5.5. Every
`error.code` is a string union; consumers (the orchestrator's
dispatcher, the dev harness, the E2B runner) all switch on it.

The dev harness surfaces errors with their code, message, and
`retryable` flag. `--verbose` adds a stack and the offending
manifest field if the error is a manifest violation.

The E2B runner translates sandbox-level failures into typed errors:
- `EXIT_CODE != 0` with stderr containing `OOM` → `SANDBOX_OOM`.
- Wall-clock exceeded → `SANDBOX_TIMEOUT` with `retryable: true`.
- Egress blocked at firewall → `EGRESS_BLOCKED`.
- stdout not parseable as `AgentInvocationResponse` → `INTERNAL_ERROR`
  with the parse error text.

---

## Testing

### Unit tests (per file under `tests/`)

- **manifest-validator** — every rejection rule in §"Manifest validator
  rejection rules" has at least one passing-and-failing fixture.
  Coverage target: 100% on `validator.ts`.
- **envelope** — round-trip every status (`succeeded`, `needs_confirmation`,
  `needs_user_input`, `failed`) through zod parse → serialise → parse.
- **ctx** — mock `ctx.brain` rejects calls outside the allowlist with
  `BRAIN_TOOL_NOT_GRANTED`; same for `ctx.connectors`. `ctx.state`
  honours the 10 MB cap (using a stubbed driver, since the trigger
  is server-side).
- **harness** — boots, accepts a request, returns a response. Hot-reload
  picks up an entrypoint change without restart.
- **sandbox** — happy path: agent runs, returns response. Egress blocked:
  agent attempts to fetch `https://google.com`, sandbox blocks, error
  is `EGRESS_BLOCKED`. Timeout: agent sleeps past wall-clock cap, error
  is `SANDBOX_TIMEOUT`. (The egress and timeout tests run under a real
  E2B sandbox in CI; locally they're skipped if no E2B key is present.)
- **cli/init** — scaffolds the starter, the resulting project's
  `lumo-agent validate` exits 0.
- **cli/validate** — every rejection rule fires the right exit code.
- **cli/dev** — starts on port 4090, GET `/healthz` returns 200.
- **cli/submit** — bundles a tarball, POSTs to a stub server, prints
  the tracking URL.

Coverage target: SDK package overall ≥ 80% (per ADR-013 §11.5).

### Integration test

A new file `tests/agent-sdk-integration.test.mjs` at the repo root
(not inside the package) that:

1. Scaffolds a fresh agent in a temp dir via `lumo-agent init`.
2. Adds a single capability that calls `ctx.brain.lumo_recall_unified`
   (mocked) and returns a summary.
3. Starts `lumo-agent dev` in a child process.
4. POSTs a synthetic `AgentInvocationRequest` to `localhost:4090/invoke`.
5. Asserts the response envelope is well-formed and `status: succeeded`.
6. Tears down.

This test is the SDK's analogue of the Sprint-3-D4 mission worker
integration test — it validates the full request/response loop end-to-end.

### Manual / preview test (the Phase-4 ship-gate proof point)

A non-Lumo developer (recruited for the Phase 4 ship-gate run, see
`phase-4-master.md` §"Ship gate") follows `docs/developers/quickstart.md`
and `docs/developers/sdk-reference.md` only. No core source. They
publish to `community` tier via `lumo-agent submit` (against the
MARKETPLACE-1 submission server, not SDK-1's stub — SDK-1 alone cannot
ship this proof point; it requires MARKETPLACE-1 too).

The SDK-1 acceptance bar for this proof point is local-only: the
developer can scaffold, validate, and dev-loop their agent without
help. The full publish path waits on MARKETPLACE-1.

---

## Acceptance

SDK-1 is shippable when:

1. `packages/lumo-agent-sdk@1.0.0` exists at the path above; the root
   `package.json` references it as `workspace:*`; the prior git+https
   reference is gone; `npm install` from a clean clone succeeds.
2. All four CLI commands (`init`, `dev`, `validate`, `submit`) work
   end-to-end against the test fixtures. `submit` returning 501 from
   the stub server is the expected behaviour for SDK-1.
3. `lumo-agent validate` rejects the documented invalid manifests
   (one fixture per rejection rule above) and accepts the documented
   valid manifest.
4. `lumo-agent dev` runs an agent against mock Brain + mock connectors
   on port 4090. Hot-reload triggers on `lumo-agent.json` or
   `src/index.ts` change without restart.
5. `lumo-agent dev --sandbox` reproduces the production E2B environment
   within reasonable fidelity. The egress allowlist is enforced; an
   agent that tries to fetch an off-allowlist URL gets
   `EGRESS_BLOCKED`. CI runs the sample fixture under both modes and
   asserts identical outputs.
6. Migration 027 applied to staging Supabase; the quota trigger
   refuses an 11 MB write to `agent_state` and accepts a 9 MB write.
7. Unit coverage on the SDK package ≥ 80%; integration test passes.
8. Time-to-first-agent for a non-Lumo developer measured at < 1 day —
   measured locally for SDK-1 (scaffold → validate → dev-loop), not
   end-to-end through publish (that requires MARKETPLACE-1).
9. `npm test` and `npm run typecheck` and `npm run build` all pass at
   the repo root.
10. Two commits land on `main` (per repo policy — no feature branch):
    - `feat(sdk): add lumo-agent-sdk@1.0.0 package and CLI` (the bulk).
    - `feat(db): add migration 027 agent lifecycle and state` (the
      schema, separate so it can be rolled back independently).

---

## Open questions to escalate to Kalas

These are deferred to Kalas-review per ADR-013 §12 — Codex should
implement the recommended option and surface the question in the PR
description if any of them feels load-bearing in implementation.

1. **Python311 runtime in v1?** ADR-013 recommends Node18 only, with
   Python311 in v1.5 if the ship gate hits the < 1-day target with
   Node alone. SDK-1 implements Node18 first-class; the manifest
   validator accepts `runtime: "python311"` as a string but the
   E2B runner returns `INTERNAL_ERROR` with `not_supported_in_v1` if
   asked to run one. SAMPLE-AGENTS (next sprint) is all Node18.
2. **Mandatory E2B for community-tier?** ADR-013 §6.1 says yes. SDK-1
   enforces this in the SDK runner; an agent with `trust_tier_target:
   "community"` cannot opt out of `--sandbox` in production. The dev
   harness still defaults to in-process for fast iteration.
3. **How does the SDK find the platform's brain-tools / connectors /
   scopes registry at validate time?** ADR-013 §3.2 implies the validator
   queries the platform; for SDK-1 the registry is vendored at build
   time as JSON in `src/manifest/`. The vendored snapshot is regenerated
   by a CI step that runs against staging once a day. v1.1 replaces the
   vendor with an HTTP call to `/api/_internal/agent-registry`.

---

## Out of scope for SDK-1

- Submission server (MARKETPLACE-1, Phase 4 W3 backend).
- Marketplace browse / install / uninstall UX (MARKETPLACE-1 W4 UI).
- Three reference agents (SAMPLE-AGENTS, Phase 4 W2).
- Permissions UI + scope-grant flow (PERM-1, Phase 4 W2-W3).
- Cost metering and budgets (COST-1, Phase 4 W4).
- Manual review pipeline tooling (TRUST-1, Phase 4 W5).
- developers.lumo.rentals docs site build (DOCS, Phase 4 W5; SDK-1
  produces the in-tree `docs/developers/` content the docs site
  publishes from, but that site is built in a separate sprint).
- Python311 runtime support beyond manifest acceptance.
- `agent-bundles` Supabase Storage bucket creation (MARKETPLACE-1).
- Author-key signing infrastructure (MARKETPLACE-1; SDK-1's `submit`
  reads `~/.lumo-agent/credentials` for the key but the platform
  doesn't yet verify signatures).

---

## File map

New files (the SDK package):

- `packages/lumo-agent-sdk/package.json`
- `packages/lumo-agent-sdk/tsconfig.json`
- `packages/lumo-agent-sdk/README.md`
- `packages/lumo-agent-sdk/src/index.ts`
- `packages/lumo-agent-sdk/src/manifest/schema.ts`
- `packages/lumo-agent-sdk/src/manifest/validator.ts`
- `packages/lumo-agent-sdk/src/manifest/types.ts`
- `packages/lumo-agent-sdk/src/manifest/scope-taxonomy.json`
- `packages/lumo-agent-sdk/src/runtime/lumo-agent.ts`
- `packages/lumo-agent-sdk/src/runtime/ctx.ts`
- `packages/lumo-agent-sdk/src/runtime/envelope.ts`
- `packages/lumo-agent-sdk/src/runtime/errors.ts`
- `packages/lumo-agent-sdk/src/harness/dev-server.ts`
- `packages/lumo-agent-sdk/src/harness/mock-brain.ts`
- `packages/lumo-agent-sdk/src/harness/mock-connectors.ts`
- `packages/lumo-agent-sdk/src/harness/reload.ts`
- `packages/lumo-agent-sdk/src/sandbox/e2b-runner.ts`
- `packages/lumo-agent-sdk/src/sandbox/policies.ts`
- `packages/lumo-agent-sdk/src/cli/index.ts`
- `packages/lumo-agent-sdk/src/cli/init.ts`
- `packages/lumo-agent-sdk/src/cli/dev.ts`
- `packages/lumo-agent-sdk/src/cli/validate.ts`
- `packages/lumo-agent-sdk/src/cli/submit.ts`
- `packages/lumo-agent-sdk/src/helpers/idempotency.ts`
- `packages/lumo-agent-sdk/src/helpers/confirmation.ts`
- `packages/lumo-agent-sdk/templates/starter/lumo-agent.json`
- `packages/lumo-agent-sdk/templates/starter/src/index.ts`
- `packages/lumo-agent-sdk/templates/starter/package.json`
- `packages/lumo-agent-sdk/templates/starter/tsconfig.json`
- `packages/lumo-agent-sdk/tests/manifest-validator.test.mts`
- `packages/lumo-agent-sdk/tests/envelope.test.mts`
- `packages/lumo-agent-sdk/tests/ctx.test.mts`
- `packages/lumo-agent-sdk/tests/harness.test.mts`
- `packages/lumo-agent-sdk/tests/sandbox.test.mts`
- `packages/lumo-agent-sdk/tests/cli/init.test.mts`
- `packages/lumo-agent-sdk/tests/cli/dev.test.mts`
- `packages/lumo-agent-sdk/tests/cli/validate.test.mts`
- `packages/lumo-agent-sdk/tests/cli/submit.test.mts`

New files (platform side):

- `lib/agent-lifecycle.ts`
- `lib/agent-state.ts`
- `db/migrations/027_agent_lifecycle.sql`
- `tests/agent-sdk-integration.test.mjs`

Modified files:

- `package.json` (root) — replace git+https reference with workspace
  reference; add `packages/*` to workspaces array.
- `tsconfig.base.json` — add path alias for `@lumo/agent-sdk`.
- `vercel.json` — register the new test entrypoint if needed.
- `docs/specs/lumo-intelligence-layer.md` — small ADR addendum noting
  SDK-1 ships and the in-tree package supersedes `Lumo_Agent_SDK`.

Touched read-only (verification only):

- `lib/orchestrator.ts`
- `lib/registry-config.ts`
- `lib/service-jwt.ts`
- `lib/brain-sdk/index.ts`
- `lib/integrations/registry.ts`
- `Lumo_Agent_SDK/` (separate repo — flagged for archival in a follow-up
  PR, not touched in this sprint)
