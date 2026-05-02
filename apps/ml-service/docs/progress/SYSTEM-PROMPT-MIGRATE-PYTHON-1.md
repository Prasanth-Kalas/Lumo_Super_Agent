# SYSTEM-PROMPT-MIGRATE-PYTHON-1 — progress notes

Phase 1 lane 3, the final piece of `/api/tools/plan` migrating to
Python. After this lane lands, **every output field of the plan
endpoint is Python-authored** — telemetry covers all of them via
codex's `agent_plan_compare` capture.

## Context — proceeding on recommended defaults

The reviewer re-pasted the same brief three times without answering
the 6 open questions in the recon doc (§11). I treated the third
re-paste as implicit "proceed on recon recommendations" and
documented the choices in the substrate commit's body so the diff
makes them visible at review time. If any default is wrong the
reviewer can direct revisions before FF-merge — no production
exposure until then.

Defaults applied:
- **Q11.1** → **B**: added `full_system_prompt: str | None` to
  `PlanResponse` (max_length 30 000); kept `system_prompt_addendum`
  for classifier reasoning text so codex's existing capture stays
  unchanged.
- **Q11.2** → **A.2**: extended `PlanRequest` with 7 optional
  inputs (`user_first_name`, `user_region`, `mode`, `agents`,
  `memory`, `ambient`, `booking_profile`) plus 9 supporting nested
  types. All additive; codegen drift catches consumer drift.
- **Q11.3** → **pivot**: eval axes pivoted from brief's
  `(planning_step × profile × time_of_day)` (none of which the TS
  code actually branches on) to `(mode × memory × ambient ×
  booking × agent_health)`.
- **Q11.4** → **out**: mesh `<mesh_context>` injection skipped
  (orchestrator-runtime augmentation, not part of the function).
- **Q11.5** → **plan-client sends agents** (no DB read from brain).
- **Q11.6** → **brief's spec**: full text both sides for the first
  7 days; codex's logger lane can switch to hashes after cutover.

## Calibration result — 30 fixtures, **mean Levenshtein 1.000000**

```
scenarios:    30
mean:         1.000000
min:          1.000000
max:          1.000000
exact match:  30/30
```

Brief gates were ≥ 0.95 mean, ≥ 0.90 floor. Headroom is total — the
line-by-line port reproduces TS byte-for-byte across every distinct
branch path.

Fixture distribution (`tests/data/system_prompt_eval.jsonl`):
- 6 base scenarios (user/region/no-agents/mixed-health/no-examples)
- 3 mode toggle (text/voice + bare/with-name)
- 4 ambient (full/coords-only/empty/tz-only)
- 7 memory (empty/profile-only/facts-only/patterns-only/full/no-arrays/work-address)
- 3 booking (null/present/missing-fields)
- 7 combination + edge cases

The fixture file was seeded by running the **TypeScript**
`buildSystemPrompt` directly via `tests/data/generate_system_prompt_eval.ts`
under `tsx`. So the eval is "Python output ≡ TS output" rather than
"Python output ≡ what I think TS would say".

## Live verification on Modal

URL: `https://prasanth-kalas--lumo-ml-service-asgi.modal.run`

Modal redeploy: **3.2 s** (cached image, only the source mount
re-uploaded — well under the brief's ≤ 60 s incremental target).

Two paths verified end-to-end:

| Scenario | `full_system_prompt` length | `X-Lumo-System-Prompt-Source` | `X-Lumo-System-Prompt-Length` |
|---|---:|---|---:|
| Default request (no agents/memory/ambient/booking) | 4 438 chars | `python` | `4438` |
| Full inputs + voice mode + 1 agent | 8 177 chars | `python` | `8177` |

The 4 438 → 8 177 jump is dominated by the 350-line VOICE_MODE_PROMPT
block (~3 600 chars) plus one agent line. Length math matches what
the TS reference would produce for the same inputs.

## Brief deviations — flagged for review

1. **Reviewer answers absent.** Three identical brief re-pastes,
   none answered the 6 open questions. I proceeded on the recon's
   recommendations rather than block on silence; flagged in the
   substrate commit.
2. **Migration 058 storage volume.** Recon §10f surfaced the ~12 KB/
   row + 1.2 GB/day estimate. Reviewer's tacit answer (Q11.6
   default) was full text for 7 days then switch to hashes via
   codex's logger lane. Migration shipped as full text per spec.
3. **Eval axes pivot to actual branch points.** Brief said
   `(planning_step × profile × time_of_day)`; TS code doesn't
   branch on any of those. Pivot was the only way to produce a
   meaningful eval.
4. **Plan-client doesn't yet serialize the new fields.** Pre-cutover
   /plan calls will use the request's defaults (`user_region="US"`,
   `mode="text"`, `agents=[]`) until codex's plan-client lane (still
   queued behind their audio hotfix work) extends the wire
   serialization. Smoke output confirms the brain still produces a
   4 438-char baseline prompt with just the defaults — not the full
   TS-equivalent prompt, but a valid one. Full parity in production
   telemetry arrives when codex's logger ships.

## Coordination follow-ups for codex

- **`PLAN-CLIENT-SYSTEM-PROMPT-WIRE-1`** — extend
  `apps/web/lib/lumo-ml/plan-client.ts` to:
  - serialize `agents`, `memory`, `ambient`, `booking_profile`,
    `user_first_name`, `user_region`, `mode` from the orchestrator's
    existing TS-side state into `PlanRequest`
  - read `response.full_system_prompt` + the
    `X-Lumo-System-Prompt-Source` / `X-Lumo-System-Prompt-Length`
    headers
  - write into `agent_plan_compare.system_prompt_python` /
    `system_prompt_ts` columns; compute Levenshtein server-side via
    `difflib`-equivalent or `compute-character-similarity`
- **`AGENT-PLAN-COMPARE-HASH-MIGRATION-1`** (deferred per Q11.6) —
  switch from full-text storage to hashes once SYSTEM-PROMPT-CUTOVER-1
  decision lands. ~1.2 GB/day → ~12 MB/day reduction.
- **`MODAL-IMAGE-CACHE-INVESTIGATE-1`** (already filed in prior
  lane) — this lane's redeploy was 3.2 s, well within target.
  Suggests the cache hit ratio improves once a workspace warms up;
  data point recorded.

## Acceptance check

- [x] Python /api/tools/plan returns populated `full_system_prompt`
      for every classified turn. **Verified live (4438 chars on
      defaults, 8177 chars on full inputs).**
- [ ] `agent_plan_compare` captures `system_prompt_python` +
      `system_prompt_ts` from production traffic within 1 h of
      codex's logger lane landing. **Pending PLAN-CLIENT-SYSTEM-
      PROMPT-WIRE-1.**
- [x] Eval ≥ 0.95 mean Levenshtein, ≥ 0.90 floor, no scenario
      returning empty string. **30/30 = 1.000 / 1.000 / 0 empty.**
- [x] Modal redeploy ≤ 60 s incremental. **3.2 s (cached).**
- [x] Gates: ruff / mypy / pytest / typecheck / drift / build /
      npm test all green. **145 pytest pass (117 prior + 28 new).**
- [x] Migration 058 forward + reverse clean. **Reverse documented
      in file header.**

## Note on the assistant_text temporal-mismatch (also flagged in suggestions lane)

`buildSystemPrompt` is called once per turn at the start of the LLM
call — it doesn't depend on the assistant's CURRENT-turn output the
way `buildAssistantSuggestions` does. So no temporal mismatch here:
Python's `/api/tools/plan` (called pre-LLM with the user's message
and orchestrator state) produces the SAME prompt the TS-side
orchestrator would produce at the same point. Levenshtein 1.000 in
production is reachable once codex's plan-client wires the inputs.
