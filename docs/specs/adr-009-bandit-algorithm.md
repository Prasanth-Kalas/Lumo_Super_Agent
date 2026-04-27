# ADR-009 — Bandit Algorithm

**Status:** Accepted (sealed 2026-04-27). Codex BANDIT-1 implements against this ADR.
**Authors:** Coworker A (architecture pass), reviewed by Kalas.
**Related:** `docs/specs/lumo-intelligence-layer.md`,
`docs/specs/phase-4-outlook.md` (Anchor 1), `docs/specs/phase-3-master.md` (BANDIT-1 entry).
**Implements:** the per-user contextual learner that re-ranks marketplace
tiles, proactive moments, and chat suggestions based on
`preference_events` history.

---

## 1. Context

`preference_events` has been logging from Phase-2 Sprint 0 onwards.
Today nothing reads it. Marketplace tile ranking uses tenant aggregates
at best; proactive-moment selection runs on static thresholds;
chat-suggestion order comes from a hand-set template. Phase-4 thesis
(personalisation as the user-facing anchor) requires a learner that
turns those click/dismiss/install rows into ordering decisions in the
hot path.

The substrate is small:

- `preference_events(user_id, surface, candidate_id, event_type, context jsonb, recorded_at)`
  with `event_type ∈ {impression, click, dismiss, dwell, install,
  action_completed}`.
- ~1k MAU at Phase-4 launch projection. Median user logs 30-80 events
  per week across all surfaces. P95 user logs 300+.
- Three hot-path consumer surfaces:
  - **Marketplace** — re-rank a candidate set of 5-50 agent tiles.
  - **Proactive moments** — pick 3 of 15-20 generated candidates.
  - **Chat suggestions** — rank 4-8 follow-up prompts.

The decision is *which* learner to start with, and what the promotion
ladder looks like.

---

## 2. Options considered

### Option (A) — LinUCB (linear upper-confidence-bound)

Contextual bandit. Each candidate is an arm; each decision carries a
context vector (user, surface, time-of-day, recent-action-count, etc.).
Learner maintains a linear model `θ_a` per arm; chooses
`argmax_a (xᵀ θ_a + α√(xᵀ A_a⁻¹ x))`.

**Pros.** Strong cold-start behaviour. The exploration bonus is
explicitly UCB-shaped, so a brand-new candidate gets a deterministic
"explore me" budget without a hand-tuned ε. Linear-algebra-cheap;
inference is one matrix-vector multiply per arm. Well-studied in news
and ad ranking.

**Cons.** The UCB bonus is conservative — slower to exploit a
clearly-winning arm than Thompson is. Confidence radius α is a
hyperparameter that has to be tuned per surface.

### Option (B) — Thompson sampling

Bayesian. Each arm carries a posterior over its expected reward.
At decision time, draw one sample per arm, pick the argmax of the
samples.

**Pros.** Best-known empirical performance once the posteriors are
informative (>~100 reward events per arm). Naturally handles
non-stationary reward distributions if we use a forgetting factor.

**Cons.** Cold-start is rough: the posterior is barely informative
in the first few decisions, so early picks are essentially random,
which feels broken to users. Implementation complexity is higher
(beta-Bernoulli for binary rewards is easy; the contextual variant
with a Gaussian prior over linear weights is harder to get right).

### Option (C) — Multi-armed bandit (no context)

ε-greedy or UCB1 over candidates with no context features.

**Pros.** Simplest. Ships fastest.

**Cons.** Loses the per-user signal that is the entire point of the
system. A multi-armed bandit at the surface level would just learn
"on this surface, candidate X is popular on average" — which is what
the existing tenant aggregate already does.

---

## 3. Decision

**We ship LinUCB initially, with documented promotion to Thompson
sampling once any user accumulates ≥100 reward events on a given
surface.**

The reasoning:

- Cold-start determines whether users perceive the system as
  "smart on day one" or "broken until it has data." LinUCB's
  explicit exploration bonus gives us a defensible cold-start
  story. Thompson does not.
- Once a user has crossed the 100-event threshold on a surface, the
  posterior is informative enough that Thompson's empirical lead
  shows up. We promote per-user, per-surface — not globally.
- Both algorithms share the same arm/reward/context shape. Promotion
  is a code path switch, not a data migration.

---

## 4. Arm structure

**Per-user arms, with a per-cohort prior for cold-start.**

- A user with <50 logged events on a surface inherits the
  tenant-cohort prior for `θ_a` and `A_a` initial weights. The
  cohort is a small clustering of users by surface-engagement
  shape (low/medium/high event volume × installed-agent count).
  Three cohorts per surface, recomputed weekly.
- A user with ≥50 events transitions to per-user weights
  initialised from the cohort prior. After 50 events the
  cohort prior is no longer mixed in.
- Per-user arms persist across sessions in
  `bandit_user_models(user_id, surface, model_version,
  weights_jsonb, updated_at)`.

This is the "warm start" pattern — every user benefits from the
tenant's aggregate experience until they've generated enough
personal signal to override it.

---

## 5. Reward taxonomy

Reward is a small integer scale, not a probability. The taxonomy:

| Event | Reward |
|---|---|
| `dismiss` | -1 |
| `impression` (no action) | 0 |
| `viewed` (dwell > 3s, no click) | 0 |
| `click` / `accepted` | +1 |
| `install` (marketplace only) | +2 |
| `action_completed` (mission step succeeded after suggestion) | +2 |

Rewards are summed per `(user_id, surface, candidate_id)` in a daily
materialised view. A candidate with reward = -1 in the same session
where it later got a click resolves to net 0; the bandit reads the
net daily reward.

Edge cases:

- A candidate that is dismissed and then re-surfaced in the same
  session: counted once (the dismiss); the re-surface is suppressed
  by upstream candidate-generator logic, not by the bandit.
- A candidate that is acted on multiple times in a single day: capped
  at +2 daily to prevent any single super-engaged user from
  dominating the per-user posterior.
- Reward arrives asynchronously (`action_completed` may land hours
  after the click). Updates are eventually consistent; the nightly
  retraining pass picks up late-arriving rewards.

---

## 6. Context features

The context vector `x` per decision is small and stable:

| Feature | Type | Notes |
|---|---|---|
| `surface` | one-hot (marketplace / moments / chat) | 3 dims |
| `hour_of_day_bucket` | one-hot (morning/afternoon/evening/night) | 4 dims |
| `day_of_week_bucket` | one-hot (weekday/weekend) | 2 dims |
| `recent_action_count_7d` | scalar, log-scaled | 1 dim |
| `installed_agent_count` | scalar, log-scaled | 1 dim |
| `has_active_mission` | binary | 1 dim |
| `candidate_category` | one-hot (varies per surface) | 5-10 dims |
| `candidate_is_new_to_user` | binary | 1 dim |

Total: ~18-23 dims per decision. Small enough for LinUCB matrices
to invert in microseconds; large enough to capture the meaningful
contexts.

Forbidden context features (privacy/policy):

- Raw user-content text. Never.
- Cross-user signals from other tenants.
- Feature derived from `user_facts` content. (Class-of-user signals
  derived from facts are computed offline and shipped as the cohort
  prior, not as a per-decision feature.)

---

## 7. Online vs. nightly updates

**Hybrid: nightly batch training + online incremental updates for
high-confidence rewards.**

- **Nightly batch.** Modal job at 03:00 UTC walks
  `preference_events` from the last 24h, recomputes
  `θ_a`/`A_a` per user/surface/arm, writes new weights to
  `bandit_user_models`. The job is per-user; runs only for users
  with >5 new events since the last refresh. Cost target: <
  $50/mo at 1k MAU.
- **Online increments.** When a click or install lands, the brain
  receives a `lumo_log_outcome` call. If the user has crossed the
  cold-start threshold (>50 events), the increment is applied
  in-memory to the running model and persisted within the same
  hour. Dismisses and impressions are batched-only — only positive
  rewards get the online path.

The split keeps the hot path fast (no synchronous training on a
click) while ensuring a high-signal positive reward influences the
next decision within an hour rather than the next day.

---

## 8. A/B harness

A single environment-variable flag plus a per-user assignment:

- `LUMO_BANDIT_ENABLED` — service-level kill switch. When false,
  every surface falls back to the existing rule-based scoring.
  Default false in production until BANDIT-1 acceptance.
- Per-user A/B assignment via a stable hash of `user_id` →
  `{control, treatment}`. Treatment users see bandit-ranked
  output; control users see the existing rule-based output.
  Ramp: 10% treatment week 1, 50% week 2, 100% week 3 (assuming
  no regression on guard metrics).
- Guard metrics tracked daily during the ramp:
  - Surface-level CTR (must not drop > 10% vs. control).
  - Surface-level dismiss rate (must not climb > 15% vs. control).
  - Mission-step completion rate downstream of suggestion clicks
    (must not drop > 5% vs. control).
- Auto-rollback if any guard breaches for 48 consecutive hours.
  Auto-rollback flips `LUMO_BANDIT_ENABLED=false` and pages on-call.

---

## 9. Graceful fallback

The bandit is a *re-ranker*, not a generator. The candidate pool is
always produced by the existing rule-based code paths. When the
bandit is unreachable, malformed, or times out:

- **Marketplace** falls back to the existing
  `lib/marketplace-intelligence.ts` deterministic ranking.
- **Proactive moments** falls back to the existing static rules in
  `proactive-scan` cron.
- **Chat suggestions** falls back to the existing template order.

Hot-path budget per call:

- Marketplace re-rank: p95 < 250ms.
- Proactive-moment re-rank: p95 < 200ms (in cron, not user-facing,
  but bounded so the cron run finishes).
- Chat-suggestion re-rank: p95 < 200ms.

Timeouts trigger the fallback silently; the audit row in
`agent_tool_usage` records the timeout for ops visibility.

---

## 10. Promotion ladder to Thompson sampling

A user-surface pair promotes from LinUCB to Thompson sampling when:

- Total reward events on that pair ≥ 100.
- Per-arm minimum reward events ≥ 10 for at least 5 arms.
- Last-30-day CTR on that surface for that user is stable
  (variance < 25%).

Promotion is a per-pair flag stored on `bandit_user_models`. Once
promoted, the LinUCB weights become the Thompson posterior's prior
mean. We do not unwind promotions — once a user is on Thompson for a
surface, they stay there.

The Thompson implementation lands as a Phase-4 Sprint-2 deliverable
behind `LUMO_BANDIT_THOMPSON_ENABLED`. It is **not** in BANDIT-1.

---

## 11. Acceptance criteria for BANDIT-1

BANDIT-1 ships when:

1. Two new brain tools live on Cloud Run:
   `lumo_personalize_rank(user_id, surface, candidates[], context)`
   returning `{ ordered_candidate_ids[], reward_estimates[],
   explore_split, model_version }`, and
   `lumo_log_outcome(user_id, surface, candidate_id, reward,
   context)`.
2. Marketplace, moments, and chat-suggestion code paths call the
   re-ranker with the documented timeouts and the documented
   fallback.
3. The Vegas test user, with >50 seeded `preference_events`,
   sees a measurably different marketplace tile ordering vs. a
   control user with the same install state. The difference is
   auditable via `/admin/intelligence/preferences/<user_id>`.
4. Nightly retraining cron writes new
   `bandit_user_models` rows; CI verifies the writes for the
   Vegas test user across 3 consecutive nightly runs.
5. The A/B harness is wired: `LUMO_BANDIT_ENABLED` and per-user
   assignment work; guard metrics are surfaced in
   `/admin/intelligence/ab`.
6. Held-out eval: against a 30-day replay of `preference_events`,
   bandit-ranked output achieves CTR ≥ 1.15× the rule-based
   baseline on at least one of the three surfaces. (We do not
   require improvement on all three for v1 — moments and chat
   may regress at first; marketplace is the must-win.)

---

## 12. Privacy and audit

- Bandit weights are per user, never cross-tenant in v1. Cohort
  priors are aggregated from opted-in users only and stored as
  three small vectors per surface — no individual user is
  recoverable from the cohort prior.
- Every bandit decision writes an audit row in `agent_tool_usage`
  with `tool_name='lumo_personalize_rank'` and a redacted context
  payload (no candidate text, only candidate ids).
- Users can reset their bandit ("Lumo's been weird for me — start
  fresh") via a workspace settings action. Reset clears
  `bandit_user_models` rows for that user and re-initialises from
  the cohort prior at the next training run.
- Deletion of user account cascades to `bandit_user_models` via
  FK on `user_id`.

---

## 13. Risks and mitigations

| Risk | Mitigation |
|---|---|
| Feedback loop amplifies a one-week dismissal pattern | Forced exploration α floor; periodic "show me what I haven't seen" UI affordance; cohort prior re-mixing if user CTR collapses |
| Cold-start picks feel random to a new user | Cohort prior + α-weighted exploration produces deterministic-feeling exploration in week 1 |
| Reward labelling noise (user dismissed by accident) | Daily aggregation smooths single-event noise; outlier detection on label streams flags obviously poisoned patterns |
| Online updates inconsistent with batch | Same training code path runs in both; the online increment is the same matrix update applied incrementally |
| Latency budget breach on Cloud Run cold start | Pre-warmed Cloud Run min-instance = 1 during peak; client-side fallback if Brain doesn't answer in 250ms |
| A/B guard metrics regress | Auto-rollback flips the flag and pages on-call; LUMO_BANDIT_ENABLED=false is a safe default |
| Cross-tenant leakage via cohort prior | Cohort is computed only over opted-in users; the prior is three vectors per surface, no per-user gradient |

---

## 14. Open questions

1. Cohort recomputation cadence — weekly is the proposal; could
   tighten to daily once we see how stable cohort assignments are.
   Defer to first post-launch retro.
2. Should `dismiss` carry `-1` or `-2`? Stronger negative reward
   accelerates exploitation but risks the "user dismissed once
   means never see again" failure mode. v1 uses -1; revisit at
   first retro.
3. Should we persist the explore-vs-exploit split per decision for
   downstream analytics? v1 yes (it's one int per row); v1.5 may
   add a chart.
4. Does the marketplace surface get a separate model from the
   moments surface, or can they share weights with surface as a
   feature? v1 separates them (cleaner posterior interpretation);
   future work may merge.

---

## 15. Decision log

| Date | Decision |
|---|---|
| 2026-04-27 | Adopt LinUCB as the v1 algorithm; documented promotion to Thompson at ≥100 events |
| 2026-04-27 | Per-user arms with cohort prior warm-start (3 cohorts per surface, weekly recomputation) |
| 2026-04-27 | Reward taxonomy: dismiss -1, viewed/impression 0, click/accepted +1, install/action_completed +2 |
| 2026-04-27 | Hybrid update: nightly batch + online increments for positive rewards only |
| 2026-04-27 | A/B harness via LUMO_BANDIT_ENABLED + per-user hash assignment; auto-rollback on guard breach |
| 2026-04-27 | Bandit is a re-ranker only; candidate pool generation stays in existing code paths |
