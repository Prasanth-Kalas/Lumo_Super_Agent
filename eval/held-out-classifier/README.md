# Held-out classifier eval (Phase 1.5)

Frozen, labelled dataset + harness for measuring the inbox lead classifier
without touching production traffic. Lives under `eval/` (not `tests/`)
because it is **not** a unit test — it is a regression signal we sample on
every PR and review on a cadence.

## What this evaluates

Today: the pure heuristic in `lib/lead-scoring.ts` (`scoreLeadHeuristic`)
applied at the production threshold (`LEAD_SCORE_THRESHOLD = 0.7`).

Soon: the same dataset will be re-scored against the ML classifier exposed
by `lib/workspace-lead-classifier-core.ts` once the ML path lands behind a
feature flag. The harness is structured so that swap is additive (a `--source`
flag), not a rewrite.

We hold the dataset and the harness in lock-step:

- The dataset never changes silently. Any edit to `dataset/synthetic.jsonl`
  is a deliberate change reviewed in the same PR that explains why the
  ground truth moved.
- The harness is deterministic. No network, no clocks, no randomness — the
  same dataset must produce the same metrics on every machine.

## Files

- `run.mjs` — harness. Imports the pure-core heuristic via
  `--experimental-strip-types` (same trick `npm run eval:phase1` uses) and
  prints a confusion matrix + precision / recall / F1 / accuracy + a
  per-category breakdown.
- `dataset/synthetic.jsonl` — 40-row JSONL fixture. 20 positives (partnership,
  sponsorship, hire) and 20 negatives (spam, noise, generic). Synthetic and
  written by hand; no real user content. Schema:
  ```json
  { "id": "syn_001", "text": "...", "label": true, "category": "partnership", "source": "synthetic" }
  ```

## Running locally

```bash
node --experimental-strip-types eval/held-out-classifier/run.mjs
```

Useful flags:

```bash
# tighten the gate in CI
node --experimental-strip-types eval/held-out-classifier/run.mjs --min-f1 0.75

# JSON-only output, for downstream tooling
node --experimental-strip-types eval/held-out-classifier/run.mjs --json

# point at a different dataset (e.g. a real held-out export)
node --experimental-strip-types eval/held-out-classifier/run.mjs \
  --dataset path/to/holdout.jsonl
```

The harness exits 0 on any successful run unless `--min-f1` is provided.
That keeps the scaffold from being a noisy gate before we have agreement on
the target F1.

## CI

`.github/workflows/held-out-eval.yml` runs the harness on every PR and on
pushes to `main`. It is intentionally separate from `phase1-evals.yml` so
metrics regressions surface as their own check name in GitHub.

The CI job uses Node 22 (same as `phase1-evals.yml`) because
`--experimental-strip-types` is not stable on Node 20.

## Adding rows

1. Append the new row to `dataset/synthetic.jsonl`. Keep `id` monotonically
   increasing (`syn_041`, `syn_042`, ...).
2. Re-run the harness locally and confirm the confusion matrix still adds
   up to the new row count.
3. Mention in the PR description what category you added and why.

## Adding rows from real inbox traffic

Real inbox rows must be redacted before they enter this dataset:

- Replace handles, names, and email addresses with realistic placeholders.
- Strip URLs that aren't part of the classification signal.
- Mark `"source": "redacted-inbox"` instead of `"synthetic"`.

If you find yourself wanting to copy-paste raw user content, stop and bring
the question back to the PR review — synthetic stand-ins are almost always
sufficient.

## Design notes

- The harness imports `lib/lead-scoring.ts` directly. It does **not** import
  `lib/workspace-lead-classifier-core.ts` because that module is async and
  expects a fetch-shaped ML endpoint; the heuristic is the appropriate
  baseline for a frozen, offline eval.
- `scoreLeadHeuristic` is pure, dependency-free, and matches what the
  production fallback path runs when the ML classifier is unreachable. So
  this scaffold doubles as a guardrail for the fallback path.
- We do not gate on F1 by default. Once we have two clean weeks of data, we
  set `--min-f1` in CI and treat it as a contract.
