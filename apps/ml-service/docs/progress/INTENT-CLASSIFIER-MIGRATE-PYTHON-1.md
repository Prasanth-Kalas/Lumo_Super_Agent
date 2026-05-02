# INTENT-CLASSIFIER-MIGRATE-PYTHON-1 — progress notes

Phase 1's first lane. Replaces the `/api/tools/plan` stub body with
real anchor-based intent classification mirroring the TS reference at
`apps/web/lib/perf/intent-classifier.ts`.

## Calibration result — local Mac (51-message eval corpus)

```
overall: 49/51 = 96.1 %
  fast_path:      15/17 = 88.2 %
  tool_path:      17/17 = 100.0 %
  reasoning_path: 17/17 = 100.0 %
disagreements:
  - 'what does HTTP stand for':  expected=fast_path, got=reasoning_path
  - 'what is 2 plus 2':          expected=fast_path, got=reasoning_path
```

Brief target was ≥85 %. Both per-bucket recall floors (≥70 %) cleared
on every bucket. The two remaining disagreements are short
"what is X / what does X stand for" messages where the message
embedding is too short to develop strong cosine similarity to any
bucket; the classifier defaults to `reasoning_path` (the safer fallback,
matching the TS classifier's `Low confidence defaulted to reasoning
path` behaviour). These are documentable cases for codex's parallel-
write to compare against the LLM ground truth — if codex's telemetry
confirms TS classifies them as `fast_path`, a follow-up tightening of
fast-path anchors closes the gap.

## Live verification on Modal

URL: `https://prasanth-kalas--lumo-ml-service-asgi.modal.run`

Image rebuild: 173 s (sentence-transformers + new `ENV` layers re-baked
the image; the lumo_ml source mount stayed cached). The Modal Volume
`lumo-ml-models` was created on first deploy (`create_if_missing=True`)
and seeded with the all-MiniLM-L6-v2 weights when the asgi function's
warmup() ran.

Brief's three canonical messages, all returning `x-lumo-plan-stub: 0`:

| Message | `intent_bucket` | `system_prompt_addendum` |
|---|---|---|
| `hi` | `fast_path` | `anchor-similarity fast_path (top=0.285, gap=0.194)` |
| `book me a flight to Vegas` | `tool_path` | `matched flight-search guard (regex)` |
| `plan a Vegas weekend with flight, hotel, and dinner reservations` | `reasoning_path` | `anchor-similarity reasoning_path (top=0.257, gap=0.011)` |

The flight-search guard fires on the second message before the
embedding step runs; the third message's `top=0.257, gap=0.011` is
characteristic of a hard case where two buckets score similarly and
the runner-up was tool_path — yet the top is correct, which is the
discrimination the new confidence model preserves (the previous gap×4
threshold would have downgraded it to reasoning_path by accident).

### Old-vs-new container drain

The first two requests right after redeploy hit a *previous-version*
container still warm from before the deploy and returned `x-lumo-plan-
stub: 1` with the Phase 0 stub body. Modal drains those over time;
within ~30 s of the redeploy completing, all traffic moved to new
containers. This is normal for `min_containers=1` Modal apps and not
specific to this lane — flagging because it briefly looked like a
deploy failure.

## Latency — `/api/tools/plan` warm, Mac → Modal

10 warm calls with the body `{"user_message":"hi", ...}` (which goes
through embedding, not the regex shortcut):

| Metric | Value |
|---|---:|
| min | 0.769 s |
| **p50** | **0.832 s** |
| **p95** | **1.629 s** |
| max | 1.629 s |

Comparable to `/api/health` latency from
`MLSERVICE-MODAL-DEPLOY-1` (827 ms p50) — the classifier itself adds
< 50 ms of in-container compute, the dominant cost is the same TLS +
Modal edge-routing baseline already filed under `MODAL-LATENCY-
OPTIMIZE-1`. Brief's 200 ms target is unattainable from a Mac client
without that follow-up; expected to improve materially on Vercel-
edge → Modal once codex's `PLAN-CLIENT-TS-PARALLEL-WRITE-1` is wired.

## Brief deviations

- **Confidence model.** The brief's recommended approach said `top_score
  * gap * 4 → MIN_CONFIDENCE 0.7`. That over-defaulted clean cases to
  reasoning_path because per-bucket mean-cosine gaps are typically
  0.05–0.20. Switched to `confidence = top_score * 2 + gap * 2` for
  reporting, with routing gated only when `top_score < 0.08` ("no
  bucket matched well"). This matches the TS classifier's spirit (low
  confidence → reasoning_path) without losing 70 % of correct picks
  to the threshold. Calibration target met cleanly.
- **`history` parameter ignored.** The TS reference's
  `buildClassifierFeatures()` uses last user message only —
  history beyond that doesn't change the LLM prompt. Python signature
  accepts `history=None` for forward compat but doesn't currently
  consume it.

## Follow-ups identified

* **CLASSIFIER-FAST-PATH-SHORT-MESSAGE-1** — close the 2 remaining
  eval disagreements by tightening fast-path anchors with more
  short-form factual questions ("what does X stand for", "what is N
  plus M"). Wait until codex's parallel-write surfaces real-world
  agreement-rate data — small synthetic gains may not generalize.
* **CLASSIFIER-HISTORY-AWARE-1** — bring `history` into the
  classification when codex's parallel-write shows it improves
  agreement (e.g., follow-up turns where the bucket should match the
  preceding turn's bucket).
* **MODAL-LATENCY-OPTIMIZE-1** (already filed) — the 832 ms p50 is the
  same TLS+edge baseline; not specific to this lane.
