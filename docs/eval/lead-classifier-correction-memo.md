# Internal Memo: Lead Classifier Metric Correction

**To:** Lumo leadership, board, and any stakeholder who has previously seen
"F1 = 1.00" attached to the Lumo lead classifier.
**From:** Kalas (CEO/CTO/CFO), prepared with Coworker G
**Date:** 2026-04-27
**Status:** Internal — forward-eligible to investors and customers on request.
Companion docs: `docs/eval/f1-sunset-audit.md` (audit trail),
`Lumo_ML_Service/docs/eval/lead-classifier-v1.md` (full methodology),
`docs/specs/lumo-intelligence-layer.md` §10 (corrected ADR).

---

## Executive summary (one paragraph, forward-eligible)

A previously-quoted internal benchmark — "F1 = 1.00" for the Lumo lead
classifier on a 100-example seed dataset — overstated real-world performance
and has been retired. The classifier in Phase 1 is a rules-based heuristic
(not a trained ML model), and the seed dataset it was measured on was
trivially separable by text length alone (Pearson r = 0.92 between the label
and the character count of the example). Re-evaluated honestly against a
held-out 80/20 split with an apples-to-apples ML baseline (TF-IDF +
LogisticRegression), the classifier scores **F1 = 0.86 (lead class) with
ROC-AUC = 0.98 and a ±0.10 95% confidence interval on 20 test rows.** A
production-grade metric — sliced by vertical and language, on ≥1,000
real-traffic labels with inter-annotator agreement κ ≥ 0.7 — is in flight and
will be the only number we publish externally going forward. We are
correcting this proactively because we would rather be the source of the
correction than have it surface as a diligence finding.

## What was actually wrong

Three compounding issues turned a defensible internal sanity-check into an
indefensible external claim:

1. **The classifier is rules-based, not ML.** The Phase 1 implementation
   (`Lumo_ML_Service/app/tools.py`) is a hand-written regex matcher with
   tuned weights and a 0.7 decision threshold. There is no learned model, no
   training run, no parameters fit from data. We had been describing it as
   "the lead classifier" without consistently flagging that it is a
   heuristic baseline.
2. **The seed dataset was trivially separable by length.** Pearson
   correlation between the binary label and raw character length is 0.92.
   Mean length: 78.7 characters for `lead`, 37.6 for `not_lead` — a 2x gap.
   A throwaway baseline of `predict lead if len(text) > 50` scores near
   perfect on this set. The hand-written positives are full B2B paragraphs;
   the hand-written negatives are short YouTube comments ("First!",
   "Sub4sub"). The dataset doesn't measure classification skill so much as
   it measures the ability to count characters.
3. **The 1.00 was tuned-on-test-set.** The rule weights and the seed set
   were authored in the same pull request by the same engineer. There was
   no separation between the data the rules were fit on and the data they
   were measured on. A 1.00 in that setup is training-set performance, not
   a generalisation estimate.

The headline number, in other words, was a *dataset artefact*, not a
*model-quality signal*.

## The new methodology

We rebuilt the evaluation pipeline (`lumo_ml/eval/lead_classifier_eval.py`,
fixed seed = 42, deterministic) on three principles:

- **Held-out 80/20 stratified split.** 80 train, 20 test, class-balanced.
  The test set is never touched during rule tuning.
- **TF-IDF + LogisticRegression baseline as the apples-to-apples reference.**
  Trained on the 80%, evaluated on the same 20-row held-out test set the
  rules see. This gives us a directly comparable ML baseline for any future
  rule-vs-model debate.
- **Full confusion matrix, ROC-AUC, and 5-fold cross-validation on the
  train split** — not just a single F1 number. The CV gives us a stability
  signal; the held-out gives us the published number; the confusion matrix
  exposes the failure mode (a single mis-labelled `not_lead` is the only
  error on the held-out split).
- **A frozen-quarterly held-out file** with a CI hash check is on the
  backlog (`Phase 3 RUNTIME-1`). Any PR that touches `app/tools.py` or any
  future trainer must run against the frozen test set without modifying it.

## The new number

| Model | Eval set | F1 (lead) | ROC-AUC | Notes |
|---|---|---:|---:|---|
| Rule classifier | 100 seed (NOT held-out) | 1.000 | 1.000 | Tuned-on-test. Upper bound only. |
| Rule classifier | 20 held-out | 1.000 | 1.000 | Still 1.00 — but this is the dataset artefact, not generalisation. The seed is structurally too easy. |
| **TF-IDF + LogReg** | **20 held-out** | **0.857** | **0.980** | **The honest, externally-quotable number.** 5-fold CV on train: F1 = 0.946 ± 0.034. |

**Caveats stapled to every external use of the number:**

- The 95% CI is roughly ±0.10 because the held-out test set has 20 rows. A
  single example flipping moves F1 by ~5 points.
- The seed dataset is single-author and synthetic. It does not reflect the
  distribution of real Instagram / YouTube / TikTok inbox traffic.
- Production traffic will contain short business DMs ("hi, sponsor?") and
  long fan rambles — both of which break the length signal that dominates
  the seed.

## Path to a production-credible number

We will not publish a production-grade metric until all four are true:

1. **≥1,000 real-traffic labels** drawn from live inbox messages across at
   least three verticals (travel, food, EV/charging) and three languages
   (EN, ES, PT) at minimum.
2. **Two independent labellers per row** with **Cohen's κ ≥ 0.7**. Anything
   below that and the labels are not reliable enough to publish a metric
   against.
3. **Sliced reporting** — per-vertical, per-language F1 — never a single
   global headline number, because a global number hides where the model
   fails.
4. **A frozen test set with CI hash check** so the next "measured on the
   training data" cycle cannot recur silently.

Estimated lead time: 6 weeks for the labelled corpus, 2 sprints for the CI
guard, both running in parallel.

## What we are doing about it

- **This memo + the audit at `docs/eval/f1-sunset-audit.md`** are the
  permanent internal record. The sweep is complete: no live, customer-
  or investor-facing F1 = 1.00 claim remains in any first-party Lumo
  codebase or on the marketing site.
- **The Codex correction in `docs/specs/lumo-intelligence-layer.md`** is
  the canonical wording the rest of the org should mirror.
- **Phase 3 RUNTIME-1** (drift detection, frozen test sets, CI hash checks)
  hardens the process so this class of error is caught automatically going
  forward, not by manual audit.
- **Outside-repo artefacts** (investor decks, customer pitch one-pagers,
  recorded demos, sales call transcripts) are flagged in §5 of the audit
  for manual cleanup. Where the 1.00 number reached an external audience,
  a one-paragraph proactive correction will go out from the CEO.
- **No headline metric will be quoted externally** for the lead classifier
  until the production-grade number lands. Until then, the answer to "how
  good is your classifier?" is the wording in `docs/ops/lead-classifier-
  claim-sunset.md` §9.

The lesson is structural, not personal. We had a process gap — rule weights
and eval data authored in the same change, no held-out split, no CI guard
against tuned-on-test-set numbers. The fix is process, not blame:
held-out-by-default, frozen test sets in CI, sliced reporting, and explicit
"production validation pending" caveats on any pre-production metric.

— *Kalas*
