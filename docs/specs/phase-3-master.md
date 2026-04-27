# Phase 3 Master Spec

**Status:** Sealed 2026-04-27. Codex implements against this document and the
five sealed ADRs (008-012).
**Author:** Coworker A (architecture pass), reviewed by Kalas (CEO/CTO/CFO).
**Companion to:** `docs/specs/adr-008-knowledge-graph-substrate.md`,
`docs/specs/adr-009-bandit-algorithm.md`,
`docs/specs/adr-010-wake-word-engine.md`,
`docs/specs/adr-011-multimodal-rag-projection.md`,
`docs/specs/adr-012-voice-cloning-biometric-consent.md`,
`docs/specs/phase-4-outlook.md`.

This document consolidates the seven Phase-3 deliverables, sequences
them across four weeks, and defines the ship gate. Each deliverable
is sealed: motivation, scope, dependencies, acceptance, success
metrics, risks. Codex builds against this document; the ADRs are the
binding decisions referenced from each deliverable's section.

---

## Phase 3 thesis

Phase 3 turns Lumo from a single-tenant intelligence layer with
durable missions into a personal AI with memory, voice presence,
and self-aware runtime. The seven deliverables span:

1. **Substrate** — typed Brain SDK, knowledge graph, multi-modal
   RAG. The data and contracts that everything else reads.
2. **Personalisation** — per-user contextual bandit. The first
   real "Lumo learns from you" surface.
3. **Voice** — wake-word, voice clone, biometric consent. The
   first time Lumo speaks in your voice from a hotword.
4. **Runtime** — provider-routing intelligence, drift detection.
   The platform watching itself so the user-facing surfaces stay
   fast and cheap as scale grows.

The seven deliverables ship in four weeks. Codex starts SDK-1 in
parallel with these ADRs landing. KG-1 begins the moment ADR-008
is sealed (which is now). The other five start as their ADRs land.

---

## Deliverable index

| # | Code | Name | Sealed ADR | Week |
|---|---|---|---|---|
| 1 | SDK-1 | Typed Brain SDK | (no separate ADR; spec'd inline §1) | W1 (in flight) |
| 2 | KG-1 | Knowledge Graph Substrate | ADR-008 | W1-W2 |
| 3 | BANDIT-1 | Personalisation Bandit | ADR-009 | W2 |
| 4 | VOICE-1 | Voice Clone + Biometric Consent | ADR-012 | W3 |
| 5 | WAKE-1 | Wake Word Engine | ADR-010 | W3 |
| 6 | MMRAG-1 | Multi-modal RAG Projection | ADR-011 | W3 |
| 7 | RUNTIME-1 | Agent Runtime Intelligence | (no separate ADR; spec'd inline §7) | W4 |

---

## 1. SDK-1 — Typed Brain Client

### Motivation

Today every Core call to `Lumo_ML_Service` is a hand-written `fetch`
with hand-written types. Every new brain tool added in Phase 2
required a duplicated retry/timeout/audit/fallback block in Core.
SDK-1 collapses that into a single typed client so Phase-3 brain
tools (KG, bandit, voice, MMRAG, runtime intelligence) ship without
re-implementing the envelope.

### Scope

- New package: `packages/lumo-brain-sdk` (TypeScript).
- Generated types from the brain's `openapi.json`.
- Client class `LumoBrain` with one method per tool, fully typed
  inputs and outputs.
- Built-in: timeout, retry with backoff, service-JWT signing,
  `agent_tool_usage` audit row write, fallback callback hook.
- Per-tool default budgets pulled from a `BUDGETS` map (matches
  the latency targets in `lumo-intelligence-layer.md` §9 and the
  new ADRs).
- Replaces existing call sites in `lib/marketplace-intelligence.ts`,
  `lib/recall-core.ts`, `lib/anomaly-detection-core.ts`,
  `lib/forecasting-core.ts`, `lib/orchestrator.ts`, etc.

### Dependencies

- None (in flight). SDK-1 is the substrate the others import.

### Acceptance

1. Package lives under `packages/lumo-brain-sdk` with its own
   `package.json` and tsconfig.
2. `npm run typecheck` passes across the monorepo with the new
   package.
3. All existing Phase-1 and Phase-2 brain calls use the SDK.
   Direct `fetch('/api/tools/...')` is forbidden by lint rule
   inside `lib/`.
4. The SDK includes a fallback hook signature `onFallback(reason)`
   that every existing call site continues to use for its
   deterministic local fallback.
5. CI test: a synthetic brain that returns malformed payloads
   triggers fallback for every tool; no Core code path
   throws unhandled.

### Success metrics

- Lines of duplicated retry/timeout code in Core: from ~600 to 0.
- Time to add a new brain tool client surface: from ~1 hour to
  ~10 minutes (one method addition, types regenerated).
- p95 latency on existing brain calls unchanged (the SDK is
  zero-overhead per call).

### Risks

- Generated types drift from the brain's actual schema. Mitigation:
  CI gate that regenerates types and fails on diff.
- Lint rule blocks legitimate test-side fetches. Mitigation: lint
  rule scoped to `lib/`, not `tests/`.

---

## 2. KG-1 — Knowledge Graph Substrate

### Motivation

Phase-4 personalisation, GraphRAG, and the conversational explainer
all need a graph with provenance. Today Lumo's facts are flat. KG-1
adds the graph_nodes/graph_edges substrate and the brain tools to
read/write it. See ADR-008 for the full decision context.

### Scope

- Migration `db/migrations/026_kg_v1.sql` adds `graph_nodes`,
  `graph_edges`, indexes (HNSW on embedding, ltree on hierarchy
  path, btree on user/label/external_key), RLS policies, and
  service-role RPCs.
- Brain tools: `lumo_kg_upsert_node`, `lumo_kg_upsert_edge`,
  `lumo_kg_traverse`, `lumo_kg_path`, `lumo_kg_neighbours`.
- Backfill script `scripts/kg_backfill.py` for the first 90
  days of archive data per user.
- Write-through hooks on `missions`, `connector_responses_archive`,
  `preference_events` aggregation.
- Nightly reconciliation cron at `/api/cron/kg-reconcile`.
- Provenance contract enforced server-side; chat-orchestrator
  surface for graph-cited responses.

### Dependencies

- ADR-008 sealed (now).
- SDK-1 lands first (KG tools use the SDK).

### Acceptance

Per ADR-008 §11. Summary:

1. Migration applied; RLS verified.
2. Backfill produces the documented node/edge counts on the Vegas
   test user.
3. Five brain tools live with documented latency budgets
   (1-hop p95 < 200ms, 2-hop < 600ms, 3-hop < 1500ms).
4. Chat surfaces a graph-cited answer to "who did I meet about
   the Vegas trip last month" with ≥2 evidence rows.
5. Write-through hooks live; reconciliation cron green for 7
   nights.

### Success metrics

- Vegas test user graph: ≥1 mission node, ≥5 event nodes, ≥3
  contact nodes, ≥2 place nodes, ≥10 derived edges.
- 100% of graph-cited chat responses carry provenance.
- Zero cross-user edges in production (CI gate).

### Risks

Per ADR-008 §12. Headline risks: CTE perf at depth, backfill CPU
load, drift vs. source tables. All mitigated; trigger conditions
to escalate to Cloud SQL + AGE are documented in ADR-008 §3.

---

## 3. BANDIT-1 — Personalisation Bandit

### Motivation

`preference_events` has been logging since Phase-2 Sprint 0 and no
model reads it. BANDIT-1 closes the loop: a per-user LinUCB ranker
re-orders marketplace tiles, proactive moments, and chat suggestions
based on actual click/dismiss/install history. See ADR-009.

### Scope

- New tables: `bandit_user_models(user_id, surface, model_version,
  weights_jsonb, updated_at)`, `bandit_cohort_priors(surface,
  cohort_id, weights_jsonb, computed_at)`.
- Brain tools: `lumo_personalize_rank`, `lumo_log_outcome`.
- Modal nightly retraining job at 03:00 UTC.
- Online increment path for positive rewards (≥+1).
- A/B harness via `LUMO_BANDIT_ENABLED` + per-user hash assignment;
  guard metric monitoring.
- Wired into `lib/marketplace-intelligence.ts`, the
  proactive-scan cron, and the chat-suggestion code path.
- Admin UI surface at `/admin/intelligence/preferences/<user_id>`
  showing per-user bandit state.

### Dependencies

- ADR-009 sealed (now).
- SDK-1 lands first.
- Must run after KG-1 only because `agent_tool_usage` audit
  rows align with KG-1's mission node provenance — implementation-wise
  BANDIT-1 can start in parallel.

### Acceptance

Per ADR-009 §11. Summary:

1. Two brain tools live; three Core surfaces wired through them.
2. Vegas test user with >50 seeded events sees a measurably
   different marketplace ordering vs. control.
3. Nightly retraining cron green for 3 nights.
4. A/B harness wired with guard-metric surface.
5. Held-out replay reports CTR ≥ 1.15× rule-based baseline on
   marketplace surface.

### Success metrics

- Marketplace CTR uplift: ≥15% vs. baseline.
- Bandit fallback engaged: <2% of requests (the rule-based
  baseline is the safety net but should rarely fire).
- Guard metrics never breach thresholds during the ramp.

### Risks

Per ADR-009 §13. Headline: feedback-loop amplification, cold-start
quality, online vs. batch consistency. Auto-rollback on guard
breach is the operational safety net.

---

## 4. VOICE-1 — Voice Clone + Biometric Consent

### Motivation

Anchor 2 of the Phase-4 outlook is voice presence, but voice
cloning is biometric data with hard legal and ethical guardrails.
VOICE-1 ships the clone path *and* the consent/audit/revocation
posture together. See ADR-012.

### Scope

- Migration adds `consent_audit_log` (append-only) and
  `voice_clones` (encrypted at rest).
- Consent flow UX (disclosure → recording → confirmation) at
  Workspace → Settings → Voice.
- Self-hosted/open-weight clone creation and TTS playback using
  the cloned voice. Third-party cloning APIs remain fallback only.
- Sample-purge cron at `/api/cron/purge-voice-samples` running
  hourly with a 24h retention bound.
- Revocation flow with 7-day SLA for provider/local clone deletion.
- Server-side `request_voice_id_for_tts` helper (service-role
  only) that decrypts and writes `voice_clone_used` in one
  transaction.
- Drafted-reply read-back surface in workspace inbox uses the
  cloned voice.

### Dependencies

- ADR-012 sealed (now).
- SDK-1 lands first.
- Independent of KG-1, BANDIT-1, MMRAG-1.

### Acceptance

Per ADR-012 §8. Summary:

1. Schema applied; audit table append-only enforced.
2. Consent flow logs `consent_granted` with text hash.
3. Per-bucket isolation on cloning samples (test: foreign-bucket
   input returns 403).
4. End-to-end clone creation + use + revocation test.
5. 24h purge cron green; 7-day deletion SLA verified.
6. Owner-only enforcement (cross-user clone attempt returns 403).
7. Encryption-at-rest test passes.

### Success metrics

- Sample retention 100% within 24h bound.
- Revocation SLA 100% within 7 days.
- Zero unaudited cloned-voice uses.
- Zero cross-user clone attempts succeed.

### Risks

Per ADR-012 §9. Headline: sample leak before purge, voice_id
leak from DB dump, revocation API permanent failure. All
mitigated; biometric-data legal posture documented.

---

## 5. WAKE-1 — Wake Word Engine

### Motivation

Voice presence requires an on-device hotword detector so audio
doesn't leave the device until the user explicitly says "Hey
Lumo." Always-listening server-side is rejected as a privacy
posture. See ADR-010.

### Scope

- Custom on-device wake-word integration in browser as the v1
  platform; mobile integration follows once the browser engine
  meets quality targets.
- `lib/wake-word/engine.ts` with the documented interface;
  custom engine behind it; Picovoice fallback scaffolded but not
  active unless approved.
- Settings flag (off by default) + consent flow.
- Mic-active indicator in browser navbar + iOS in-app badge.
- 30-min idle auto-sleep; low-battery suspend.
- Privacy invariant CI test (tcpdump during silent capture).

### Dependencies

- ADR-010 sealed (now).
- SDK-1 lands first (post-wake STT call uses the SDK).
- Conceptually independent of VOICE-1 (wake word does not
  require a voice clone), but the W3 demo exercises both.

### Acceptance

Per ADR-010 §9. Summary:

1. Custom engine live in browser with the documented
   interface.
2. Settings panel + consent flow live.
3. Privacy invariant CI test green for 7 nights.
4. TPR ≥ 95%, FAR < 1/24h on the held-out evaluation set.
5. End-to-end smoke: "Hey Lumo, what's the weather" round
   trips in <2.5s on the reference device.

### Success metrics

- TPR ≥ 95%; FAR < 1/24h.
- p95 detection latency < 250ms.
- Battery delta < 5% over 30 min idle.
- 100% of pre-wake captures emit zero network bytes (tcpdump
  evidence).

### Risks

Per ADR-010 §10. Headline: license cost spike, FAR in noisy
environments, battery feedback. Custom-CNN fallback documented
but not built in v1.

---

## 6. MMRAG-1 — Multi-modal RAG Projection

### Motivation

Phase-2 left three native embedding spaces (text 384d, CLIP 512d,
audio-via-text 384d) with no unified retrieval. GraphRAG and the
conversational explainer assume a single recall query can return
mixed-modality candidates ranked together. See ADR-011.

### Scope

- Migration adds `unified_embeddings` (vector(1024)) with HNSW
  index + cascade triggers from native tables.
- `projector_artifacts` table for projector weight versioning.
- Projector training job on Modal (~30 min on A10G); produces
  v1.0 artifacts.
- Backfill cron populates `unified_embeddings` for existing
  native rows.
- New brain tools: `lumo_recall_unified`, `lumo_project_embedding`.
- Cross-encoder re-ranker integrated on Cloud Run.
- One Core surface migrated to `lumo_recall_unified` behind
  `LUMO_MMRAG_ENABLED`.

### Dependencies

- ADR-011 sealed (now).
- SDK-1 lands first.
- Independent of KG-1 / BANDIT-1 / VOICE-1 / WAKE-1.

### Acceptance

Per ADR-011 §11. Summary:

1. Migration applied; trigger cascade verified.
2. Projector training produces v1.0 artifacts.
3. Backfill populates rows for the Vegas test user.
4. `lumo_recall_unified` live with documented latencies.
5. Recall@5 ≥ 0.70 on the held-out test set; text-only baseline
   not regressed below 0.65.
6. Cross-modal smoke: "show me the receipt from the Vegas
   dinner" cites a CLIP-image hit ranked above text hits.

### Success metrics

- Recall@5 unified ≥ 0.70.
- Recall@5 text-only baseline ≥ 0.65 (no regression).
- p95 end-to-end recall latency < 1000ms.
- Storage cost increase < $15/mo at current row counts.

### Risks

Per ADR-011 §14. Headline: projector recall regression, HNSW
degradation at scale, re-ranker bottleneck. Held-out gates
prevent shipping a regression.

---

## 7. RUNTIME-1 — Agent Runtime Intelligence

### Motivation

The platform watching itself. Today provider routing
(Claude/GPT/Gemini) is hand-set in a routing table. Tool calls
have no per-call cost/latency forecast. Drift on our own
classifiers is undetected. RUNTIME-1 ships the first cut of
runtime intelligence so Phase-3 surfaces stay fast and cheap as
the user count grows.

### Scope (v1, deliberately bounded)

- **Provider routing intelligence.** Extend existing
  `lumo_forecast_metric` to forecast per-call cost and latency
  given current load and per-provider history. Orchestrator
  consults the forecast when picking a provider; falls back to
  the existing routing table on miss.
- **Drift detection on classifiers.** `alibi-detect` (CC0/MIT)
  computes Jensen-Shannon divergence between a 7-day rolling
  window and the fine-at-deployment reference distribution for
  the moments and risk classifiers. Threshold tiers from
  Phase-4 outlook §"open architectural questions" #6: 10% =
  email, 20% = page during business hours, 30% = page anytime.
- **Connector failure prediction.** Weibull hazard model over
  `agent_tool_usage` failures per connector. When the
  hazard rate exceeds 2× baseline for 24h, write a
  `connector_health` row with a degraded badge. Orchestrator
  weights the connector down in dispatch.
- **Admin surface** at `/admin/intelligence/runtime` showing
  forecast accuracy, drift status per classifier, and connector
  health badges.

### Out of scope (deferred to Phase-4)

- Thompson-sampling bandit across providers per task class.
  RUNTIME-1 has provider-routing *forecasting*, not
  provider-routing *learning*. The bandit is in the Phase-4
  outlook, separate.
- Prompt A/B harness. Same — Phase-4.
- Auto-retraining of drifted classifiers. v1 alerts; ops
  decides whether to retrain. Auto-retrain is Phase-4.

### Dependencies

- SDK-1 lands first.
- KG-1 helpful but not required (RUNTIME-1 reads
  `agent_tool_usage` directly).
- Best run last in W4 because the integration smoke test reads
  every other deliverable's emitted audit/telemetry.

### Acceptance

1. `lumo_forecast_metric` extended with cost/latency forecast
   modes; orchestrator consults at dispatch.
2. `alibi-detect` drift checker runs daily on the moments and
   risk classifiers; threshold tier alerts fire correctly on
   injected drift.
3. Connector hazard model writes `connector_health` rows;
   orchestrator dispatch weight reflects them.
4. Admin surface live; shows the three signals.
5. Integration smoke (the W4 demo, see §"Ship gate"): all
   seven deliverables exercised end-to-end on the Vegas test
   user with audit rows captured.

### Success metrics

- Forecast accuracy on cost: MAE within 20% of actual at p95.
- Forecast accuracy on latency: MAE within 30% of actual at
  p95.
- Drift alert fires on injected 15% drift within 24h.
- Connector hazard correctly degrades at least one synthetic
  failing-connector scenario.

### Risks

- Forecast model is a small linear regression over recent
  history; may underfit during sudden load spikes. Mitigation:
  fall back to routing table on forecast confidence < 0.6.
- Drift false-positives on small windows. Mitigation: minimum
  500-sample window before drift is computed.
- Connector hazard noisy on low-traffic connectors.
  Mitigation: minimum 100-call baseline before hazard is
  computed.

---

## Master sequencing

Codex SDK-1 starts immediately (parallel with these ADRs). KG-1
starts the moment ADR-008 is sealed (now). The other five start
as their ADRs land. Below is the four-week plan with explicit
parallelism.

### Week 1 — Substrate

| Day | SDK-1 | KG-1 | Other |
|---|---|---|---|
| Mon | Scaffold package, generate types | (waiting on SDK-1 publish) | — |
| Tue | Wire first call site (recall) | Migration 026 + RLS | — |
| Wed | Migrate marketplace + risk call sites | Brain tool scaffolds | — |
| Thu | Migrate orchestrator + classify | Backfill script + dry run | — |
| Fri | Lint rule + CI; SDK-1 acceptance | Backfill on Vegas user | — |

End of week 1: SDK-1 shipped. KG-1 has schema, brain tools
scaffolded, backfill running. Knowledge graph nodes/edges
visible in the admin DB browser.

### Week 2 — Graph + Personalisation

| Day | KG-1 | BANDIT-1 |
|---|---|---|
| Mon | Write-through hooks live | Schema migration |
| Tue | Reconciliation cron | LinUCB algorithm core |
| Wed | Chat-orchestrator graph-cited path | Cohort prior computation |
| Thu | KG-1 acceptance: graph answer on Vegas user | Online increment path |
| Fri | KG-1 ships | Marketplace surface wired |

End of week 2: KG-1 ships. BANDIT-1 has working algorithm and
nightly retraining; A/B harness scaffolded.

### Week 3 — Voice + Multi-modal

| Day | BANDIT-1 | VOICE-1 | WAKE-1 | MMRAG-1 |
|---|---|---|---|---|
| Mon | Moments + chat surfaces wired | Schema migration | Settings UI | Schema + projector training |
| Tue | A/B ramp 10% | Consent flow UX | Custom wake-word browser prototype | Backfill cron |
| Wed | Guard metrics live | Self-hosted voice clone engine | Custom wake-word mobile spike | `lumo_recall_unified` live |
| Thu | BANDIT-1 acceptance | Sample-purge cron | Privacy invariant CI test | Cross-encoder re-ranker live |
| Fri | BANDIT-1 ships | Revocation flow | WAKE-1 acceptance | MMRAG-1 acceptance |

End of week 3: BANDIT-1, VOICE-1, WAKE-1, MMRAG-1 all in
acceptance review. Some may slip to W4 Mon for sign-off.

### Week 4 — Runtime + Integration

| Day | RUNTIME-1 | Integration |
|---|---|---|
| Mon | Forecast extension | W3 deliverable sign-offs land |
| Tue | Drift detector | Vegas user end-to-end dry run |
| Wed | Connector hazard | Recording the demo |
| Thu | Admin surface | Demo polish; on-call review |
| Fri | RUNTIME-1 acceptance | **Ship gate: Friday demo** |

---

## Ship gate (sealed)

Phase 3 ships when, on a Friday in week 4, a single recording
shows all seven deliverables exercised end-to-end on the Vegas
test user. The recording is captured against production with
real telemetry. The recording must show:

1. **SDK-1.** A trace from the Cloud Run brain showing the
   typed SDK envelope: tool call, audit row, fallback hook
   firing on a deliberate brain timeout (we kill a Cloud Run
   instance mid-recording to demonstrate the fallback).
2. **KG-1.** The user types "who did I meet about the Vegas
   trip last month?" Chat returns a graph-cited answer with
   ≥2 evidence rows. Citations are clickable; one resolves to
   a Gmail thread URL, one to a Calendar event URL.
3. **BANDIT-1.** Marketplace tile order on the Vegas user is
   visibly different from a control user with the same install
   state. The `/admin/intelligence/preferences/<user_id>`
   surface shows the bandit's reward estimates per tile and
   the explore/exploit split.
4. **VOICE-1.** The user has previously enrolled a voice clone
   (off-camera; consent flow shown separately). The drafted
   reply read-back plays in the user's own voice. The audit
   surface shows the `voice_clone_used` row with the redacted
   text hash.
5. **WAKE-1.** The user says "Hey Lumo, what's left on my
   plate." Browser/phone wake-word fires on-device (visible by
   the mic-indicator pulse). Post-wake STT captures the
   utterance; orchestrator returns a voice-cloned response.
   End-to-end latency under 2.5 seconds.
6. **MMRAG-1.** The user types "show me the receipt from the
   Vegas dinner." Chat returns a result citing a CLIP-image
   hit, ranked above any text hits about Vegas dinner.
   Image thumbnail renders in chat with the source URL.
7. **RUNTIME-1.** The admin surface shows live drift status on
   both the moments and risk classifiers (no drift), the
   forecast accuracy chart (within targets), and the
   connector health column (all green for the demo run).
   We then deliberately fail one connector (kill its
   endpoint); within 5 minutes the badge flips to degraded.

The recording is reviewed by Kalas and the on-call engineer.
Sign-off requires:

- Every audit row mentioned above is present in the
  corresponding table.
- No production paging during the demo run.
- The control user comparison for BANDIT-1 is verifiable post
  hoc by an admin re-running the comparison query.
- The voice-cloning consent audit log shows a `consent_granted`
  row predating the demo.

If sign-off lands, Phase 3 ships and Phase 4 begins. If any
deliverable fails its acceptance, that deliverable's flag stays
off in production until re-demo.

---

## Cost shape (Phase 3 incremental, estimated)

At 1k MAU, Phase 3 incremental over the Phase 2 steady state:

- KG-1: storage growth (~$5/mo at scale), Modal backfill one-time
  (~$10), nightly reconciliation cron CPU (~$5/mo). Total
  ~$10-20/mo.
- BANDIT-1: Modal nightly training (~$50-150/mo per Phase-4
  outlook estimate; conservative since v1 user count is lower).
  Total ~$30-60/mo at 1k MAU.
- VOICE-1: self-hosted/open-weight clone generation on existing
  GPU job infrastructure by default. Third-party cloning APIs are
  fallback only and stay behind a disabled flag until approved.
- WAKE-1: custom on-device wake-word engine first. Picovoice
  Porcupine is a fallback only if the custom engine misses acceptance
  targets.
- MMRAG-1: storage growth from `unified_embeddings`
  (~$10-20/mo), one-time projector training (~$5).
- RUNTIME-1: pure CPU, near zero marginal cost.
- SDK-1: zero runtime cost.

**Total Phase-3 incremental target: <$150/mo at 1k MAU before
optional GPU backfill spikes, with no mandatory annual wake-word
license.** Spend above this requires a separate approval.

Pricing assumptions: existing Modal/GPU capacity for occasional
self-hosted jobs, Cloud Run at current quotas, Supabase Pro tier,
and no paid wake-word license unless the fallback is explicitly
approved. Re-validated before W1 of any sprint.

---

## Privacy and audit posture (Phase 3)

Each deliverable has its own privacy section. Cross-cutting
invariants:

- **Per-user isolation.** No data crosses users in Phase 3. KG
  graphs are disjoint per user. Bandit weights are per user.
  Voice clones are owner-only. MMRAG embeddings are user-scoped.
  No federation in v1.
- **Provenance everywhere.** Every graph traversal carries
  citations. Every voice-clone use writes an audit row.
  Every bandit decision logs context. Every multi-modal recall
  result carries a source URL.
- **Deletion-respecting.** A `DELETE FROM profiles` cascades
  through all Phase-3 tables (graph_nodes, graph_edges,
  bandit_user_models, voice_clones, consent_audit_log
  [retention exception per BIPA], unified_embeddings).
- **Audit completeness.** `agent_tool_usage` captures every
  brain-tool call. `consent_audit_log` captures every
  voice-clone-relevant action. `mission_execution_events`
  (existing) captures mission state changes. No untracked
  side effects.

The DPIA addendum for Phase 3 is drafted alongside the ADRs
and reviewed before VOICE-1 ships, since voice clone is the
deliverable that most touches the regulated-asset line.

---

## Open architectural questions deferred to Phase 4

Documented for visibility; none block Phase 3.

1. Cohort recomputation cadence for the bandit. Weekly is the
   v1 default; revisit at first retro.
2. Multi-clone per user in voice cloning. v1 is one clone per
   user; multi-clone is Phase-5+.
3. Cypher engine on a Cloud SQL + AGE sidecar — only triggered
   if KG-1 hits the escalation conditions in ADR-008 §3.
4. Thompson sampling promotion for the bandit — Phase-4 work,
   ADR-009 §10 documents the ladder.
5. Per-tenant projector fine-tuning for MMRAG — Phase-5+,
   ADR-011 §15.
6. Voice-clone watermarking (C2PA) — Phase-4.5 follow-up,
   ADR-012 §10.
7. Wake-word per-user fine-tuning — Phase-5+ pending privacy
   review, ADR-010 §11.

---

## Risks (Phase 3 portfolio level)

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| W2 KG-1 slips | Medium | Pushes BANDIT-1 dependent surfaces into W3 | Codex starts KG-1 the moment ADR-008 is sealed; backfill is the long pole, parallelisable across users |
| W3 voice-stack legal review surfaces a blocker | Low | Pushes VOICE-1 to W4 or beyond | DPIA drafted in W1; ADR-012 sealed before VOICE-1 starts; legal review can run in parallel |
| Custom wake-word engine misses quality targets | Medium | WAKE-1 stays behind a flag or uses a paid fallback | Picovoice remains an interface-compatible fallback, but only after quality data justifies the spend |
| Demo recording slips Friday W4 | Medium | Phase 3 ship date moves | All deliverables individually accepted by end of W3 (Sprint 3.5); demo is rehearsal Mon W4, recording Wed W4, polish Thu, sign-off Fri |
| One deliverable's audit gaps surface during demo review | Low | Re-demo for that deliverable | CI gates audit row presence per deliverable; a missing row fails the deliverable's own acceptance, not the demo |
| Self-hosted voice clone cost spikes on GPU | Low | Budget review at first retro | Per-user use-rate alerts; monthly spend cap with graceful degradation |
| Cloud Run cold-start tax breaches latency budgets | Medium | User-visible slowness on rare paths | Min-instance=1 during peak; SDK-1's fallback hook triggers Core's local fallback paths |

---

## What Phase 3 explicitly does NOT cover

- Multi-Lumo coordination (Phase 5+).
- Self-extending sandbox surface (Phase 5+).
- Cross-tenant federation of preference models (Phase 5+).
- Voice cloning of non-self voices (forbidden, not deferred).
- Real-time streaming intelligence beyond the existing cron
  cadence (Phase 5+).
- Mission DAGs / branching missions (Phase 4 — the linear
  Phase-3 mission machine stays intact).
- Per-user fine-tuned LLMs for drafting (Phase 5+).
- Outbound voice on third-party channels (Phase 4.5+ behind
  per-channel consent).

---

## When this document gets revised

- Day-by-day: as each deliverable lands its acceptance, the
  status header on its section flips to "Shipped" and the
  acceptance evidence is linked.
- End of W4: post-demo retro updates the cost-shape numbers
  and the open-questions list with empirical signal.
- Start of Phase 4: this document is archived; Phase 4 ADRs
  reference it for context but do not modify it.

The five ADRs (008-012) and this master spec are the binding
artifacts for Phase 3. Codex builds against them. Discrepancies
between code and these documents are bugs in code, not in the
documents — if a decision needs to change, the change is an ADR
addendum, not a silent code drift.

---

## Decision log

| Date | Decision |
|---|---|
| 2026-04-27 | Phase 3 portfolio sealed: SDK-1, KG-1, BANDIT-1, VOICE-1, WAKE-1, MMRAG-1, RUNTIME-1 |
| 2026-04-27 | Four-week sequencing locked; Codex SDK-1 starts in parallel with ADR sealing |
| 2026-04-27 | KG-1 starts the moment ADR-008 is sealed; KG-1 is the W1-W2 long pole |
| 2026-04-27 | Ship gate is a single Friday W4 recording exercising all seven deliverables on the Vegas test user |
| 2026-04-27 | Per-user isolation is the cross-cutting privacy invariant; no federation in v1 |
| 2026-04-27 | Phase-3 cost posture revised: build/self-host first; paid voice/wake vendors are fallback only |
