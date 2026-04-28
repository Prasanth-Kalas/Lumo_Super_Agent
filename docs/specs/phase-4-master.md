# Phase 4 Master Spec

**Status:** Drafted 2026-04-27. Codex implements against this document
and the four sealed Phase-4 ADRs (013-016) once Phase 3 ship gate
clears.
**Author:** Coworker M (architecture pass), to be reviewed by Kalas (CEO/CTO/CFO).
**Companion to:** `docs/specs/adr-013-agent-runtime-contract.md`,
`docs/specs/adr-014-agent-permissions-capabilities.md`,
`docs/specs/adr-015-marketplace-distribution-trust-tiers.md`,
`docs/specs/adr-016-agent-cost-metering-budgets.md`,
`docs/specs/phase-4-outlook.md`,
`docs/specs/phase-3-master.md` (sealed sequencing that precedes this).

This document consolidates the eight Phase-4 deliverables, sequences
them across six weeks, and defines the ship gate. Each deliverable
is sealed: motivation, scope, dependencies, acceptance, success
metrics, risks. Codex builds against this document; the ADRs are the
binding decisions referenced from each deliverable's section.

---

## Phase 4 thesis

Phase 4 is the platform-thesis unlock. Phases 1-3 built Lumo as an
intelligent system, but agents were Lumo-built modules wired into the
core repo. Phase 4 turns the system into a *platform*: a third-party
developer can build, sandbox, and ship an agent that runs on Lumo's
mission substrate, gates on Lumo's permission model, monetises through
Lumo's distribution, and meters under Lumo's budget — without touching
the core repo.

The framing from the Phase-4 outlook holds:

> "Lumo is the OS, agents are apps, the marketplace and permission
> model are the platform."

Phase 4 makes that statement executable. The proof point is the ship
gate: a non-Lumo developer follows public docs and publishes a
working agent in less than one day.

Without Phase 4, every agent is a feature flag in the core repo, the
"app store" is vapor, and only Lumo can build agents. With Phase 4,
the platform compounds: every external author who ships an agent
makes Lumo more useful for every user, without making the core repo
heavier.

---

## Where Phase 3 leaves us

By the end of Phase 3 (sealed 2026-04-27 in `phase-3-master.md`),
Lumo has:

- A typed Brain SDK (SDK-1) the agent SDK extends.
- A knowledge graph (KG-1) agents can query.
- A per-user contextual bandit (BANDIT-1) the marketplace can use
  for personal tile ordering.
- Voice clone + biometric consent (VOICE-1) — the consent-pattern
  precedent ADR-014 borrows from.
- Wake word + on-device STT (WAKE-1) — the entry point voice-driven
  agents will eventually plug into (Phase 5).
- Multi-modal RAG (MMRAG-1) — what agents call when a capability
  needs unified recall.
- Runtime intelligence (RUNTIME-1) — cost/latency forecasting that
  ADR-016's cost-routing fallback consumes.

Phase 4 does not redefine any of this. It builds on top.

---

## Phase 4 deliverable index

| # | Code | Name | Sealed ADR | Week |
|---|---|---|---|---|
| 1 | SDK-1 | Agent SDK v1 | ADR-013, ADR-014 | W1 |
| 2 | SAMPLE-AGENTS | Three reference agents | ADR-013 | W2 |
| 3 | PERM-1 | Permissions UI + scope-grant + revocation | ADR-014 | W2 (be), W3 (ui) |
| 4 | MARKETPLACE-1 | Marketplace UX + browse/install/uninstall | ADR-015 | W3 (be), W4 (ui) |
| 5 | DEV-DASH | Developer dashboard | ADR-015 | W5 |
| 6 | COST-1 | Cost metering + budgets + alerts | ADR-016 | W4 |
| 7 | TRUST-1 | Manual review pipeline tooling | ADR-015 | W5 |
| 8 | DOCS | developers.lumo.rentals docs site | ADR-013, 014, 015, 016 | W5 |

(`SDK-1` here is distinct from Phase 3's `SDK-1` Brain SDK — Phase-4's
SDK-1 is the **Agent SDK** that ships against ADR-013. The two are
peers: agents written with the Agent SDK call the Brain SDK as a
runtime dependency. Both packages live under `packages/`.)

---

## 1. SDK-1 — Agent SDK v1

### Motivation

The platform thesis depends on an external developer being able to
build, validate, and submit an agent without reading core source. The
SDK is the contract surface they read — types, runtime helpers, dev
harness, manifest validator, submission CLI. ADR-013 defines what an
agent IS; SDK-1 makes it shippable.

The current `@lumo/agent-sdk` git+https stub in `package.json` is a
placeholder. SDK-1 replaces it with `packages/lumo-agent-sdk` at
`1.0.0`.

### Scope

- New package `packages/lumo-agent-sdk` (TypeScript).
- Generated types from `lumo-agent.json` schema.
- Runtime helpers: `LumoAgent` class with `ctx.brain` (Brain SDK
  client scoped to `requires.brain_tools`), `ctx.connectors`
  (connector dispatcher scoped to `requires.connectors`),
  `ctx.state` (per-agent KV), `ctx.confirm()` (returns
  `needs_confirmation` envelope), `ctx.askUser()` (returns
  `needs_user_input` envelope), `ctx.history(missionId)` (read-only
  view of prior steps in the same mission).
- CLI: `lumo-agent init` (scaffolds), `lumo-agent dev` (local
  harness with mock Brain + mock connectors), `lumo-agent validate`
  (manifest validator), `lumo-agent submit` (uploads bundle to the
  marketplace).
- E2B sandbox runner — `lumo-agent dev` defaults to in-process for
  fast iteration; `lumo-agent dev --sandbox` exercises E2B locally
  matching production.
- Idempotency helper that uses `ctx.state` to short-circuit
  duplicate `request_id`s.

### Dependencies

- ADR-013, ADR-014 sealed.
- Phase 3 SDK-1 (Brain SDK) shipped — agent SDK depends on it.

### Acceptance

Per ADR-013 §11. Summary:

1. Package published at `packages/lumo-agent-sdk@1.0.0`; `package.json`
   updated to drop the git+https stub.
2. CLI commands all work end-to-end.
3. Manifest validator rejects the documented invalid manifests.
4. Local dev harness runs an agent against mock Brain + mock
   connectors; hot-reloads on change.
5. Sandbox runner reproduces the production E2B environment within
   reasonable fidelity (egress allowlist, timeouts, memory limits).
6. Unit coverage ≥ 80%; integration tests exercise the full envelope.
7. Time-to-first-agent for a non-Lumo developer measured at <1 day
   (this is the ship gate signal — see §"Ship gate").

### Success metrics

- < 10 lines of glue code for a "hello-world" read-only agent.
- < 100 lines for a side-effecting agent with confirmation card.
- p95 invocation envelope overhead: < 50 ms (the SDK's framing tax).

### Risks

- E2B fidelity in `--sandbox` mode drifts from production.
  Mitigation: nightly CI runs the sample agents under both modes and
  asserts identical outputs.
- Type generation diverges from the manifest schema. Mitigation:
  schema is the single source of truth; types are generated and
  CI-gated.

---

## 2. SAMPLE-AGENTS — Three reference agents

### Motivation

The SDK without examples is a library, not a platform. Three
reference agents establish the patterns external developers copy.
Each demonstrates a distinct trust tier, runtime posture, and
capability shape.

### Scope

Three agents, each in its own subdirectory under `samples/`:

1. **`weather-now`** (experimental tier example).
   - Smallest possible agent. One capability: "What's the weather
     now?"
   - Calls one Brain tool (`lumo_recall_unified` for last-asked
     location) + one connector (a public weather API via the
     existing connector pattern).
   - Read-only; no confirmation card.
   - Demonstrates: minimal manifest, minimal entrypoint, basic
     `ctx.brain` usage.

2. **`summarize-emails-daily`** (verified tier example).
   - Reads unread Gmail and produces a morning digest.
   - Calls Brain tools for ranking and summarisation; calls Gmail
     connector with `read.email.bodies` scope.
   - Read-only; no confirmation card.
   - Demonstrates: scope ask shape, multi-tool invocation, idempotency
     via `ctx.state`, manifest with cost ceiling.

3. **`lumo-rentals-trip-planner`** (official tier example).
   - Self-reinforcing agent: plans a Lumo Rentals trip.
   - Calls multiple Brain tools, multiple connectors. Side-effecting
     — books a vehicle reservation behind a confirmation card.
   - Demonstrates: side-effect with `ctx.confirm()`, multi-step
     mission integration, official-tier in-process posture.

Each agent ships with: manifest, entrypoint, README, unit tests, and
a end-to-end test that exercises it against the dev harness.

### Dependencies

- SDK-1 shipped.

### Acceptance

1. All three agents pass `lumo-agent validate`.
2. All three install and invoke successfully on the Vegas test user.
3. `lumo-rentals-trip-planner` exercises a confirmation card
   end-to-end (proves the card linkage in migration 024 works for
   external agents).
4. Each agent has its README at `samples/<agent>/README.md`
   documenting its manifest line-by-line — these become the basis for
   developer docs (§DOCS).

### Success metrics

- Each agent can be `npm run build && lumo-agent validate` clean.
- The `lumo-rentals-trip-planner` agent exercises every ADR-013
  surface (Brain SDK, connector dispatcher, confirmation card,
  per-agent KV, idempotency). It is the canonical
  "everything-feature-shown" agent.

### Risks

- Sample agents become outdated as the SDK evolves. Mitigation:
  CI runs all three samples on every SDK PR; staleness fails the
  build.

---

## 3. PERM-1 — Permissions UI + Scope Grant + Revocation

### Motivation

ADR-014 defines the permission contract. PERM-1 is its implementation:
the schema, the consent UI, the scope-grant flow, the revocation flow,
the audit substrate, and the kill-switch.

Security-critical. Without PERM-1, agents have no enforced boundary.

### Scope

- Migration `db/migrations/027_agent_permissions.sql` adds:
  `agent_installs`, `agent_scope_grants`, `agent_action_audit`,
  `agent_lifecycle_events`, `marketplace_agents` (shared with
  MARKETPLACE-1).
- RLS policies, append-only triggers on audit, kill-switch column.
- Backend: scope-grant write API, revocation API, kill-switch
  admin API.
- Connector dispatcher: scope-check at every connector call;
  refuses non-granted with `SCOPE_NOT_GRANTED` and writes a
  `scope.denied` audit row.
- Brain SDK gateway: scope-check at every Brain tool call.
- UI surfaces:
  - Workspace → Settings → Agents → [Agent] (per-scope toggles,
    revoke).
  - Workspace → Marketplace → [Agent] → Install → Consent screen.
  - Re-consent flow on minor/major version bump.
  - Workspace → Privacy → Audit Export.
- Spending-cap enforcement: dispatcher checks per-invocation and
  per-day caps from `agent_scope_grants.constraints`.

### Dependencies

- ADR-014 sealed.
- SDK-1 (the dispatcher needs the SDK's request envelope).

### Acceptance

Per ADR-014 §9. Summary:

1. Schema applied; append-only test green.
2. Consent UI live; renders all v1 scope strings.
3. Revocation visible to next invocation within 5 s.
4. Audit export downloads CSV.
5. Spending-cap enforcement test passes.
6. Scope-denial test passes.
7. Re-consent on version bump test passes.
8. Kill-switch test passes.

### Success metrics

- 100% of scope-gated actions write audit rows (CI-enforced).
- 0 cross-agent scope leaks (CI-enforced).
- Revocation propagation < 5 s p95.

### Risks

- Connector dispatcher scope-check adds latency. Mitigation: 5s
  scope-grant cache, async audit writes.
- Re-consent UX nags users. Mitigation: pin-to-prior-version path,
  30-day auto-pin if user ignores.

---

## 4. MARKETPLACE-1 — Marketplace UX + Distribution

### Motivation

ADR-015 defines distribution and trust tiers. MARKETPLACE-1 ships the
public-facing marketplace and the bundle distribution pipeline.

### Scope

- Migration adds `marketplace_agents`, `marketplace_agent_versions`,
  `agent_security_reviews`, `agent_ratings` (post-MVP), Phase-5
  commerce columns.
- `agent-bundles` Supabase Storage bucket with object-lock.
- Backend: bundle upload, manifest indexing, version yank API,
  patch-auto-install, minor/major re-consent prompt.
- UI surfaces:
  - Workspace → Marketplace (browse, search, filter, categories).
  - Marketplace tile (badge, name, install).
  - Detail page (capabilities, scopes, cost, author).
  - Install flow → Consent screen (delegates to PERM-1).
- Anti-typosquatting check on submission.
- Lumo's-picks curation surface.

### Dependencies

- ADR-015 sealed.
- PERM-1 (consent screen).
- COST-1 (cost-model rendering on tile).
- SDK-1 (the submission CLI uploads to the marketplace).

### Acceptance

Per ADR-015 §9.1. Summary:

1. Marketplace surface live; all three reference agents discoverable.
2. Browse/search/filter work.
3. Install → consent → installed flow ≤ 4 taps.
4. Anti-typosquatting test passes.
5. Yank test passes (yanked version migrates pinned users in 1 h).
6. Settings panel live with per-scope toggles.

### Success metrics

- p95 marketplace browse load < 800 ms (HNSW + ILIKE search).
- 100% of bundles pass sha256 verification on install.
- 0 published bundles reachable after yank (within 1 h).

### Risks

- Search quality on launch is poor (no ratings, no install signal).
  Mitigation: hand-curated Lumo's-picks row at top.
- Bundle storage costs scale with version count. Mitigation: monthly
  pruning of bundles with 0 installs older than 90 days.

---

## 5. DEV-DASH — Developer Dashboard

### Motivation

External authors need a place to see analytics, errors, ratings, and
manage versions. DEV-DASH is their backstage. Without it, the
authoring experience ends at submission and the platform looks like a
black box.

### Scope

- New surface at `developers.lumo.rentals/dashboard` (or
  `/developer/dashboard` in workspace, TBD per UX review).
- Per-author surfaces:
  - Submitted agents list with state (pending review, published,
    yanked, killed).
  - Per-agent: install count, invocation count, error rate, p95
    latency, cost-per-invocation distribution, ratings (post-MVP).
  - Version manager: publish new version, yank a version,
    promote-to-verified flow.
  - Error log: per-invocation errors with redacted user_id, stack
    trace, error code, mission_step_id.
  - Submission queue status (pending review SLA countdown).
- Author identity verification flow (email-verified for community,
  legal-entity-verified for verified-tier promotion).

### Dependencies

- MARKETPLACE-1 (the data is there).
- TRUST-1 (review pipeline state surfaces here).

### Acceptance

1. Dashboard surface live for an author with at least 1 submitted
   agent.
2. Analytics panels render correctly with seeded data.
3. Version manager can yank a version (writes to
   `marketplace_agent_versions.yanked = true`).
4. Error log redacts user_id correctly (no PII to author).
5. Promote-to-verified flow submits to TRUST-1's queue.

### Success metrics

- Author NPS: surveyed after first submission, target ≥ +30.
- Time from submission to author seeing first analytics: < 1 hour
  (driven by automated check pipeline + immediate publish for
  experimental tier).

### Risks

- Author-side privacy (showing too much about users' usage).
  Mitigation: aggregate metrics only; no per-user details visible
  to author.
- Dashboard becomes a complete CMS with no end. Mitigation: v1 ships
  the four panels above, not more.

---

## 6. COST-1 — Cost Metering + Budgets + Alerts

### Motivation

ADR-016 defines the cost contract. COST-1 implements it: the per-invocation
log, the per-user budgets, the cost-routing fallback, the alerts, the
reporting surfaces.

### Scope

- Migration adds `agent_cost_log`, `user_budget_tier`.
- Orchestrator integration: cost log row written at end of each
  invocation; budget check before each dispatch.
- Brain SDK gateway: cost-routing fallback (cheaper model when
  budget tight); per-call cost increment.
- Connector dispatcher: per-call cost increment.
- UI surfaces:
  - Workspace → Settings → Budget (tier, caps, spend, top-5
    agents).
  - Workspace → Settings → Agents → [Agent] (per-agent cost view).
- Daily 7am-local digest cron.
- Monthly summary cron (1st of month).
- CSV export.
- Alert email on first daily breach of period.

### Dependencies

- ADR-016 sealed.
- SDK-1 (the SDK writes provisional cost into the response envelope).
- PERM-1 (per-agent settings panel hosts cost view).
- Phase 3 RUNTIME-1 (cost forecasting feeds the routing fallback).

### Acceptance

Per ADR-016 §8. Summary:

1. Cost log row on every invocation.
2. Per-user budget refusal test passes.
3. Per-agent ceiling test passes.
4. Cost-routing fallback test passes.
5. Daily digest cron green.
6. Monthly summary cron green.
7. CSV export works.
8. Budget UI renders for all three tiers.

### Success metrics

- 100% of invocations have a cost log row.
- 0 budget breaches without an alert email.
- p95 invocation overhead from budget check + cost write: < 25 ms.

### Risks

- Cost log write latency. Mitigation: async write with sync
  flush at invocation end.
- 5-second budget cache lets a small overspend through. Bounded;
  acceptable.

---

## 7. TRUST-1 — Manual Review Pipeline Tooling

### Motivation

ADR-015's verified-tier requires 5-business-day human review.
TRUST-1 is the tooling that makes the queue actually staffable —
without it the bottleneck collapses on whichever Lumo engineer is
on review duty.

### Scope

- Admin surface at `/admin/marketplace/review-queue`:
  - Submission queue with priority (community submissions first,
    promotion requests next, verified re-reviews last).
  - Per-submission detail view: manifest diff, source code link,
    automated-check report, prior submission history.
  - Approve / Reject / Needs-changes buttons → writes to
    `agent_security_reviews`.
  - Takedown action → flips `marketplace_agents.killed = true`.
  - Anti-typosquatting flagged-list panel.
  - Banned-author management.
- Automated-check pipeline runner — extracts the bundle, runs the
  static-analysis matchers, runs the E2B sandbox tests, writes a
  `agent_review_pipeline_runs` row.
- SLA dashboard: queue depth, median review time, breach rate.

### Dependencies

- MARKETPLACE-1 (the data structures).
- ADR-015 sealed.

### Acceptance

Per ADR-015 §9.2. Summary:

1. Review queue surface live; reviewer can approve/reject/needs-changes.
2. Automated check pipeline runs on every submission.
3. SLA dashboard live with seeded data.
4. Takedown action flips kill-switch in < 60 s.

### Success metrics

- Median review time: < 5 business days.
- 0 SLA breaches > 7 business days in the first quarter of Phase 4.
- 0 missed takedowns from a reported critical issue.

### Risks

- Review queue grows faster than reviewers can clear. Mitigation:
  community tier auto-publishes; verified-tier review is the
  bottleneck, but verified-tier is opt-in by author. Throttle
  submission rate (ADR-015 §6.1).

---

## 8. DOCS — developers.lumo.rentals

### Motivation

External developers find the SDK by reading docs. The docs site is
the platform's marketing surface for builders. Without it,
"build a Lumo agent" is a meme; with it, it's a 30-minute tutorial.

### Scope

- Docs site at `developers.lumo.rentals` (subdomain — Codex sets up
  with Vercel or equivalent).
- Pages:
  - **Landing** — what is a Lumo agent, who builds them, why.
  - **Quickstart** — `npm create lumo-agent` → first agent in 15
    minutes. This is the page that drives the < 1-day ship-gate
    metric.
  - **Concepts** — agent runtime contract (ADR-013 distilled),
    permissions (ADR-014), distribution (ADR-015), cost (ADR-016).
  - **Reference** — manifest schema, SDK API, CLI commands, error
    codes, scope taxonomy.
  - **Guides** — building a read-only agent, building a
    side-effecting agent, getting verified, monetisation
    (placeholder for Phase 5).
  - **Sample agents** — links to `samples/` with annotated
    walkthrough of each.
  - **Submission** — how to submit, review SLAs, getting promoted.
  - **Changelog** — SDK version history.

### Dependencies

- SDK-1, SAMPLE-AGENTS, MARKETPLACE-1, COST-1, PERM-1 all live.
  The docs are the user-readable distillation of every other
  Phase-4 deliverable.

### Acceptance

1. Site live at `developers.lumo.rentals`.
2. Quickstart followable end-to-end by a non-Lumo developer.
3. Reference pages auto-generated from SDK source where possible
   (CI updates docs on every SDK release).
4. Manifest schema reference is the source of truth — copy-paste
   from ADR-013 §3.1 forbidden in source; the docs build pulls from
   the actual schema file.

### Success metrics

- Quickstart bounce rate < 30% (measured via analytics).
- Time-to-first-agent: < 1 day for a non-Lumo developer (the
  ship-gate metric).
- Docs Lighthouse score ≥ 90 on Performance and Accessibility.

### Risks

- Docs drift from SDK behaviour. Mitigation: CI gate that fails the
  SDK PR if reference pages are out of date.
- Public docs surface attracts attention before TRUST-1 is ready.
  Mitigation: ship DOCS in W5, after TRUST-1 is queue-ready.

---

## Master sequencing — six-week plan

The plan parallelises wherever possible. Codex runs SDK-1 first
because every other deliverable depends on it.

### Week 1 — SDK foundations + ADR review

| Day | SDK-1 | PERM-1 (review) |
|---|---|---|
| Mon | Scaffold `packages/lumo-agent-sdk`; types from ADR-013 schema | ADR-014 review with Kalas; sealed before W2 |
| Tue | Manifest validator; CLI scaffold | ADR-014 review continued |
| Wed | `lumo-agent dev` local harness | — |
| Thu | E2B `--sandbox` mode | — |
| Fri | SDK-1 acceptance gates green | ADR-014 sealed |

End of W1: SDK-1 shipped at `packages/lumo-agent-sdk@1.0.0-rc.1`. ADR-014
sealed.

### Week 2 — Sample agents + Permissions backend

| Day | SAMPLE-AGENTS | PERM-1 backend |
|---|---|---|
| Mon | `weather-now` agent built | Migration 027 (permissions tables) |
| Tue | `summarize-emails-daily` agent | RLS + append-only triggers |
| Wed | `lumo-rentals-trip-planner` (in-process posture) | Scope-grant write API |
| Thu | All three agents pass `validate` | Connector dispatcher scope-check |
| Fri | All three agents pass install + invoke | Brain SDK gateway scope-check |

End of W2: SAMPLE-AGENTS shipped. PERM-1 backend ready for UI.

### Week 3 — Permissions UI + Marketplace backend

| Day | PERM-1 UI | MARKETPLACE-1 backend |
|---|---|---|
| Mon | Workspace → Settings → Agents | Migration extends marketplace tables |
| Tue | Per-scope toggles + revoke | `agent-bundles` bucket with object-lock |
| Wed | Consent screen | Submission API + bundle upload |
| Thu | Re-consent on minor/major bump | Manifest indexing + denormalisation |
| Fri | PERM-1 acceptance | Anti-typosquatting + version yank API |

End of W3: PERM-1 ships. MARKETPLACE-1 backend ready for UI.

### Week 4 — Marketplace UI + Cost metering

| Day | MARKETPLACE-1 UI | COST-1 |
|---|---|---|
| Mon | Browse + tile rendering | Migration 028 (cost log + budgets) |
| Tue | Search + filters + categories | Cost log write on every invocation |
| Wed | Detail page + install flow | Per-user budget enforcement |
| Thu | Settings → Agents (combined with PERM-1 panel) | Cost-routing fallback in Brain SDK |
| Fri | MARKETPLACE-1 acceptance | COST-1 acceptance |

End of W4: MARKETPLACE-1 ships. COST-1 ships. Three reference agents
publishable end-to-end. The platform thesis is observable internally;
not yet open to external developers.

### Week 5 — Developer dashboard + Trust pipeline + Docs

| Day | DEV-DASH | TRUST-1 | DOCS |
|---|---|---|---|
| Mon | Author surface scaffold | Review queue admin surface | Site setup at developers.lumo.rentals |
| Tue | Per-agent analytics panels | Automated check pipeline runner | Quickstart + Concepts pages |
| Wed | Version manager | SLA dashboard | Reference pages from schema |
| Thu | Error log + redaction | Takedown action | Guides + sample-agent walkthroughs |
| Fri | DEV-DASH acceptance | TRUST-1 acceptance | DOCS acceptance |

End of W5: DEV-DASH, TRUST-1, DOCS all ship. The platform is open to
external developers.

### Week 6 — Phase-4 ship gate

| Day | Activity |
|---|---|
| Mon | Internal rehearsal: a Lumo engineer follows DOCS quickstart and ships an agent end-to-end. |
| Tue | External developer recruited (a known-good builder, ideally from outside Lumo). They start the quickstart. |
| Wed | External developer's day-1 attempt — measure time, bugs, friction. |
| Thu | If day-1 < 1 day, ship gate cleared. If not, fix the highest-friction items. |
| Fri | **Phase-4 ship gate recording** — the external developer publishes a working community-tier agent on camera. Phase 4 ships. |

---

## Ship gate — Phase 4

A single non-Lumo developer follows public docs end-to-end and
publishes a working agent to the community tier in **less than one
day**, using only:

- Public DOCS at `developers.lumo.rentals`.
- The SDK installed via `npm create lumo-agent`.
- A free Lumo developer account.

The recording shows:

1. Developer reads the Quickstart (timer starts).
2. Developer scaffolds an agent with `npm create lumo-agent`.
3. Developer writes the manifest, the entrypoint, runs
   `lumo-agent dev` to test locally.
4. Developer runs `lumo-agent validate` and `lumo-agent submit`.
5. Automated checks pass; the agent is published to community tier.
6. Developer installs their own agent in their Lumo workspace,
   exercises a capability, sees the audit row, sees the cost log
   row.
7. Timer stops. Total: < 24 hours of clock time, < 4 hours of focused
   work.

Sign-off requires:

- The agent runs successfully end-to-end on the developer's account.
- All audit rows present (`agent_lifecycle_events`,
  `agent_action_audit`, `agent_cost_log`).
- The marketplace tile renders correctly with community-tier
  badge.
- No critical bugs surfaced during the run that would have
  prevented a less-skilled developer from completing.

If the recording lands, Phase 4 ships. Phase 5 begins on the day
sign-off is recorded.

---

## Cost shape (Phase 4 incremental, estimated)

At 1k MAU, Phase 4 incremental over the Phase 3 steady state:

- Bundle storage in `agent-bundles`: ~$2-5/mo (50 MB avg per agent
  × 100 agents × $0.021/GB/month, plus version retention).
- Cost log + audit log storage: ~$5-10/mo (high write volume but
  small rows; ~5 GB/year at 1k MAU).
- Marketplace search query load: ~$5/mo on Supabase Pro tier (the
  HNSW index from MMRAG-1 is shared).
- Review queue tooling: pure CPU; ~$0/mo runtime.
- Docs hosting on Vercel: $0 free tier or $20/mo Pro tier.

**Total Phase-4 incremental: ~$15-40/mo at 1k MAU**, well within the
< $150/mo Phase-3 budget envelope. Spend above this is dominated by
agent invocation cost itself, which is metered per ADR-016 — not a
platform cost, a user cost.

The ship-gate recording, the external developer's account, and any
internal demo agents collectively fall well under the budget.

---

## Privacy and audit posture (Phase 4)

Each ADR has its own privacy section. Cross-cutting invariants:

- **Per-user isolation across agents.** No cross-agent KV reads
  (ADR-013 §7); no cross-agent scope inheritance (ADR-014 §2.3).
- **Provenance everywhere.** Every side-effecting action emits a
  confirmation card or an `agent_action_audit` row (ADR-013 §1
  invariant 5).
- **Append-only audit.** `agent_action_audit` cannot be mutated
  (ADR-014 §2.4).
- **Author privacy.** Author-side analytics aggregate metrics only;
  no per-user details to authors (DEV-DASH §"Risks").
- **Deletion-respecting.** Cascade on `profiles.id` cleans
  `agent_installs`, `agent_scope_grants`, `agent_state`,
  `agent_lifecycle_events`. Audit rows persist to the retention
  table (ADR-014 §7.3).

The Phase-4 DPIA addendum is drafted alongside the ADRs and reviewed
before MARKETPLACE-1 opens to external submissions, since the
marketplace is the regulated-asset boundary.

---

## Open architectural questions (deferred to Phase 4 retro or Phase 5)

Documented for visibility; none block Phase 4 ship.

1. **Python agents in v1.** Recommended Node-only in v1; revisit
   in v1.5 (ADR-013 §12).
2. **WASI sandbox alternative to E2B.** Phase 5+ pending E2B
   cold-start signal (ADR-013 §12).
3. **Per-tenant private marketplaces.** Phase 5+ via
   `marketplace_agents.tenant_scope` (ADR-015 §12).
4. **Per-record scopes on messaging.** v2 (ADR-014 §12).
5. **Cross-tenant agent installs.** Phase 5+ (out of v1 scope).
6. **Stripe Connect for builder payouts.** Phase 5 (data-modelled
   in v1, ADR-015 §8).
7. **Verified-tier paid floor.** Free in v1; revisit if spam volume
   warrants (ADR-015 §12).
8. **Agent-to-agent direct invocation.** Forbidden in v1 (ADR-013
   §5.3); revisit only with a transitive-trust model.

---

## Risks (Phase 4 portfolio level)

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| External developer ship-gate slips | Medium | Phase 4 ships without the proof point | Internal rehearsal in W6 Mon; if the rehearsal is rough, fix friction items before recruiting external dev |
| Verified-tier review queue backs up at launch | Low | Authors wait > 5 business days | TRUST-1's SLA dashboard alerts on > 80% queue depth; manual triage in week 1 |
| First malicious agent slips through automated checks | Low | User trust hit; one-time kill-switch use | Defence-in-depth: ADR-014 invariants; kill-switch flips in < 60 s |
| E2B costs spike on community-tier agent volume | Medium | Cost target breached | Per-agent invocation rate-limit on community tier; the < $150/mo target is for platform cost, agent invocation is metered to the user (ADR-016) |
| External developer reads docs and submits but the marketplace UI isn't yet ready | High | Submitted agent sits in pending state | Sequencing: DOCS ships in W5 *after* MARKETPLACE-1 (W4); cannot ship DOCS without the install path live |
| Cost log write latency spikes during a flash crowd | Low | User-visible latency on agent invocation | Async write with sync flush at invocation end; budget check from cache |
| Re-consent UX nags users into uninstalling | Medium | Install rate dips after a popular agent's minor bump | 30-day auto-pin to prior version; minor bumps that don't add scopes don't prompt at all |
| Kill-switch fires on an agent with a popular install base | Low | Community trust hit | Communication template + alternate-agent recommendation surface; postmortem published |

---

## What Phase 4 explicitly does NOT cover

The honest scoping list. Each is a real desire but stays out of
Phase 4 to keep the surface manageable.

- **Paid agents and Stripe Connect.** Data-modelled (ADR-015 §8) but
  not enabled. Phase 5.
- **Multi-Lumo coordination via agents.** Phase 5+ (matches Phase-3
  outlook).
- **Cross-tenant agent installs.** Out of scope; Phase 5+.
- **Voice-driven agent invocation via wake word.** Phase 5; the
  WAKE-1 substrate is in place but Phase 4 does not wire agent
  invocation through it.
- **Agent-to-agent direct calls.** Forbidden in v1 (ADR-013 §5.3).
- **Federated marketplace** (third-party hosting Lumo agents).
  Phase 5+.
- **Agent observability/tracing** beyond the cost log + audit log.
  Phase 4.5 if there is demand.
- **Per-user fine-tuned agents.** Phase 5+; the personalisation
  axis is BANDIT-1's domain in Phase 3.
- **Live streaming responses from agents.** Phase 5+; v1 is
  request/response.

---

## When this document gets revised

- Day-by-day during Phase 4: as each deliverable lands its
  acceptance, the status header on its section flips to "Shipped"
  and the acceptance evidence is linked.
- End of W6: post-ship-gate retro updates the cost shape and the
  open-questions list with empirical signal.
- Start of Phase 5: this document is archived; Phase 5 ADRs
  reference it for context but do not modify it.

The four ADRs (013-016) and this master spec are the binding
artifacts for Phase 4. Codex builds against them. Discrepancies
between code and these documents are bugs in code, not in the
documents — if a decision needs to change, the change is an ADR
amendment, not a silent code drift.

---

## Decision log

| Date | Decision |
|---|---|
| 2026-04-27 | Phase 4 portfolio drafted: SDK-1, SAMPLE-AGENTS, PERM-1, MARKETPLACE-1, DEV-DASH, COST-1, TRUST-1, DOCS. |
| 2026-04-27 | Six-week sequencing locked; SDK-1 starts W1 in parallel with ADR-014 review. |
| 2026-04-27 | Ship gate is a single recording of a non-Lumo developer publishing a community-tier agent in < 1 day. |
| 2026-04-27 | Free in v1; paid agents in Phase 5 with data-model now (no migration later). |
| 2026-04-27 | Per-user isolation is the cross-cutting privacy invariant; no cross-tenant agent installs in v1. |
| 2026-04-27 | E2B is the default sandbox for non-official tiers; in-process is review-gated. |
| 2026-04-27 | Phase-4 cost target: $15-40/mo platform-side at 1k MAU, well within the < $150/mo envelope. |
