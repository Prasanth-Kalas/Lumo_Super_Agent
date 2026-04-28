# Lead Classifier "F1 = 1.00" Claim — Sunset Memo

**Owner:** Kalas (CEO/CTO/CFO)
**Author:** Coworker G (audit + remediation pass)
**Decision date:** 2026-04-27
**Status:** Active — internal-only until investor / customer comms refresh
**Related:** `Lumo_ML_Service/docs/eval/lead-classifier-v1.md`,
`Lumo_ML_Service/lumo_ml/eval/lead_classifier_eval.py`,
`docs/specs/lumo-intelligence-layer.md` (§7 inbox, §10 acceptance, §11 prove-it
cut), `eval/held-out-classifier/`.

---

## 1. What was claimed vs. what was true

**Claimed (internal docs, draft pitch language, ADR §10 deterministic eval
snapshot):** The Lumo lead classifier achieves **F1 = 1.00** on a 100-example
seed dataset.

**True:** The number is real but it is not what a buyer, investor, or
journalist would assume. Three compounding issues:

1. **The classifier is rules-based, not ML.** `app/tools.py` in
   `Lumo_ML_Service` is a hand-written regex matcher with hand-tuned weights
   and a 0.7 threshold. There is no learned model, no training run, no
   parameters fit from data. We have been describing it in some places as if
   it were a trained model.
2. **The 100-example seed dataset is trivially separable by length.** Pearson
   correlation between the binary label and raw character length is **r =
   0.92**; mean lead length is 78.7 chars, mean not-lead length is 37.6 chars.
   A trivial baseline of "predict lead if `len(text) > 50`" scores near
   perfect. Hand-written positive examples are full B2B paragraphs; hand-written
   negative examples are short YouTube comments ("First!", "Sub4sub").
3. **The 1.00 was measured on the same 100 examples the rules were tuned
   against.** The rules and the seed were authored side by side. F1 = 1.00 is
   training-set performance, not a generalisation estimate.

The 1.00 is therefore a **dataset artefact**, not a model-quality signal.
Real production traffic (short business DMs, long fan rambles, multilingual,
spam-shaped) will not have the length/register correlation the seed has.

## 2. Root cause

- **Process:** rule weights and the seed set were authored in the same PR by
  the same engineer. No separation between training data and evaluation data.
- **Dataset:** synthetic, single-author, stratified by class but stylistically
  separated such that trivial features dominate.
- **Eval:** no held-out split; on-seed metrics were treated as headline numbers.
- **Communication:** the headline number propagated into ADR copy, the Phase 1
  prove-it cut, and draft external phrasing without a "this is on-seed only"
  caveat strong enough to survive copy-paste.

## 3. The honest current number

Lead classifier (rules-based heuristic, v1):

- **F1 = 0.86 (lead class)** on a stratified 80/20 holdout of the 100-example
  seed-style set.
- ROC-AUC = 0.98 with a **±0.10 95% CI on 20 test rows** (the test set is
  small; a single example flipping moves F1 by ~5 points).
- TF-IDF + LogisticRegression baseline (fixed seed = 42) measured against the
  same held-out split. Apples-to-apples ML reference.
- Cross-validated on the train split: F1 = 0.946 ± 0.034 (5-fold stratified).
- **Production validation pending.** A credible production-grade metric
  requires ≥1,000 real-traffic labels with inter-annotator Cohen's
  κ ≥ 0.7 across at least two labellers and explicit slicing by vertical
  (travel, food, flights, EV charging) and by language (EN, ES, PT).

Source of truth: `Lumo_ML_Service/docs/eval/lead-classifier-v1.md`.

## 4. Remediation path

| Step | Owner | Status | Target |
|---|---|---|---|
| Stop quoting F1 = 1.00 anywhere external | All | **Done** (this memo + audited docs) | now |
| Add held-out eval script (`lead_classifier_eval.py`) and JSON artefact | Brain | Done | now |
| Sunset memo (this file) and approved external phrasing | Ops | Done | now |
| Collect ≥1,000 real-traffic inbox labels (mixed verticals, mixed languages) | Workspace + Eval | **Open** | next 6 weeks |
| Two labellers per row; compute Cohen's κ; require κ ≥ 0.7 before publishing | Eval | Open | with the above |
| Frozen-quarterly held-out file with hash check in CI; any PR touching `app/tools.py` must run against it | Brain + DevEx | Open | within 2 sprints |
| Move from regex to a learned model (TF-IDF + LR head, then a distilled sentence-transformer) | Brain | Phase 4 backlog | after κ≥0.7 dataset is in hand |
| Publish slice metrics (per-vertical, per-language) — never quote a single global number | Eval + Ops | Open | with the production metric |

Until the held-out production metric is in hand, **F1 = 0.86 is the highest
number we are allowed to quote**, and only with the "n=100 seed-style holdout,
production validation pending" caveat attached.

## 5. Grep checklist (for future audits — re-run before any board / pitch / customer comms)

Run from each repo root:

```bash
# 1. Direct F1=1 claims (any flavour)
rg -i 'F1\s*[=:]?\s*1(\.0+)?\b|perfect F1|100% F1|F1 score of 1'

# 2. Adjacent perfection claims
rg -i 'accuracy\s*[=:]?\s*1(\.0+)?|100%\s*accuracy|accuracy\s*[=:]?\s*100%|precision\s*[=:]?\s*1(\.0+)?|recall\s*[=:]?\s*1(\.0+)?|zero false positives|no false positives|perfect (accuracy|precision|recall)'

# 3. Lead classifier mentions (verify every one says rules-based, not ML/trained)
rg -i 'lead[ -]classifier|inbox[ -]classifier'

# 4. Implicit "ML / trained / machine learning" near "lead"
rg -i 'machine learning|trained (model|classifier)|ML (model|classifier)' | rg -i 'lead|inbox'

# 5. Binary artefacts (must be checked manually — Keynote, PowerPoint, PDF, Word)
fd -e pptx -e key -e pdf -e docx
```

Any hit must be classified as **safe-rewrite**, **needs-review**, or
**out-of-scope** (e.g. unit-test fixtures asserting deterministic 1.00, or
docs that quote 1.00 only to refute it).

## 6. Files corrected in this pass (SAFE-TO-REWRITE)

| File | Change |
|---|---|
| `Lumo_Super_Agent/docs/specs/lumo-intelligence-layer.md` §7 (inbox) | Already corrected by Codex — reaffirmed: classifier is rules-based; F1 = 0.86 on holdout; production validation pending; no F1 = 1.00 in external comms. |
| `Lumo_Super_Agent/docs/specs/lumo-intelligence-layer.md` §10 acceptance #4 (Lead classifier) | Rewrote bullet to label classifier as "rules-based heuristic baseline; ML model planned in Phase 4," disclose the length-correlation artefact, quote F1 = 0.86 with the ±0.10 CI and production-validation-pending caveat, and explicitly forbid quoting F1 = 1.00 externally. |
| `Lumo_Super_Agent/docs/specs/lumo-intelligence-layer.md` §11 Day 4 row | Replaced "Train first lead classifier on 100 hand-labelled examples…" (misleading — implies ML training) with "Ship first lead classifier (rules-based heuristic baseline; ML model planned in Phase 4)…" and inlined the honest held-out number plus the production-validation gate. |
| `Lumo_Super_Agent/docs/ops/lead-classifier-claim-sunset.md` (this file) | Created. Permanent record of the claim, the truth, and the path forward. |

## 7. Files NOT edited — flagged for human review

These are either legitimate refutations of the false claim, code that needs an
engineer rather than docs work, or context where the wording is borderline.

| File | Reason | Suggested action |
|---|---|---|
| `Lumo_ML_Service/docs/eval/lead-classifier-v1.md` | Quotes "F1 = 1.00" repeatedly **as the claim being refuted**. This is the eval doc. Out-of-scope for rewriting; this is the source of truth that replaces the claim. | Leave as-is. |
| `Lumo_ML_Service/lumo_ml/eval/lead_classifier_eval.py` | Module docstring and JSON artefact reference "F1=1.00 claim" only to mark the on-seed run as "for parity with the F1=1.00 claim only." Out-of-scope. | Leave as-is. |
| `Lumo_ML_Service/lumo_ml/eval/results/lead_classifier_v1.json` | Same as above — `evaluated_on` field annotates the on-seed run for parity. Out-of-scope. | Leave as-is. |
| `Lumo_ML_Service/README.md` | Already corrected to "internal seed/regression eval only, not a held-out generalisation metric." Acceptable. | Leave as-is. |
| `Lumo_Super_Agent/eval/held-out-classifier/README.md` | Internal-engineering doc. Calls the brain-side endpoint "the ML classifier" — the bridge is wired for ML, but the brain's `/classify` is currently rules-based. Slightly imprecise but not a customer-facing F1 claim. | **Engineer to confirm wording**: should we rename "ML classifier" to "brain `/classify` endpoint (rules-based today; ML in Phase 4)"? Codex/Coworker B can take this on a code-level pass. |
| `Lumo_Super_Agent/lib/workspace-lead-classifier-core.ts` | Variable/log message reads "lead classifier capped at … items." Accurate. No claim. | Leave as-is. |
| `Lumo_Super_Agent/tests/workspace-lead-classifier.test.mjs` | Unit-test labels and fixtures. The label `business_lead` and `score: 0.88` are deterministic test inputs, not metric claims. Out-of-scope. | Leave as-is. |
| `Lumo_Super_Agent/scripts/eval-phase1.mjs` | Computes `classifier_fallback_f1` on the heuristic — this IS the F1 = 0.889 number that ships in §10 of the spec. Not a 1.00 claim. | Leave as-is. |
| `Lumo_Super_Agent/docs/specs/phase-4-outlook.md` (lines 456–460, 584) | Calls the inbox classifier a "classifier" without specifying rules vs. ML. Phase 4 doc explicitly anticipates the ML feedback loop, so the wording is forward-looking and accurate in context. | **Reviewer**: skim for any sentence that retroactively implies the Phase-1 classifier is ML; nothing flagged but worth a second read. |
| Any `.pptx`, `.key`, `.pdf`, `.docx` files | None found in the three repos. | n/a |
| External investor decks, customer demo slides, sales one-pagers | **Not in any of the three audited repos.** They live wherever the most recent fundraise / sales deck is stored (Notion / Google Drive / local). | **Action required:** Kalas to grep / re-read the most recent investor deck and the live customer pitch deck for any "F1 = 1.00", "100% accuracy," "perfect classifier," or "trained ML lead classifier" language and replace with the approved phrasing in §9 below. |

## 8. Internal communication — who needs to know

| Audience | What they need to know | Channel |
|---|---|---|
| **Sales / GTM** (whoever pitches to customers) | The headline F1 = 1.00 is retired. Use the approved phrasing in §9. If a prospect already heard the 1.00 number, lead with: "We re-ran that against an honest held-out split — the apples-to-apples number is F1 = 0.86, with production validation in flight." | 1:1 + #sales channel pin |
| **Investors / board** | Same. If 1.00 appeared in any prior deck or memo, send a one-paragraph correction proactively (we'd rather be the source of the correction than a diligence finding). | Email from CEO; board update line item |
| **Engineering** | Coworker B already wrote the held-out eval. Coworker G has done the docs sunset. Action items in §4 are open. The frozen test-set + CI hash-check item is the next concrete code work. | #engineering channel + sprint planning |
| **Marketing / Comms** | Do not publish the 1.00 number in blog posts, social, case studies, or press. Use §9 phrasing if anyone asks "how good is the classifier?" | #marketing channel pin |
| **Customer Success / Support** | If a customer asks about classification accuracy, route to §9. Do not quote any number above 0.86 until the production metric ships. | Internal KB note |

**One-liner if asked off the cuff:** *"On our internal seed dataset the
rules-based heuristic scored very high, but that dataset was trivially
solvable by length alone, so it overstates real-world performance. The
honest held-out number against an ML baseline is F1 = 0.86, ROC-AUC = 0.98,
on a small 20-row test split. Production validation against ≥1,000
real-traffic labels is in flight; we'll publish a production-grade metric
once that's in hand."*

## 9. Approved external phrasing

Paste-ready for pitch decks, customer one-pagers, websites, and email replies.
Do not edit the numbers without re-running the eval and updating this memo.

> **Lead classification (Lumo Intelligence Layer, v1).** Lumo's inbox triage
> uses a rules-based heuristic (regex + tuned weights) to flag potential
> business leads. On a 100-example seed-style benchmark with a stratified
> 80/20 split (TF-IDF + Logistic Regression baseline, fixed seed), the
> heuristic achieves **F1 = 0.86** (lead class) with **ROC-AUC = 0.98**;
> the 95% confidence interval is roughly **±0.10** because the held-out test
> set is intentionally small (20 rows). A learned ML classifier is on the
> Phase 4 roadmap. We do not yet publish a production-grade metric: we are
> collecting ≥1,000 real-traffic labels with inter-annotator agreement
> (Cohen's κ ≥ 0.7) before quoting performance against live inbox data, and
> we will report the production number sliced by vertical and by language
> rather than as a single headline figure.

## 10. Adjacent overclaims spotted (broader audit)

Beyond the F1 = 1.00 claim, the following adjacent patterns surfaced during
the grep pass and deserve a once-over before the next round of external comms:

- **`docs/specs/phase-3-master.md`** — "100% of graph-cited chat responses
  carry provenance" and "Sample retention 100% within 24h bound" / "Revocation
  SLA 100% within 7 days." These are *targets*, not measured outcomes. Make
  sure any external use frames them as commitments / SLAs, not achieved
  metrics.
- **`docs/specs/lumo-intelligence-layer.md` §10 deterministic eval snapshot** —
  several rows show 1.000 (Risk badge coverage, Recall MRR@5, Malformed brain
  recall fallback). These are deterministic-fixture pass rates, not
  generalisation estimates. They are correctly described as "deterministic
  eval snapshot," but if any of them migrates into a pitch deck the same
  "this is on a fixture, not real traffic" caveat the lead classifier needs
  applies here too.
- **Marketing site (`Lumo-Rentals/Lumo-Technologies`)** — clean. The "100%"
  hits are commercial commitments ("you keep 100% of revenue"), not model
  claims. No F1, no classifier, no perfect-accuracy language. Safe.
- **`docs/specs/workspace-and-creator-connectors.md`** line 50 — *"Zero
  unauthorized posts shipped to user accounts. 100% of publish actions go
  through the confirmation card."* This is a guardrail commitment (good), not
  a measured outcome — fine as long as the wording stays "our policy is" and
  not "we have measured zero."
- **`docs/specs/phase-4-outlook.md`** references the inbox classifier as if
  it has a real feedback loop in v1 — it does not yet. Phase 4 is
  forward-looking so this is technically fine, but tighten before any
  external comms.

None of these is the same severity as the F1 = 1.00 issue, but they are the
same *class* of claim — measured-on-fixtures presented as production-grade.
Worth sweeping the same way before the next investor deck.

---

*This memo is the canonical record of the sunset. Update it (do not delete
it) when the production metric lands, when the κ ≥ 0.7 dataset is in hand,
and when the learned model replaces the regex baseline.*
