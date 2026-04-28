# ADR-013 — Agent Runtime Contract

**Status:** Proposed (drafted 2026-04-27, Phase 4). Codex SDK-1 implements against this ADR.
**Authors:** Coworker M (architecture pass), to be reviewed by Kalas (CEO/CTO/CFO).
**Related:** `docs/specs/phase-4-outlook.md` (platform thesis),
`docs/specs/phase-3-master.md` (durable mission substrate that agents plug into),
`docs/specs/adr-014-agent-permissions-capabilities.md` (security gate),
`docs/specs/adr-015-marketplace-distribution-trust-tiers.md` (distribution),
`docs/specs/adr-016-agent-cost-metering-budgets.md` (cost gate),
`db/migrations/023_durable_missions.sql`, `024_mission_confirmation_ready.sql`,
`025_mission_rollback.sql`, `lib/orchestrator.ts`, `lib/registry-config.ts`,
`lib/service-jwt.ts`, `lib/brain-sdk/`.
**Implements:** the binding definition of what a Lumo Agent IS — the
manifest, the lifecycle, the invocation contract, the sandbox boundary,
and the runtime guarantees the platform makes to agent authors and to
end users.

---

## 1. Context

Phase 3 ships durable missions, voice presence, and a typed Brain SDK.
The system today still treats every "agent" as a hand-coded module
inside `lib/`. New agent capabilities ship as feature flags in the core
repo, dispatched through `lib/orchestrator.ts`, configured via the
`registry-config.ts` agent list. This works for the small set of
Lumo-built agents but does not scale to a marketplace of third-party
agents — and the `@lumo/agent-sdk` git+https dependency in
`package.json` is currently a stub.

For the platform thesis to materialise — "Lumo is the OS, agents are
apps, the marketplace and permission model are the platform" — the
runtime contract has to exist as a versioned, manifest-described,
sandboxed unit of automation that an external developer can build
against without changing a single file in the core repo.

ADR-013 defines that contract. It is the first of four Phase-4 ADRs
(013 runtime, 014 permissions, 015 distribution, 016 cost). It is the
foundation; the other three reference it.

The decision space is intentionally bounded. We are not designing a
general-purpose actor system, a workflow engine, or a microservice
framework. We are designing a sandboxed, manifest-described unit of
automation that plugs into the existing mission state machine.

---

## 2. Definition

A Lumo Agent is a versioned, manifest-described, sandboxed unit of
automation that:

1. **Declares capabilities** — a static, machine-readable list of
   what the agent can do, expressed as Lumo scope strings (ADR-014).
   The list is the only basis on which the user grants permission.
2. **Requires explicit user consent** — no agent runs without an
   `installed` row in `agent_installs` plus a non-empty set of
   `agent_scope_grants`. There is no default-on agent in Phase 4.
3. **Plugs into the mission state machine** — every invocation is
   one or more `mission_steps` rows with `agent_id` set. The
   forward executor (D4) and rollback executor (D5) handle agents
   identically to any other tool.
4. **Is invoked through a typed contract** — JSON-RPC over a
   service-JWT-signed POST. Inputs and outputs are declared in the
   manifest; the platform validates both ends.
5. **Emits provenance for every action** — every side-effecting
   action writes an `agent_action_audit` row (ADR-014) and, if the
   action mutates user data, a `mission_execution_events` row.
6. **Has bounded cost** — a manifest-declared per-invocation
   ceiling and a platform-enforced per-user budget (ADR-016).

What an agent is NOT:

- Not a connector. A connector is a long-lived OAuth-backed
  integration to a third-party service (Gmail, Calendar, Plaid). An
  agent calls connectors via `requires.connectors`. Connectors live
  in `lib/integrations/` and are out of scope here.
- Not a Brain tool. A Brain tool is a typed ML capability exposed
  by `Lumo_ML_Service` and called via the Brain SDK. An agent calls
  Brain tools via `requires.brain_tools`. Brain tools have their
  own ADRs (008-012) and are out of scope here.
- Not a chat handler. The orchestrator is the chat handler. Agents
  are invoked by the orchestrator (via the mission planner) when an
  intent maps onto a manifest-declared capability.

This separation is load-bearing. An agent author writes the manifest
plus the entrypoint and gets connectors, Brain tools, and orchestrator
routing for free. The platform's job is to make those three things
work uniformly across every agent.

---

## 3. Manifest schema — `lumo-agent.json`

Every agent ships a `lumo-agent.json` at its repository root.
The file is the source of truth for everything the platform knows
about the agent. The manifest is validated by `lumo-agent validate`
(SDK CLI) on submission and re-validated server-side on upload.

### 3.1 TypeScript type

```ts
export type AgentRuntime = "node18" | "python311" | "e2b";
export type AgentTrustTier =
  | "official"
  | "verified"
  | "community"
  | "experimental";

export interface AgentCostModel {
  /** Hard ceiling per invocation in USD. Platform refuses if exceeded. */
  max_cost_usd_per_invocation: number;
  /** Optional model-token cost shape; informational for budgets UI. */
  per_token_usd?: { input: number; output: number };
  /** Flat per-invocation cost (e.g., a paid third-party API call). */
  per_invocation_usd?: number;
  /** Connector calls expected per invocation; informational. */
  expected_connector_calls?: number;
}

export interface AgentRequires {
  /** Brain tools the agent is allowed to call. */
  brain_tools: string[];
  /** Connector ids the agent is allowed to call (must match registry). */
  connectors: string[];
  /** Lumo scope strings the user must grant on install (ADR-014). */
  scopes: string[];
  /** Required minimum SDK version (semver range). */
  sdk_version: string;
}

export interface AgentCapability {
  /** Stable id, used in the consent UI and audit rows. */
  id: string;
  /** Plain-English text the user reads on the consent screen. */
  description: string;
  /** Scopes used by this capability (subset of requires.scopes). */
  scopes: string[];
  /** True if invocation has external side effects (writes, sends). */
  side_effect: boolean;
}

export interface AgentManifest {
  id: string;                        // kebab-case, globally unique
  version: string;                   // semver
  name: string;                      // display name
  description: string;               // one-paragraph
  author: { name: string; email: string; url?: string };
  repository: string;                // git URL
  entrypoint: string;                // relative path, e.g. "dist/index.js"
  runtime: AgentRuntime;
  requires: AgentRequires;
  capabilities: AgentCapability[];
  cost_model: AgentCostModel;
  trust_tier_target: AgentTrustTier;
  homepage: string;
  support_url: string;
  privacy_url: string;
  data_retention_policy: string;     // human-readable, surfaced in UI
}
```

### 3.2 Example — `summarize-emails-daily`

```json
{
  "id": "summarize-emails-daily",
  "version": "1.2.0",
  "name": "Daily Email Summary",
  "description": "Each morning, summarises unread emails into three bullets per thread and groups by sender importance.",
  "author": {
    "name": "Acme Labs",
    "email": "agents@acme.example",
    "url": "https://acme.example"
  },
  "repository": "https://github.com/acme/summarize-emails-daily",
  "entrypoint": "dist/index.js",
  "runtime": "node18",
  "requires": {
    "brain_tools": ["lumo_recall_unified", "lumo_personalize_rank"],
    "connectors": ["gmail"],
    "scopes": [
      "read.email.headers",
      "read.email.bodies",
      "read.contacts"
    ],
    "sdk_version": "^1.0.0"
  },
  "capabilities": [
    {
      "id": "summarize_unread_inbox",
      "description": "Reads your unread Gmail and produces a morning digest. Read-only.",
      "scopes": ["read.email.headers", "read.email.bodies", "read.contacts"],
      "side_effect": false
    }
  ],
  "cost_model": {
    "max_cost_usd_per_invocation": 0.04,
    "per_token_usd": { "input": 0.000003, "output": 0.000015 },
    "expected_connector_calls": 5
  },
  "trust_tier_target": "verified",
  "homepage": "https://acme.example/agents/summarize-emails-daily",
  "support_url": "https://acme.example/support",
  "privacy_url": "https://acme.example/privacy",
  "data_retention_policy": "Email content is processed in-memory and never persisted. Summary text persists in your Lumo workspace until you delete it."
}
```

The manifest validator rejects:

- unknown `brain_tools` (must match a tool registered with the
  Brain SDK),
- unknown `connectors` (must match `lib/integrations/registry.ts`),
- unknown `scopes` (must match the ADR-014 scope taxonomy),
- `max_cost_usd_per_invocation > 1.00` for community/experimental
  tiers (verified/official may exceed with review),
- `trust_tier_target = official` without an authenticated
  Lumo-team author signature.

---

## 4. Lifecycle

Every agent moves through nine states. Each transition writes a row
to a new `agent_lifecycle_events` table:

```
register → published → installed → configured → active → invoked
                                                ↓
                                              revoked → uninstalled
```

| State | Trigger | Audit row |
|---|---|---|
| `register` | Developer runs `lumo-agent submit` | `lifecycle_register` |
| `published` | Marketplace review pipeline approves | `lifecycle_published` |
| `installed` | User taps Install on marketplace tile | `lifecycle_installed` |
| `configured` | User completes scope-grant flow | `lifecycle_configured` |
| `active` | First successful invocation | `lifecycle_active` |
| `invoked` | Each mission_step dispatch | `lifecycle_invoked` |
| `revoked` | User taps Revoke | `lifecycle_revoked` |
| `uninstalled` | User taps Uninstall (or revoke + cleanup) | `lifecycle_uninstalled` |

Schema sketch (Codex codifies in migration 027):

```sql
create table public.agent_lifecycle_events (
  id           bigint generated by default as identity primary key,
  user_id      uuid references public.profiles(id) on delete cascade,
  agent_id     text not null,
  agent_version text not null,
  event_type   text not null,                  -- enumerated above
  evidence     jsonb not null default '{}'::jsonb,
  created_at   timestamptz not null default now()
);

create index agent_lifecycle_events_by_user_agent
  on public.agent_lifecycle_events (user_id, agent_id, created_at desc);
```

Two states are platform-only (`register`, `published`); the rest are
per-user. An agent can be `active` for one user and `revoked` for
another. The `invoked` event is the most frequent and is the basis for
cost metering (ADR-016).

---

## 5. Invocation contract

The orchestrator already creates `mission_steps` with `agent_id` and
`tool_name` set (see migration 023). Agents extend that contract: the
`agent_id` matches a manifest id, the `tool_name` matches a
manifest-declared capability id.

### 5.1 Request envelope

```ts
export interface AgentInvocationRequest {
  request_id: string;             // uuid, idempotency key
  mission_id: string;             // uuid
  mission_step_id: string;        // uuid
  user_id: string;                // uuid
  agent_id: string;
  agent_version: string;          // exact semver of installed version
  capability_id: string;          // matches manifest.capabilities[].id
  inputs: Record<string, unknown>;// validated against manifest schema
  granted_scopes: string[];       // intersected with manifest.requires.scopes
  budgets: {
    remaining_user_daily_usd: number;
    remaining_user_monthly_usd: number;
    max_cost_usd_per_invocation: number;
  };
  service_jwt: string;            // signed by lib/service-jwt.ts
  trace_id: string;               // for distributed tracing
}
```

### 5.2 Response envelope

```ts
export interface AgentInvocationResponse {
  request_id: string;
  status: "succeeded" | "needs_confirmation" | "needs_user_input" | "failed";
  outputs?: Record<string, unknown>;
  /** Required if status === 'needs_confirmation'. */
  confirmation_card?: {
    title: string;
    body: string;
    side_effect_summary: string;
    reversibility: "reversible" | "compensating" | "irreversible";
    expires_at: string;          // iso-8601
  };
  /** Required if status === 'needs_user_input'. */
  user_input_request?: { prompt: string; schema: unknown };
  /** Always required for any side-effecting action. */
  provenance_evidence: {
    sources: Array<{ type: string; ref: string; hash?: string }>;
    citations?: string[];
    redaction_applied: boolean;
  };
  cost_actuals: {
    total_usd: number;
    brain_calls_usd: number;
    model_tokens: number;
    model_tokens_cost_usd: number;
    connector_calls: number;
  };
  error?: { code: string; message: string; retryable: boolean };
}
```

### 5.3 What agents can do

Inside an invocation, the agent may:

- **Call Brain tools** via the Brain SDK. The SDK's service-JWT is
  scoped to the agent's `requires.brain_tools` allowlist; calls to
  unlisted tools fail with `BRAIN_TOOL_NOT_GRANTED`.
- **Call connector MCPs** via the connector dispatcher. Same allowlist
  semantics; calls to unlisted connectors fail with
  `CONNECTOR_NOT_GRANTED`.
- **Request user confirmation** by returning `status:
  needs_confirmation` with a `confirmation_card`. The platform
  inserts the card into the existing confirmation-card system and
  links it via `mission_steps.confirmation_card_id` (migration 024).
  The mission step transitions to `awaiting_confirmation`.
- **Request user input** by returning `status: needs_user_input`. The
  mission state transitions to `awaiting_user_input` (existing,
  migration 023).

What agents may NOT do, ever:

- Call other agents directly. Agent-to-agent dispatch goes through the
  orchestrator's mission planner. This preserves the audit chain.
- Read or write arbitrary database rows. The only persistent storage
  exposed is the per-agent KV namespace (§7).
- Open arbitrary network connections. The sandbox enforces an egress
  allowlist (§6.2).
- Spawn child processes, load native modules, or call `eval` /
  `Function`.

### 5.4 Retry and idempotency

- The platform retries a failed invocation up to 3 times with
  exponential backoff (1s, 4s, 16s) **only if** the response carried
  `error.retryable === true` or no response was received.
- Every retry carries the **same `request_id`**. Agents MUST be
  idempotent on retry within a 24-hour window. The platform offers
  the per-agent KV namespace (§7) as a place to record
  `request_id → outcome` for the agent to short-circuit duplicate
  work.
- Side-effecting capabilities that cannot be made idempotent must
  declare `side_effect: true` on the capability and return
  `needs_confirmation` so the user — not the retry policy — drives
  re-execution.

### 5.5 Error envelope

Errors are typed:

| `error.code` | Meaning | `retryable` |
|---|---|---|
| `BRAIN_TOOL_NOT_GRANTED` | Agent called an unlisted brain tool | false |
| `CONNECTOR_NOT_GRANTED` | Agent called an unlisted connector | false |
| `SCOPE_NOT_GRANTED` | Agent attempted a non-granted scope | false |
| `BUDGET_EXCEEDED` | Per-invocation or per-user cap hit | false |
| `SANDBOX_TIMEOUT` | Wall-clock or CPU limit hit | true (with caveats) |
| `SANDBOX_OOM` | Memory limit hit | false |
| `EGRESS_BLOCKED` | Outbound network call to non-allowlisted host | false |
| `INPUT_VALIDATION_FAILED` | Inputs did not match manifest schema | false |
| `INTERNAL_ERROR` | Uncategorised failure | true |

---

## 6. Sandbox boundary

### 6.1 Where each tier runs

| Tier | Default runtime | Notes |
|---|---|---|
| `experimental` | E2B | Always sandboxed. Loud user warning. |
| `community` | E2B | Always sandboxed. |
| `verified` | E2B | Sandboxed unless review explicitly approves in-process. |
| `official` | In-process (Node) | Allowed only after security review (§6.3). |

E2B is configured in production today for `run_python_sandbox`; ADR-013
extends its use as the default agent runtime. Node18 and Python311
runtimes both run in E2B unless the official-tier carve-out applies.

### 6.2 Sandbox capability set

The sandbox enforces:

| Resource | Limit |
|---|---|
| Wall-clock timeout | 60 s default; capability-declared override up to 300 s |
| CPU time | 30 s of CPU at 100% (E2B-enforced) |
| Memory | 256 MB default; capability-declared override up to 1 GB |
| Disk | 100 MB scratch space; wiped at invocation end |
| Network egress | Allowlist: Brain SDK URL, connector MCP endpoints declared in `requires.connectors`, `*.lumo.rentals` |
| `eval` / `Function` | Forbidden; lint and runtime block |
| Native modules | Forbidden; bundler refuses |
| Filesystem (host) | No access; only the sandbox scratch directory |
| Subprocess spawn | Forbidden (Python `subprocess`, Node `child_process`) |
| Environment access | Only `LUMO_*`-prefixed vars injected by the platform |

The CI test for an agent's manifest exercises a synthetic egress to an
off-allowlist host; the test fails closed if egress succeeds.

### 6.3 Official-tier in-process carve-out

An `official`-tier agent may run in-process for performance, but only
after:

1. Full source review by Lumo security.
2. Sign-off recorded in `agent_security_reviews` table (added by
   Codex in TRUST-1).
3. The agent module is loaded via the existing `registry-config.ts`
   path with `system: true` flag set (the existing Lumo-only policy
   bit).

In-process agents still emit the same audit, cost, and provenance
rows. The carve-out is performance-only.

---

## 7. Per-agent state storage

Every (user, agent) pair gets an isolated key-value namespace:

```sql
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
```

Constraints:

- **Strict isolation.** Agent X cannot read or write Agent Y's state.
  The Brain SDK's KV helper (`ctx.state.get` / `ctx.state.set`) is
  scoped at the service-JWT layer.
- **Maximum 10 MB per (user, agent) pair** in v1. Enforced by a
  `BEFORE INSERT/UPDATE` trigger summing `size_bytes`. Over-quota
  writes fail with `STATE_QUOTA_EXCEEDED`.
- **No shared global state.** There is no cross-user, cross-agent
  KV. If an agent needs cross-user data (e.g., a public dataset),
  it must fetch it via an allowlisted egress.
- **Deletion-respecting.** Cascade on `profiles.id` delete.

The KV is intended for small structured state — preferences, last-run
timestamps, idempotency markers. Agents needing larger storage should
emit data into user-visible surfaces (mission outputs, drafted
messages) rather than expanding the KV.

---

## 8. Agent ↔ Core communication protocol

JSON-RPC 2.0 over HTTPS POST. One request, one response. No streaming
in v1; the agent collects its full response and returns once.

### 8.1 Authentication

Every request from Core to an agent carries:

- `Authorization: Bearer <service-jwt>` — signed by `lib/service-jwt.ts`.
  Claims include `agent_id`, `agent_version`, `user_id`, `mission_id`,
  `request_id`, and an `exp` 5 minutes in the future.
- `X-Lumo-Trace-Id` — for distributed tracing.

Every callback from an agent to Core (Brain SDK call, connector call)
must carry the same JWT. The platform refuses callbacks whose
`agent_id` does not match the JWT's `agent_id`.

### 8.2 Endpoints

For E2B-sandboxed agents, the entrypoint is invoked via an E2B
`spawn` with the request envelope on stdin. The agent writes the
response envelope to stdout and exits.

For in-process official agents, the entrypoint exports a function
`async function invoke(request: AgentInvocationRequest):
Promise<AgentInvocationResponse>`. The orchestrator awaits this
directly.

For future remote-hosted agents (Phase 5+), the entrypoint is a URL
and the request is a plain HTTPS POST. Phase 4 does NOT ship remote
hosting — all agents run inside Lumo's E2B or in-process. This keeps
the security review surface small in v1.

---

## 9. Versioning and rollback

Semver, strict.

| Bump | Auto-update behaviour |
|---|---|
| Patch (`1.2.0 → 1.2.1`) | Auto-installs for all users on next invocation. No re-consent. |
| Minor (`1.2.0 → 1.3.0`) | Re-consent required if `requires.scopes` or `requires.connectors` changed. Auto-install otherwise. |
| Major (`1.2.0 → 2.0.0`) | Re-consent always required. User can stay on the old major until they re-consent. |

Version pinning: the user can pin via the marketplace UI to a specific
version; the platform respects the pin until the user changes it or
the version is yanked (§9.2).

### 9.1 Rollback

The marketplace can yank a published version if:

- The version triggers an error rate > **2%** across 24 hours, OR
- A critical security issue is reported and triaged.

A yank flips `marketplace_agents.yanked = true` and forces all users
on that version to fall back to the latest non-yanked patch in the
same minor (or major, if no patch exists). The fallback is invisible
to the user except for a one-time toast.

### 9.2 Immutability

Published versions are **immutable**. A bug in `1.2.0` is fixed by
publishing `1.2.1`, not by mutating `1.2.0`. The `agent-bundles`
storage bucket (ADR-015) enforces this with object-lock.

---

## 10. Trust tiers (full ADR in 015, summary here)

| Tier | Distribution | Default sandbox | UI badge |
|---|---|---|---|
| `official` | Lumo-built; published via internal pipeline | In-process allowed after review | Lumo logo |
| `verified` | Third-party; passed 5-day human review | E2B (default) | Verified check |
| `community` | Third-party; passed automated checks | E2B | Community |
| `experimental` | Third-party; user installs at own risk | E2B + warning banner | Experimental |

Each tier maps to a distribution route, a UI badge, and a default
permission posture. ADR-015 documents the review process and the
promotion SLAs in detail.

---

## 11. SDK v1 acceptance criteria

The Phase-4 SDK ships when:

1. **Package** `packages/lumo-agent-sdk` published. Replaces the
   `@lumo/agent-sdk` git+https stub in `package.json`. Versioned
   `1.0.0` at first release.
2. **Three reference agents** in `samples/`:
   - `summarize-emails-daily` (verified-tier example, read-only).
   - `lumo-rentals-trip-planner` (official-tier example,
     side-effecting, exercises confirmation card).
   - `weather-now` (experimental-tier example, smallest possible).
3. **Local dev harness** — `lumo-agent dev` runs the agent against
   a mock Brain SDK and a mock connector dispatcher. Hot-reloads on
   manifest or entrypoint change.
4. **Manifest validator** — `lumo-agent validate` exits non-zero on
   any of the rejection conditions in §3.2.
5. **Tests** — unit coverage ≥ 80% on the SDK; integration test
   exercises the request/response envelope, the sandbox boundary,
   and the per-agent KV.
6. **External-developer time-to-first-agent** — measured during
   Phase-4 ship gate (Codex runs this with a non-Lumo developer):
   < **1 day** from `npm create lumo-agent` to publishing to
   community tier. This is the platform-thesis proof point.

---

## 12. Open questions to escalate to Kalas

1. **Python agents in v1?** Node18 is necessary (it is the SDK's
   first-class runtime). Python311 is desirable (the Brain side
   already runs Python; many agent authors will want it). The cost
   is a second runtime in E2B and a second SDK code-generation path.
   **Recommended:** Node18 only in v1; Python311 in v1.5 if the SDK
   ship gate hits the < 1-day target with Node alone.
2. **Mandatory E2B for community-tier?** A stricter WASI sandbox
   (e.g. `wasmtime`) would give better cold-start latency at the cost
   of language coverage (no Node18 in WASI today). **Recommended:**
   E2B for v1; revisit when WASI Preview 3 lands or when E2B
   cold-start becomes a measurable user-facing problem.
3. **Expose the `mission_step` row to agents?** Two options: pass
   the row verbatim (more context but couples agents to schema), or
   pass only the typed payload (cleaner, but agents can't see prior
   step outputs without a separate `ctx.history()` call).
   **Recommended:** typed payload only; `ctx.history(missionId)`
   reads prior steps via a service-role helper. The schema coupling
   risk is real and we have no incentive to take it on in v1.

---

## 13. Mandatory invariants (non-negotiable)

These mirror the ADR-012 style. Codex cannot ship the SDK without all
of them. They flow from §1 — the platform thesis depends on each one.

1. **No agent runs without an explicit `agent_installs` row plus a
   non-empty `agent_scope_grants` row.** No default-on agents.
2. **Every invocation writes a `mission_steps` row and an
   `agent_lifecycle_events` row of type `lifecycle_invoked`.** No
   silent invocations.
3. **Every side-effecting action emits a confirmation card OR has
   `reversibility = reversible` and emits an audit row.** No
   irreversible writes without confirmation.
4. **Every invocation logs an `agent_cost_log` row.** No
   un-metered invocations (ADR-016).
5. **No agent reads or writes another agent's KV namespace.**
   Service-JWT-scoped enforcement.
6. **Egress is allowlisted at the sandbox boundary, not
   self-policed.** A misbehaving agent cannot reach beyond
   `requires.connectors` even if it tries.
7. **Published versions are immutable.** Object-lock on
   `agent-bundles` storage.
8. **The platform can yank any agent globally** (the
   "kill-switch" — ADR-014 §invariants), and any user can revoke
   any installed agent at any time (ADR-014 §revocation).

---

## 14. Consequences

### 14.1 Positive

- Third-party developers can build agents without touching the core
  repo. The platform thesis is finally executable.
- The mission state machine becomes the universal substrate. A
  Lumo-built agent and a third-party agent are dispatched by the same
  executor, audited identically, billed identically.
- Sandbox + scope + cost form a defence-in-depth: each layer alone
  is recoverable; together they make a bad agent harmless.
- Versioning + rollback give the platform the kill-switch it needs
  for a real marketplace.

### 14.2 Negative

- E2B cold-start adds 200-500 ms to first-invocation latency for
  community/experimental agents. Mitigation: warm pool of E2B
  instances per popular agent (Phase 4.5+).
- Manifest schema is a contract we will struggle to evolve. Mitigation:
  manifest itself carries `sdk_version` requirement; the SDK's major
  version bump is the channel for breaking-change manifests.
- Per-agent KV at 10 MB per (user, agent) is a soft limit; some
  agents will want more. Mitigation: extension path documented
  (Phase 5+ raises the limit, optionally backed by per-agent
  Supabase Storage bucket).
- An external developer publishing a community-tier agent that calls
  expensive Brain tools could rack up real cost before the per-user
  budget ceiling fires. Mitigation: ADR-016's
  `max_cost_usd_per_invocation` is hard-enforced server-side.

### 14.3 Trade-offs accepted

- Agents must be idempotent on retry. Some workloads (paid API
  calls without idempotency keys) will require capability-author
  effort. Acceptable: the platform offers per-agent KV as the
  idempotency store.
- No agent-to-agent direct calls in v1. Composite workflows go
  through the orchestrator. Acceptable: it preserves the audit
  chain and avoids a transitive-trust problem.

---

## 15. Alternatives considered

### Option (A) — Adopt OpenAI's Assistants API as the agent contract
Pro: zero design cost; familiar to many developers. Con: vendor
lock-in; their tool spec doesn't model confirmation cards or
mission state; their pricing model doesn't allow our cost ceilings.
Rejected.

### Option (B) — Build agents as long-lived microservices
Pro: trivial isolation. Con: 10× operational surface (one Cloud Run
service per agent), incompatible with the < $150/mo cost target,
incompatible with sub-second invocation. Rejected for v1; revisited
in Phase 5+ for high-volume official agents only.

### Option (C) — Agents as untyped npm modules loaded into Core
Pro: shipped fastest. Con: no sandbox; one bad agent crashes Core;
manifest cannot be enforced. Rejected — it is the status quo we are
explicitly leaving behind.

### Option (D) — JSON-RPC over HTTP with E2B sandbox (CHOSEN)
Pro: works for in-process and sandboxed agents with the same
contract; service-JWT signing already exists; E2B already in
production. Con: cold-start tax. Mitigation in §14.

---

## 16. Rollout

Phase-4 ship gate (per phase-4-master.md):

- Week 1: SDK v1 core, manifest validator, dev harness.
- Week 2: three reference agents.
- Weeks 2-3: PERM-1 backend (the consent + scope-grant
  substrate consumes this ADR and ADR-014).
- Week 4: MARKETPLACE-1 + COST-1 wire ADR-013 to the public
  surface.
- Week 6: External-developer ship-gate run; if a non-Lumo
  developer publishes to community in < 1 day, Phase 4 ships.

---

## 17. Decision log

| Date | Decision |
|---|---|
| 2026-04-27 | ADR-013 drafted; agent runtime contract defined. |
| 2026-04-27 | E2B chosen as default runtime for non-official tiers. |
| 2026-04-27 | Per-agent KV with 10 MB / (user, agent) cap. |
| 2026-04-27 | JSON-RPC envelope with service-JWT auth and same-`request_id` retry policy. |
| 2026-04-27 | Node18 first-class runtime in v1; Python311 deferred to v1.5 pending SDK ship-gate signal. |
| 2026-04-27 | Three open questions escalated to Kalas (§12). |
