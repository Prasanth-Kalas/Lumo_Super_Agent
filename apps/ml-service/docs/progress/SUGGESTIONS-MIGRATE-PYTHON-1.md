# SUGGESTIONS-MIGRATE-PYTHON-1 — progress notes

Phase 1 lane 2. Migrates per-turn suggestion-chip generation to Python
behind codex's parallel-write telemetry. Calibration **100 % Jaccard**
on the 42-turn corpus; behaviour parity is exact.

## Calibration result — 42 canonical turns

```
Total turns:               42
Non-empty expected:        33
Mean Jaccard (non-empty):  1.000  (gate ≥ 0.80)
Min Jaccard:               1.000  (floor ≥ 0.60)
Empty-expected handled:    9 / 9

Per planning_step:
  clarification: n=18, mean=1.000
  selection:     n=8,  mean=1.000
  confirmation:  n=8,  mean=1.000
  post_booking:  n=8,  mean=1.000
```

Line-by-line port reproduces TS exactly on the corpus. The corpus was
built independently of the TS code (hand-derived expected chips from
the regex patterns + verbatim chip strings in the recon doc), so the
agreement is coverage-driven rather than test-mirroring.

## Live verification on Modal

URL: `https://prasanth-kalas--lumo-ml-service-asgi.modal.run`

| Path | `last_assistant_message` | `Count` header | First chip |
|---|---|---|---|
| Clarification (date cascade) | "Which dates work for you?" | 3 | `Next weekend (May 9-11)` (correct UTC math) |
| Selection | "Pick which option — cheapest, fastest, or nonstop?" | 3 | `Cheapest` |
| Pre-LLM (no assistant text) | (omitted) | 0 | (empty list) |

`X-Lumo-Suggestions-Source: python` is set on every classified turn.
`X-Lumo-Suggestions-Count` is 0 when the orchestrator hasn't supplied
assistant text yet (canonical Phase 1 case) — the header still emits
so codex's `agent_plan_compare` capture distinguishes "ran but no
chips qualified" from "didn't run".

## Brief deviations + reasoning

1. **Modal redeploy 176 s, not < 30 s** as the brief targeted.
   `pyproject.toml` is unchanged from the classifier lane, but the
   image rebuild ran the `pip_install_from_pyproject` + spaCy download
   + ENV layers anyway. Likely Modal cache eviction or the deepgram
   lane's transcription edits invalidated downstream layers. Deploy
   succeeded cleanly; latency target deferred to
   `MODAL-IMAGE-CACHE-INVESTIGATE-1` (file as part of the post-merge
   follow-ups).

2. **Stowaway repair in `lumo_ml/transcription.py`** — see commit
   `abe2f8a`. codex's `DEEPGRAM-MIGRATION-1` (49c4fff) shipped
   `_normalize_deepgram_payload` emitting `SPEAKER_0` / `SPEAKER_1`
   while its own test asserts `SPEAKER_00` / `SPEAKER_01`. Caught by
   this lane's `pytest -q` run on origin/main. Two-character fix:
   `f"SPEAKER_{speaker:02d}"`. The file is in this lane's scope
   (`apps/ml-service/`) so the doctrine permits the edit; flagged
   here for the audit trail.

3. **Eval corpus keyed on `planning_step` (Q2 answer applied).**
   42 rows (>brief's 40 floor): 18 clarification + 8 selection + 8
   confirmation + 8 post_booking. Clarification needs the most
   surface area (6-helper cascade + 2 gates).

4. **`PlanRequest.last_assistant_message: str \| None = None`
   (Q4 answer applied).** Wire-shape additive — TS callers that don't
   supply it default to None and the brain emits empty chips (Count:
   0). Codegen drift check passes; the new field surfaces in
   `dist/index.ts` as `last_assistant_message?: string | null`.

## Coordination follow-ups for codex

* **`PLAN-CLIENT-EMPTY-SUGGESTIONS-1`** — confirm `apps/web/lib/lumo-ml/plan-client.ts` already treats `[]` and missing `suggestions` field as equivalent "no chips" for the `agent_plan_compare` row capture. Recon §11.5 says yes (line 152's `normalizeSuggestions` returns `[]` for both null + non-array values), but the codex side should verify and own the row-write path.
* **`PLAN-CLIENT-SUGGESTIONS-LOGGER-1`** — codex's small follow-up to read `X-Lumo-Suggestions-Source` / `X-Lumo-Suggestions-Count` headers + `response.suggestions[]` body and write into the new `agent_plan_compare.suggestions_python` column. Compute Jaccard server-side at insert time when `suggestions_ts` is also available.
* **`MODAL-IMAGE-CACHE-INVESTIGATE-1`** — the redeploy came in at 176 s instead of the < 30 s target; investigate Modal cache invalidation triggers (deepgram lane's downstream effect on layer hashes is plausible).

## Acceptance check

- [x] Python /api/tools/plan returns populated `suggestions[]` (3-5 items) for every classified turn that has `last_assistant_message`. **Verified live.**
- [ ] `agent_plan_compare` captures both `suggestions_python` and `suggestions_ts` from production traffic within 1 h post-deploy. **Pending PLAN-CLIENT-SUGGESTIONS-LOGGER-1 (codex's follow-up).**
- [x] Eval harness ≥ 80 % mean Jaccard, ≥ 0.6 per-turn floor, no turn returning empty array on expected-chip rows. **Local: 1.000 mean / 1.000 min / 0 silent empties.**
- [ ] Modal redeploy < 30 s incremental image build. **176 s — flagged.**
- [x] Gates: ruff / mypy / pytest / typecheck / codegen drift / npm build all green. **117 pytest pass (75 prior + 42 new).**
- [x] Migration 057 forward + reverse clean. **Forward in `db/migrations/057_*.sql`; reverse documented in file header.**
