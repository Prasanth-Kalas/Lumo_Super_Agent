# Phase 4 Outlook — Personal Intelligence + Platform Maturity

**Status:** Outlook draft, written after Sprint 3 closed (D5 shipped 2026-04-27).
**Author:** Claude coworker (K14).
**Companion to:** `docs/specs/lumo-intelligence-layer.md` (the ADR),
`docs/specs/sprint-3-d4-mission-worker.md`,
`docs/specs/sprint-3-d5-mission-rollback.md`.
**Non-binding.** Phase-4 work begins when Phase 3 acceptance is recorded
(durable Vegas trip mission running end-to-end on production with all
five state transitions: `ready → executing → awaiting_confirmation →
ready → completed`; plus a successful rollback smoke test on a mission
with at least one compensating-succeeded step and one
irreversible-skipped step).

---

## Where Phase 3 leaves us

By the end of Phase 3, Lumo has:

- A privileged-system-agent intelligence layer (`Lumo_ML_Service`) with
  six brain tools live in production: `lumo_recall`, `lumo_marketplace_rank`,
  `lumo_risk_score`, `lumo_optimize_trip`, `lumo_detect_anomaly`,
  `lumo_forecast_metric`. Each one is dispatched through a
  pure-core/thin-wrapper pair, audited via `agent_tool_usage`, and falls
  back to deterministic local behaviour when the brain is unreachable.
- Recall over indexed user data — text snippets, audio transcripts with
  pyannote speaker diarization labels, layout-aware PDF page citations,
  CLIP image embeddings with 512-dim native vector storage. All recall
  rows are user-scoped, deletion-respecting, and run through Presidio
  redaction before any brain ingestion.
- Marketplace intelligence — personalized tile ranking from
  `preference_events` plus per-tenant calibration, `risk_score` badges
  on every tile graduated from scaffold scoring to peer-calibrated
  scoring, install-prompt explanations that name the user task, and a
  permission over-ask comparison surface.
- Proactive moments — anomaly detection on `time_series_metrics`
  (daily/hourly grain), forecasting against trip-like calendar events
  7-14 days out, the Friday-afternoon demo where Lumo surfaces three
  heads-ups in the Workspace Today tab without the user prompting, and
  a per-user three-moment-per-run budget that protects against
  notification spam.
- Durable mission execution. Migration 023's `missions`,
  `mission_steps`, and `mission_execution_events` tables; the
  `next_mission_step_for_execution` and
  `next_rollback_step_for_execution` RPCs that atomically claim work
  with `FOR UPDATE SKIP LOCKED`; the D4 forward executor cron; the D5
  rollback cron. Five-state mission machine
  (`ready → executing → awaiting_confirmation → ready → completed`)
  plus the rollback path (`executing → rolling_back → rolled_back`,
  optionally `partial`) is enforced by `lib/mission-execution-core.ts`
  and proved out by `tests/mission-execution-core.test.mjs` plus the
  integration suite.

What Lumo *can't* do yet that a real personal AI eventually should:

- **Adapt to a user's preferences over time.** We're logging clicks,
  installs, dismissals, and confirmation outcomes into
  `preference_events` from Sprint 0 onwards, but no model reads them.
  Marketplace ranking uses a tenant-aggregate signal at best; chat
  suggestions use heuristics; mission-plan agent ordering is static.
  Phase 4 changes that.
- **Speak in the user's voice for drafted replies.** Today the brain
  drafts text; the user reads it. There is no cloned-voice playback,
  no wake-word entrypoint, no on-device STT for private-by-default
  short interactions.
- **Wake on a hotword without keeping a microphone always-listening
  server-side.** Always-listening server-side is a non-starter for
  privacy. We need an on-device wake-word path that only opens the
  pipe to Lumo after the local detector fires.
- **Self-tune its own prompts and model routing.** Right now the
  orchestrator picks Claude/GPT/Gemini per task class with a hand-set
  routing table. There is no online evaluation, no Thompson-sampled
  bandit across providers, no learned drift detection on our own
  classifiers.
- **Coordinate with another user's Lumo.** Negotiation, multi-user
  scheduling beyond a single calendar feed, shared missions where two
  users approve jointly — none of this is in scope yet, and per the
  ADR Phase-3 outlook these were always Phase 5+ work.
- **Compute on demand without a hand-rolled prompt.** The E2B sandbox
  exists for `run_python_sandbox` calls, but no UI surfaces it, and
  the Friday demo never reaches it. A user who wants "compute the
  payback period if I take the leasing deal vs. the cash deal" still
  has to ask in chat and trust the orchestrator routes correctly.

The first four bullets are Phase 4. The last two stay Phase 5+.

---

## Phase 4 thesis

Phase 4 is where Lumo learns from you, and where Lumo's infrastructure
learns about itself. Two anchors face the user — a personal preference
model that quietly tunes everything Lumo surfaces, and a voice
presence that lets Lumo speak in your voice from a wake-word trigger.
Three infrastructure themes sit underneath — composable mission DAGs
so multi-step plans can branch and recover, agent runtime intelligence
so the platform watches itself for cost/latency/drift, and an active
learning loop so user feedback compounds across the platform.

The framing from the ADR — "Lumo is the OS, agents are apps,
the marketplace and permission model are the platform" — still holds.
Phase 4 leans into the *personalised* axis of that framing: not "more
apps", but "your apps, working how you work, in your voice." iPhone
OS shipped Siri in iOS 5; Phase 4 is Lumo's Siri moment, only with the
agent contract, confirmation cards, and audit trail already in place
to make it safe.

The thesis test: a user who has been on Lumo for sixty days should
notice that the same query produces different rankings, the same
proactive-moment surface produces different selections, the same
draft reply produces different phrasing — all because the platform
learned. They should not have to read a release note to see the
difference.

---

## Anchor 1 — Personal preference model

The preference-logging substrate from Sprint 0 has been writing rows
to `preference_events` for weeks by the time Phase 4 starts. Anchor 1
trains a per-user contextual bandit (or a simpler logistic regression
to start) on those signals so:

- **Marketplace tile ranking** reflects what *this user* clicks vs.
  ignores. A user who has installed five productivity agents and
  zero entertainment ones should see fewer entertainment tiles in
  the next session, not because Lumo is hiding them but because the
  bandit's expected reward for surfacing them is low.
- **Proactive-moment surfacing** learns which kinds of moments lead
  to action. The Friday-afternoon demo today shows three moments
  selected by static rules (anomaly score over threshold, calendar
  event 7-14 days out, etc). Phase 4 selects from a candidate pool
  of fifteen-to-twenty moments and the bandit picks three.
- **Chat suggestions rank by per-user click-through history.** When
  the orchestrator emits suggested follow-up prompts, the order
  comes from a small online learner, not a static template.
- **Mission-plan agent ordering adapts.** Some users want "food
  first, then trip", some want "trip first, then food", some want
  the agent that costs less per call before the agent that's faster.
  The mission planner today produces a deterministic order; Phase 4
  re-orders the candidate-agent list per user.

### Concrete user moments

> "Lumo notices you always ignore restaurant suggestions on weekdays
> and starts surfacing them only on Thursdays and Fridays. You never
> tell it to. Three weeks in, you realize the weekday clutter is
> gone."

> "You've installed two flight agents over six months. The marketplace
> stops surfacing flight tiles. You search 'flights to Tokyo' and the
> existing two reappear, ranked by which one you've actually used to
> complete a booking."

> "Friday afternoon arrives. The proactive moment column shows two
> revenue anomalies and a calendar heads-up — last week it showed
> three calendar heads-ups. The bandit learned that calendar moments
> rarely lead to action for you, so it weighted them down."

### Model choice

Start with a contextual bandit. `mabwiser` (Python, MIT-licensed) or
Vowpal Wabbit's contextual bandit primitives are both serviceable for
the volumes we expect (1k MAU at Phase 4 launch). The decision
context is small — user_id, surface (marketplace/moments/chat),
candidate_id, day-of-week, hour bucket, recent-action-count — so a
linear or shallow-tree contextual bandit suffices.

Escalate to small per-user fine-tunes only if/when needed. A 7B
base model with a per-user LoRA adapter for drafting style is
attractive but expensive — not Sprint 0 work for Phase 4. The
preference model is the priority; drafting-style fine-tunes are a
later sprint.

The model lives behind two new brain tools:

- `lumo_personalize_rank(user_id, surface, candidates[]) -> ordered
  candidates with reward estimates`. Called by marketplace, moments,
  and chat-suggestion code paths. Falls back to the existing static
  ordering if the bandit is unreachable or returns malformed
  responses, exactly the same fallback contract every other brain
  tool already has.
- `lumo_log_outcome(user_id, surface, candidate_id, reward)`. Called
  after the user clicks/ignores/dismisses. Reward is binary for v1
  (clicked=1, ignored=0); v2 can include longer-tail signals like
  "user completed an action that originated from this candidate."

Nightly retraining batches `preference_events` per tenant on Modal,
writes the new model artifact to a versioned bucket, and the Cloud
Run service hot-swaps. Same versioning + rollback semantics as the
existing classifiers.

### Privacy stance

Preferences are trained per user. Nothing crosses tenants in Phase 4.
A user's bandit is initialised from a tenant-aggregate prior the
first time they generate enough events (~50 actions); after that the
per-user bandit dominates. No raw event payloads cross tenant
boundaries even during retraining — the worker pulls only the
hashed candidate ids and binary rewards.

Optional federation lands in Phase 5+ if users explicitly opt in. We
will not turn this on by default. The preference model is one of the
artifacts that most directly touches the regulated-asset line, and
the conservative stance is "default off, never cross tenant in v1."

### Cost shape

- Nightly retraining on Modal: ~$50-150/mo at 1k MAU. Cost scales
  roughly linearly with user count, capped by the per-user
  retraining cadence (we retrain only users with >10 new events
  since the last refresh).
- Hot-path inference on Cloud Run: marginal — the bandit is a small
  matrix multiplication, the latency cost is dominated by the
  Cloud Run cold-start tax we already pay.
- Storage: one model artifact per user per refresh; pruning policy
  keeps the last 7 versions. `preference_events` itself is already
  stored from Sprint 0.

---

## Anchor 2 — Voice presence

Real voice fluency, not just transcription. Four sub-themes:

1. **Voice cloning.** Lumo speaks in your voice when drafting replies
   aloud. Coqui XTTS or Eleven Labs (vendor TBD; prefer self-hosted
   on Modal for cost and data residency). The clone is generated
   from a 30-second opt-in voice sample the user records once.
2. **Wake word.** "Hey Lumo" detection via Picovoice Porcupine
   (commercial license, fully on-device). No audio stream leaves the
   user's microphone until the wake word fires locally. This is the
   privacy posture that makes server-side voice presence palatable.
3. **Speaker biometrics (auth-light).** Voice signature as a second
   factor for sensitive confirmations. "Lumo, confirm the $4,200
   flight booking" — Lumo verifies the speaker matches the
   enrolled voice profile before approving the confirmation card.
   This is auth-*light* — biometrics is one signal among others
   (device, session, recency), never the sole factor.
4. **Real-time low-latency STT.** On-device Whisper.cpp (small or
   tiny model, 100-300ms latency on Apple Silicon) for short
   interactions. Server-side Whisper-on-Modal for long-form audio
   (>60s, e.g. dictating a meeting note).

### Walk-through demo moments

> "Hey Lumo, push tomorrow's standup by 30 minutes." Wake word fires
> on-device. The 4-second utterance streams to Whisper.cpp,
> producing the transcript locally. Lumo orchestrator routes through
> the calendar tool (existing). Voice-cloned reply: "Standup moved
> to 9:30am tomorrow, I sent a notice to the four attendees." All
> in under two seconds.

> "Hey Lumo, what's left on my plate?" Wake word fires. STT local.
> Lumo recall + mission-status query. Voice clone reads back: "Two
> approvals waiting on you — the contractor invoice and the Vegas
> trip dinner reservation. The Vegas mission is at step 6 of 9,
> running fine." This is the JARVIS moment.

> "Confirm the booking." Voice biometric gate verifies it's the
> enrolled user, not someone else who happened to find the device
> unlocked. Confirmation card resolves to `ready`. The forward
> executor (D4) picks it up.

### Honest constraints

Voice cloning has misuse risk. Anyone with 30 seconds of someone's
audio can produce a passable clone today; the technology is not
exotic. The guardrails:

- **Opt-in only.** A user creates a voice clone of *their own* voice,
  recorded live in the Lumo app on a device that has already passed
  the standard auth gate. No cloning from uploaded audio files. No
  cloning from samples scraped elsewhere.
- **Voice clone only of the authenticated user.** The product UI does
  not expose any way to clone a third party. The brain refuses any
  request that would synthesise a non-self voice.
- **No third-party-facing channels by default.** Voice-cloned
  playback is for the user's own ear (drafted reply read-back, JARVIS
  responses, confirmation summaries). Outbound voice on a phone call
  or voicemail is opt-in per channel and behind an additional
  warning UI. The default posture is "your voice clone never leaves
  your earpiece."
- **Watermarking.** Where outbound voice is enabled (Phase 4.5+), we
  add an audio watermark per the C2PA spec (or the moral equivalent)
  so Lumo-generated voice is detectable downstream.

Speaker biometrics has its own honesty constraints: it is
auth-*light*, not auth. A determined attacker with a recording of the
user can pass it. The mitigations: voice biometric is one factor of
two or three (device fingerprint, session age, geographic plausibility),
high-stakes confirmations always escalate to a second factor, and
the user can disable voice-biometric confirmation entirely.

### Cost shape

- Voice clone fine-tune: ~$5/run weekly per user on Modal GPU.
  Refresh is opt-in per user; not all users will refresh weekly.
  Realistic projection: 30% of Phase-4 users opt in, half refresh
  monthly = ~$300-500/mo at 1k MAU.
- Wake word: $0 marginal. Picovoice Porcupine has a per-device
  license that we pay annually as a flat fee. On-device, no cloud
  cost.
- Real-time STT (server-side fallback): $0.006/audio-min at
  current Modal pricing. At 5 minutes of long-form STT per
  user-week, ~$130/mo at 1k MAU.
- Voice biometric verification: marginal — the model fits in
  Cloud Run memory, the verification call is sub-100ms.

Total Anchor-2 cost shape: ~$500-700/mo at 1k MAU, dominated by
voice clone fine-tunes. Scales roughly linearly with user count,
sub-linearly with the opt-in rate which we expect to plateau.

---

## Infrastructure theme — Tool composition + planning DAGs

Today the orchestrator handles single tool calls and Sprint 3's
mission planner handles linear sequences (`step_order` is a strict
integer with no branches). JARVIS-grade missions need multi-step,
conditional, recovery-aware DAGs:

> "Book the flight. *If* it lands before noon, book the early hotel
> check-in. *If* not, push the dinner reservation back by an hour and
> notify the group. *Recover* if the booking fails by trying the
> second-ranked option from the marketplace rank, *then* the third."

Seven tools. Four conditionals. Three failure modes, each with its
own recovery branch. The current planner expresses this only as a
linear sequence with hand-coded steps; Phase 4 adds proper
control-flow primitives.

### Approach

Three options, in roughly increasing risk:

- **Adopt LangGraph.** Python-side framework for stateful agent
  graphs, integrates with our existing brain. Cons: Python-only,
  doesn't natively know about `mission_steps` rows, requires a
  bridge between the LangGraph state machine and our Postgres
  state machine. We end up with two state machines.
- **Adopt BAML.** Boundary-typed prompts and DAG-style flows. Cons:
  introduces a DSL learning curve, lock-in concerns, and again the
  bridge problem to our Postgres mission state.
- **Build our own DAG executor on top of `mission_steps`.** Add
  `mission_steps.depends_on jsonb`, `mission_steps.condition jsonb`,
  and a small expression evaluator (think jsonata-lite). The
  executor RPC `next_mission_step_for_execution` becomes
  `next_runnable_mission_step` with a topological filter. The
  rollback walker already handles reverse `step_order`; for a DAG
  it walks the reverse-topo order instead.

**Recommended: build our own.** The reasoning:

- We already have `mission_execution_events` as the audit primitive.
  Every node enter/exit/branch-decision becomes one more event row.
- We already have `FOR UPDATE SKIP LOCKED` as the concurrency
  primitive. Adding parallelism inside a single mission (two
  branches running concurrently) is a strict extension.
- The state machine in `lib/mission-execution-core.ts` is small,
  pure, and tested. Adding branching is incremental — a new step
  status `awaiting_dependencies`, a new transition table for
  conditional resolution, a new selector for the executor.
- The reversibility taxonomy already accommodates DAG rollback.
  Reverse-topological order is well-defined; the walker change is
  one helper function.

### Acceptance for the Phase-4 DAG sub-theme

A mission DAG with at least one branching node and one fallback
node executes end-to-end on production. Specifically:

- The mission has 5+ steps.
- At least one step has `condition` referring to a prior step's
  outputs (`{{outputs.flight.arrival_time}} < '12:00'`).
- At least one step has a fallback declaration so that on its
  failure the executor enters a sibling branch rather than failing
  the whole mission.
- All event types fire correctly:
  `step_started`, `step_succeeded`, `branch_chosen`,
  `branch_skipped`, `fallback_engaged`, `mission_completed`.
- Rollback (if invoked) walks reverse-topo and produces the same
  audit guarantees as the linear case from D5.

This is a meaty sprint — likely Sprint 4 of Phase 4. The
foundation primitives (DAG schema, condition evaluator, executor
selector) take one sprint; the worked Vegas-DAG demo and the
admin-side branch visualisation are a half-sprint each.

---

## Infrastructure theme — Agent runtime intelligence

The platform watching itself. Nothing user-visible directly, but
everything quietly faster and cheaper over time:

- **Connector failure prediction from error patterns.** Weibull or
  Cox proportional-hazards models over the existing
  `agent_tool_usage` failures. When a connector starts trending
  toward failure (5xx rate climbing, latency p95 climbing, schema
  validation errors appearing), the orchestrator either pre-emptively
  routes around it or warns admin before users notice.
- **Per-call cost + latency forecasting before dispatch.** The
  brain already exposes a `lumo_forecast_metric` tool; extend it to
  forecast tool-call cost and latency given the current load, time
  of day, and per-provider history. The orchestrator can use this
  to choose the cheaper provider when latency is acceptable, or the
  faster provider when the user is waiting on a confirmation card.
- **Prompt A/B framework with Thompson-sampling bandits across
  Claude/GPT/Gemini for each task class.** We already split traffic
  by task class; today the routing table is hand-set. Phase 4
  replaces it with online A/B where each task class has its own
  bandit over providers and prompt-template versions. Reward signal
  is a composite of completion-success, latency, and cost.
- **Drift detection on our own ML models.** `alibi-detect` or
  `evidently` for population drift on classifier inputs and
  prediction distributions. Alert when the moments classifier or
  the marketplace risk classifier drifts >threshold from the
  reference window. Threshold: 10-15% on a Jensen-Shannon
  divergence over a rolling 7-day window vs. the
  fine-at-deployment distribution.

### Walk-through

A connector that previously responded in 200ms p95 starts trending
toward 1.2s p95 over a 48-hour window. The runtime-intelligence
service publishes a `connector_health` row with a degraded badge.
Orchestrator routing weights the connector down for dispatches
where a substitute exists. Admin sees the badge in
`/admin/intelligence`. A week later the connector recovers, the
p95 returns, the badge clears automatically. No user ever knew.

A drifted classifier — say the marketplace risk classifier starts
producing more `medium` and fewer `low` scores than its reference
distribution — fires an alert. Admin reviews; if real (the agent
ecosystem genuinely got riskier), retrain on the latest window.
If spurious (a single anomalous tenant's traffic skewed the
distribution), apply a tenant-level filter and revert.

### Cost shape

Pure CPU. No GPU work in this theme — all the heavy lifting is
classical statistics over rows we already store. The dominant
cost is engineering time during Phase 4 to build the harness; the
runtime cost after that is marginal.

Estimated incremental: $20-50/mo at 5k MAU.

---

## Infrastructure theme — Active learning loop

Lumo asks when it's uncertain, learns from the answer.

- **Inbox classifier.** "This looks like a partnership ask, want me
  to draft a reply?" — user thumb-up/down feeds the next training
  round. The classifier already exists from Phase 1; today it's a
  one-shot prediction. Phase 4 adds the feedback loop and the
  uncertainty-aware ask-when-confused behaviour.
- **Marketplace risk scoring.** "Lumo flagged this agent as
  high-risk, was that right?" — calibrates the risk model. A small
  thumbs-down/thumbs-up affordance on each risk badge writes a
  labeled row. Weekly retraining incorporates labels.
- **Proactive moment relevance.** "Was this heads-up useful?" — the
  binary reward for the bandit (Anchor 1) plus a categorical "why
  not?" question on no-thumbs (irrelevant / wrong time / already
  knew / not actionable). The categorical reasons feed into the
  candidate-generation rules upstream of the bandit — if 30% of
  no-thumbs cite "already knew", the candidate generator learns to
  filter known-state moments.

### Network effect

Every user makes Lumo smarter for every other user — but only on
the per-tenant model that's then transferred to new users via
warm-start. We do **not** propagate raw labels across tenants in
Phase 4. Cross-tenant federation is opt-in only and lands in
Phase 5+ if there is demand.

The warm-start mechanism: when a new tenant onboards, their initial
classifier weights are the per-tenant aggregate of opted-in tenants'
weights, not the raw labels. This is differential-privacy-safe in
practice (no individual label is recoverable from the aggregate)
and gives a faster cold-start than starting from a generic prior.

### Privacy posture

Only labels (binary or numeric reward) and de-identified context
hashes cross tenant boundaries, never the raw text or the original
moment payload. The active-learning telemetry is its own table
(`active_learning_labels`) with strict columns: `user_id`,
`tenant_id`, `surface`, `candidate_hash`, `label`, `reason_code`,
`recorded_at`. No raw content. Deletion-respecting. Redacted.

---

## Phase 4 ship gate

Provisional. A single user, a real Friday afternoon, and Lumo:

1. **Greets the user with their voice clone speaking the morning
   brief.** "Good morning. Three things on your plate today —
   the contractor invoice, the Vegas dinner reservation, and the
   board prep deck. Which first?" The voice is clearly the user's
   own, the wake word fires, the brief is read back in under three
   seconds.
2. **Surfaces three personalised proactive moments selected by the
   bandit, not the static rules.** The audit row for each moment
   shows the bandit's reward estimate, the candidate pool size,
   and the explore/exploit split. Two of the three are actioned by
   the user during the day; one is dismissed. The dismissal feeds
   back into the bandit overnight.
3. **Executes a multi-branch mission.** "Plan dinner — try Place
   A, fall back to Place B if reservation fails, push the
   calendar event back by 30 minutes if neither has a 7pm slot."
   Five steps, two conditionals, one fallback. Lumo hits the
   conditional branch on Place A's failure, recovers to Place B,
   completes. The mission row, step rows, and event ledger
   reflect the DAG walk correctly.
4. **Records what the user clicked vs. ignored across all three
   surfaces, feeds back into nightly training.** The next day,
   the marketplace tile order has shifted, the proactive-moment
   selection has shifted, the mission planner has shifted —
   subtly, all three. The user does not need to read a release
   note to notice. They notice because Lumo *changed*.
5. **Wake-word "Hey Lumo, what's left on my plate" answers
   naturally.** On-device wake word, on-device STT, server-side
   recall + mission-state query, voice-cloned reply. End-to-end
   latency under 2.5 seconds. No always-listening server-side
   audio stream.

If that runs end-to-end on production with real telemetry, Phase 4
ships.

---

## Open architectural questions

The honest list. None of these have a single right answer; each is a
trade-off discussion the team will need to walk through at sprint
start.

1. **Where does the per-user model live?** Three options:
   (a) a column on `profiles` storing a serialised model artifact
   (simple, but expensive to update),
   (b) a separate `user_models` table keyed by `user_id`
   (clean, scales fine, more migrations),
   (c) a separate ML service entirely behind a versioned bucket
   (matches our existing classifier deployment pattern, highest
   operational surface). Recommend (b) for Phase 4 v1, escalate
   to (c) only if model artifact size exceeds a few hundred KB
   per user.

2. **Bandit choice — contextual or multi-armed?** Contextual
   (per-decision context features) gives better personalisation
   but is harder to debug and harder to certify privacy claims
   on. Multi-armed (decision-level only, candidate is the arm)
   is simpler and faster to ship. Recommend multi-armed for v1,
   migrate to contextual once we have a measurable improvement
   target and a stable feature set.

3. **Voice cloning consent UX — one-time opt-in or per-channel?**
   One-time is simpler but conflates "use voice clone for
   read-back" with "use voice clone on phone calls." Per-channel
   is more honest and gives users finer control. Recommend
   per-channel — the additional UI complexity is worth the
   clarity. Default for new channels is opt-out.

4. **DAG semantics — adopt LangGraph or build our own?** Discussed
   in the DAG section above. Build our own. Lock-in cost of
   LangGraph + bridge complexity to our Postgres state machine
   outweighs the savings. Re-revisit in Phase 5+ if we find
   ourselves rebuilding LangGraph features.

5. **Active learning — labels propagate to other users
   immediately, or only after a calibration pass?** Immediately
   risks single-bad-actor poisoning. Calibration-pass adds a
   12-48 hour latency. Recommend a per-tenant aggregation pass
   nightly; cross-tenant propagation only via the warm-start
   prior, not realtime.

6. **Drift detection — alert threshold and escalation policy?**
   Page on a weekend if the inbox classifier drifts 10%? Email
   only? The right answer depends on the blast radius of a
   drifted model. For the moments classifier, drift is recoverable
   on Monday. For the marketplace risk classifier, drift is
   user-visible and could affect installs. Recommend tier the
   thresholds: 10% drift = email; 20% = page during business
   hours; 30% = page anytime. Re-tune after first quarter of
   Phase 4 telemetry.

7. **Wake-word vendor lock-in.** Picovoice Porcupine is the
   pragmatic choice but is a commercial license. Open alternatives
   exist (`openWakeWord`, `precise`). Picovoice's accuracy and
   latency are meaningfully better today. Recommend Porcupine for
   v1, with a versioned wake-word interface so we can swap if
   Picovoice's pricing moves against us.

8. **Voice biometric fall-back when biometric fails.** A user
   with laryngitis can't say "Hey Lumo" today. A clear opt-out
   per session (or per day) is required, plus a graceful fall-back
   to text+device-fingerprint auth. Recommend: voice biometric
   never blocks confirmation entirely; it raises or lowers the
   *number* of additional factors required.

---

## Cost shape (Phase 4 incremental, estimated)

At 5k MAU, Phase 4 incremental over the Phase 3 steady state:

- Bandit training (nightly Modal jobs): $50-150/mo
- Voice cloning fine-tunes (opt-in, monthly refresh, ~30% adoption):
  $300-500/mo
- Wake word (on-device, flat license): $0/mo marginal, ~$3k/yr
  flat (Picovoice enterprise)
- Real-time STT (server fallback, 5 min/user/week long-form):
  $130-200/mo
- Drift detection + prompt A/B: $20-50/mo
- DAG executor (engineering only; runtime is negligible): $0
- Active learning storage + retraining: $30-60/mo

Total Phase-4 incremental: **~$530-1,000/mo at 5k MAU**, plus a
flat $3k/yr wake-word license. Sub-linear scaling above 5k MAU
because the dominant cost (voice clone fine-tunes) is throttled by
opt-in rate, not user count.

This is a planning estimate, not a vendor quote. Pricing assumptions
are Modal GPU at $0.0003/sec, Cloud Run at current quotas, Picovoice
enterprise at the published tier, Eleven Labs / Coqui assumed
self-hosted on Modal. All revalidated before each Phase-4 sprint
start.

---

## Phase 4 sprint plan (provisional)

Six sprints, mirroring Phase 3's pattern. Each sprint has a
demonstrable end-of-sprint moment. Don't over-detail; this is an
outlook not a binding plan.

### Sprint 0 — preference logging consumers

Read what Sprint 0 of Phase 3 wrote. Build the first reports —
"events per user per day", "actions vs. ignores by surface", "top
candidate ids per user" — over `preference_events`. No model
training yet. The deliverable is `/admin/intelligence/preferences`
showing the raw signal so we know it's clean before we train on
it.

End-of-sprint moment: an admin can click into any user and see a
30-day timeline of their click/dismiss pattern across surfaces.

### Sprint 1 — bandit MVP for marketplace ranking

`lumo_personalize_rank` tool, called by the marketplace tile
ordering code path only. Multi-armed bandit per user, per surface.
Nightly retraining on Modal. Fallback to existing static ordering
if the brain is unreachable.

End-of-sprint moment: a single user with >50 logged events sees
a measurably different marketplace tile order vs. a control user
with the same install state. The difference is auditable in
`/admin/intelligence` per-user.

### Sprint 2 — voice clone opt-in + drafted-reply playback

Voice clone enrollment UI (30-second sample, live recording, opt-in
checkbox). Backend fine-tune on Modal (weekly refresh). Drafted-reply
playback in the workspace inbox surface — when Lumo drafts a
reply to a partnership ask, the user can play the draft in their
own voice before sending.

End-of-sprint moment: a user enrolls a voice clone, generates a
drafted reply, plays it back. The voice is recognisably theirs.
Watermark is present in the audio file metadata.

### Sprint 3 — wake word client + on-device STT

Picovoice Porcupine integration on iOS/Android client. On-device
Whisper.cpp for short-utterance STT. End-to-end "Hey Lumo, what's
the weather" round-trip. No server-side always-listening.

End-of-sprint moment: a user says "Hey Lumo, what's left on my
plate" on a phone with no Lumo app open. The wake word fires
on-device, the utterance reaches Lumo, the answer comes back as
voice-cloned audio. End-to-end under 2.5 seconds.

### Sprint 4 — DAG executor + conditional missions

Migration adds `mission_steps.depends_on jsonb` and `condition jsonb`.
The executor RPC becomes branch-aware. The condition evaluator is a
small jsonata-style expression engine, restricted to the
already-stored output bag (no arbitrary code execution).
Mission planner emits at least one branching node and one fallback
node for the Vegas DAG demo.

End-of-sprint moment: the Vegas DAG demo from the ship gate runs
on a deployed preview. One branch is taken, one fallback engages,
the audit ledger shows every event. Rollback walks reverse-topo
correctly.

### Sprint 5 — agent-runtime intelligence (drift, prompt A/B)

Drift detection (`alibi-detect`) wired to the moments and risk
classifiers. Prompt A/B harness with Thompson-sampling across
providers per task class. Connector failure prediction surfaced as
admin badges. Nothing user-facing.

End-of-sprint moment: an injected drift in the moments classifier
fires the right alert; the prompt A/B harness shows a measurable
provider-routing shift on a deliberate latency degradation; the
connector failure predictor flags a degraded connector before the
user-visible 5xx rate hits 1%.

---

## Risks I'd flag at the board level

The honest list. Phase 4 is more ambitious than Phase 3, and the
risk profile is different.

- **Bandit feedback loops can amplify existing biases.** If the
  user happens to ignore restaurant suggestions for one bad week
  (sick, busy, traveling), the bandit then never surfaces them
  again, and the user thinks Lumo "stopped showing food stuff."
  Mitigation: forced exploration ε = 0.1 minimum; periodic
  re-enrollment surveys; never let any candidate's reward estimate
  fall below a floor. This is bandit hygiene, but it is easy to
  get wrong in v1.

- **Voice cloning misuse, even with our guardrails.** The clone
  artifact is in our infrastructure; if it leaks (incident, insider,
  vendor breach), it is a real harm to the user. Mitigation: clone
  artifacts encrypted at rest with per-user keys; clone artifacts
  never leave the synthesis service; deletion is hard-delete (not
  soft-delete) and tested quarterly. We will need a clear policy
  for what a "voice clone breach" incident response looks like
  before Sprint 2 ships.

- **Privacy posture.** Per-user models touch the regulated-asset
  line more directly than Phase 3's recall did. Recall stored
  embeddings of user data; preference models store *behaviour
  patterns over time*. The DPIA needs an update. Cross-tenant
  warm-start, even as an aggregate prior, deserves an explicit
  legal review. We should not assume Phase 3's posture extends
  unmodified.

- **Fine-tuning costs scale with users — could reach
  4-figures/mo faster than the cost shape suggests** if everyone
  opts into voice clone. Mitigation: monthly refresh cap per user;
  quality-gate gating (don't refresh if the existing clone scores
  above threshold against a fresh sample); explicit budget cap with
  a graceful degradation (best existing clone served, refresh
  paused) when monthly spend hits the cap.

- **DAG executor complexity could swamp the team if we
  over-build it before validating user demand.** Sprint 4 is the
  riskiest sprint because it touches the mission state machine
  that took all of Phase 3 to stabilise. Mitigation: ship the
  simplest possible DAG (one branch, one fallback) before we even
  think about parallel branches or nested DAGs. Resist scope creep.
  If Sprint 4 slips, push parallel-branch work to Phase 5.

- **Active learning poisoning.** A determined user (or a confused
  bot) could thumb-down everything for a week and skew their own
  bandit beyond recovery. Mitigation: per-user reset path in the
  workspace settings ("Lumo's been weird for me — start fresh");
  outlier detection on label streams to catch obviously poisoned
  labels (all 0s, all 1s, alternating patterns).

- **Voice biometric false-rejects on legitimate users.**
  Laryngitis, ambient noise, accent shift over time. If voice
  biometric ever blocks a legitimate confirmation, the user blames
  Lumo, not the technology. Mitigation: voice biometric is always
  a *factor*, never the sole gate. Easy fall-back to text-prompt
  confirmation. We measure false-reject rate per week and tune the
  threshold conservatively.

- **Vendor concentration.** Modal for retraining + voice clone +
  STT, Picovoice for wake word, Eleven/Coqui for synthesis. Three
  new vendors with payment relationships in Phase 4. Mitigation:
  vendor-isolation as we already do for Phase 3 brain tools — every
  vendor has a portable abstraction, every artifact is exportable,
  switching cost is bounded.

---

## What Phase 4 explicitly does NOT cover

The honest scoping list. Each of these is a real desire but stays
out of Phase 4 to keep the surface manageable.

- **Multi-Lumo coordination.** Two users' Lumos negotiating a
  shared mission, joint approval flows, cross-user mission DAGs.
  This was the original Phase 3 anchor in the early outlook,
  deferred to Phase 5+. Stays Phase 5+.
- **Self-extending sandbox.** The agent that writes its own
  Python scripts and runs them in E2B to answer ad-hoc compute
  questions. Same — the substrate exists, the UI doesn't, no
  Phase 4 surface adopts it. Phase 5+.
- **Cross-user federation of preference models.** Opt-in, with
  differential-privacy guarantees, with a clear opt-out path. Not
  in default Phase 4 plan. The warm-start prior is the most we do
  cross-tenant in Phase 4, and that's an aggregate, not a label.
- **Negotiation as a tool.** Lumo bargains with a vendor, with
  another Lumo, with a marketplace. Out of scope until the
  multi-Lumo coordination story is real. Phase 5+.
- **Real-time streaming intelligence.** Continuous brain
  inference on always-on data feeds (calendar, email, market
  data). Phase 4's proactive-moment cron is hourly/daily; real
  streaming is Phase 5+.
- **On-device model inference beyond wake-word + STT.** No
  on-device ranking model, no on-device confirmation classifier,
  no on-device drift detector. The wake-word + STT decision is
  privacy-driven; expanding it costs engineering time without a
  clear privacy benefit until users care.
- **Voice generation for non-self voices.** Cloning a colleague's
  voice, cloning a public figure's voice, cloning a fictional
  voice. Hard no, not just "out of scope" — actively refused at
  the brain layer.
- **Calendar-write actions from voice alone.** "Hey Lumo, book
  the flight" still drops to a confirmation card before any
  irreversible side effect, exactly as Phase 3's confirmation
  policy already enforces. Voice does not bypass confirmation.
- **Per-user fine-tuned LLMs for drafting.** A small per-user
  LoRA adapter for chat-drafting style is technically feasible but
  expensive. Phase 4 stays with prompt-side personalisation
  ("write in this user's general tone") rather than fine-tunes.
  Phase 5+ if the prompt-side ceiling is hit.

---

## When this outlook gets revisited

Drafted now (2026-04-27). Locked into a real Phase 4 ADR addendum
at the time Sprint 3 acceptance is recorded — that addendum should
take this document and convert it into binding sprint goals,
budget envelopes, and explicit owner assignments.

Re-revised at the start of each Phase-4 sprint as we learn what
actually ships vs. what we thought would. The cost shape, the
sprint plan, and the open questions in this document are the most
likely sections to drift; the anchors and infrastructure themes
should hold barring a major external shift.

A second outlook draft (Phase 5) gets started roughly halfway
through Phase 4 — at the end of Sprint 3 (wake word + STT) — once
we have empirical signal on which Phase-4 themes paid off and
which under-delivered. Phase 5's anchors should be informed by
that data, not by what we thought at the start of Phase 4.

---

## Appendix — Phase 3 closing position (recap, for grounding)

Mirror of the ADR's Phase 3 outlook section so this document stands
on its own without forcing a flip back to the ADR. As of the ship
of D5 on 2026-04-27:

- Migration 023 shipped the durable mission tables. Migration 024
  added confirmation-card linkage and `awaiting_confirmation` /
  `ready` step states. Migration 025 added rollback —
  `rolling_back` mission state, `rollback_failed` step status,
  `mission_step_rollback_attempts`, the
  `next_rollback_step_for_execution` RPC.
- The forward executor (D4) and rollback executor (D5) are both
  default-off in production via `LUMO_MISSION_EXECUTOR_ENABLED` and
  `LUMO_MISSION_ROLLBACK_ENABLED`. Both stay off until preview
  smoke tests verify the event ledger and admin mission surface
  end-to-end.
- The Phase 3 ship gate is a single Vegas trip mission running
  end-to-end on production with the five-state forward path
  (`ready → executing → awaiting_confirmation → ready →
  completed`) plus a successful rollback smoke test on a mission
  with at least one compensating-succeeded step and at least one
  irreversible-skipped step. Phase 4 work begins on the day that
  ship gate is signed off — not before.

Phase 4 is a continuation, not a pivot. Phase 3 built the durable
substrate; Phase 4 makes it personal.
