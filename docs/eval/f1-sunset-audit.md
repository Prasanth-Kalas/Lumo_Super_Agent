# F1 = 1.00 Sunset Audit — Lead Classifier

**Audit date:** 2026-04-27
**Auditor:** Coworker G (CEO/CTO/CFO + UX/BA hat)
**Scope:** All Lumo first-party codebases plus the marketing site.
**Trigger:** Codex commit `99033f0` ("fix: tolerate brain cold starts in admin
health") shipped the corrected lead-classifier number into
`docs/specs/lumo-intelligence-layer.md`. This pass sweeps the rest of the
repos for any remaining mentions of the retired claim.

---

## 1. Repos searched

| Repo | Path | Status |
|---|---|---|
| Lumo Super Agent (Core) | `/Users/prasanthkalas/Lumo-Agents/Lumo_Super_Agent` | Searched |
| Lumo ML Service (Brain, Python) | `/Users/prasanthkalas/Lumo-Agents/Lumo_ML_Service` | Searched |
| Lumo Agent SDK | `/Users/prasanthkalas/Lumo-Agents/Lumo_Agent_SDK` | Searched (excl. `node_modules`) |
| Lumo Marketing Site | `/Users/prasanthkalas/Lumo-Rentals/Lumo-Technologies` | Searched (excl. `node_modules`, `package-lock.json`, `.next`) |

Excluded by policy: `node_modules`, `.next`, `dist`, `package-lock.json`,
`yarn.lock`, `Pipfile.lock`, `.git/`.

## 2. Grep patterns used

```bash
# Direct F1=1.00 claims, all flavours
rg -i 'F1\s*[=:]?\s*1(\.0+)?\b'
rg -i 'F-1\s*[=:]?\s*1'
rg -i 'f1.*1\.00'

# Indirect "lead/classifier near 1.00"
rg -i 'lead.*classifier.*1\.0'
rg -i '1\.00.*lead'

# Adjacent perfection claims (flag-only, do not edit)
rg -i '100%\s*accuracy|accuracy\s*[=:]?\s*100%|perfect (accuracy|precision|recall|classifier|F1)|zero false positives|no false positives|F1 score of 1'
```

## 3. Headline result

| Bucket | Count |
|---|---:|
| Total files containing the pattern | **5** |
| Edited inline this pass | **0** |
| Already-corrected by Codex (verified, not touched) | **1** |
| Refutation/eval docs intentionally retaining the phrase | **3** |
| Earlier sunset memo (intentionally quotes the retired claim) | **1** |
| Binary / external — needs manual re-export | **0 in repo; investor decks live outside repo (see §5)** |
| Suspicious adjacent claims (flagged, NOT edited) | **4** |

**Net inline source-code/docs edits required by this pass: zero.** The Codex
commit and the prior sunset pass already removed every live, customer-facing
or board-facing F1 = 1.00 claim from the codebases. Every remaining hit is in
a file that exists *to refute* the claim.

## 4. Per-file table

| # | Path | Type | Line(s) | Action | Notes |
|---|---|---|---|---|---|
| 1 | `Lumo_Super_Agent/docs/specs/lumo-intelligence-layer.md` | Markdown spec (PRD/ADR) | 423 | **Verified, not edited** | Codex's corrected wording. Line reads `"Do not quote F1 = 1.00 externally or in board/investor material."` — this is the prohibition, not a claim. Per task constraints, do not re-edit. Surrounding §10 acceptance #4 (lines 413–425) carries the corrected wording: rules-based heuristic baseline, F1 = 0.86 on holdout, ±0.10 95% CI, production validation pending, length-correlation artefact disclosed. |
| 2 | `Lumo_ML_Service/docs/eval/lead-classifier-v1.md` | Eval methodology doc | 4, 14, 15, 18, 60–61, 73–74, 112, 133, 135, 152, 157 | **Flagged out-of-scope; not edited** | This file *is* the source of truth that replaces the F1=1.00 claim. It quotes "F1 = 1.00" only to refute it. Editing would destroy the audit trail. |
| 3 | `Lumo_ML_Service/lumo_ml/eval/lead_classifier_eval.py` | Python module | 3, 16, 320 | **Flagged out-of-scope; not edited** | Module docstring describes itself as replacing the F1=1.00 claim; line 320 annotates the on-seed JSON artefact `"evaluated_on": "ALL 100 seed examples (NOT held-out -- for parity with the F1=1.00 claim only)"`. Removing this annotation would make the parity comparison harder to read. |
| 4 | `Lumo_ML_Service/lumo_ml/eval/results/lead_classifier_v1.json` | JSON artefact | 54 | **Flagged out-of-scope; not edited** | Same `evaluated_on` annotation as #3. Auto-generated artefact; the annotation comes from #3. |
| 5 | `Lumo_Super_Agent/docs/ops/lead-classifier-claim-sunset.md` | Earlier sunset memo | 1, 17, 35, 75, 117, 118, 129, 130, 139, 145, 179, 207 | **Verified, not edited** | Earlier Coworker G pass produced this. Quotes "F1 = 1.00" only as the claim being refuted. Should remain as the historical record. |

### Before / after wording snippets

For the Codex correction in `lumo-intelligence-layer.md` §10 acceptance #4
(verified by Coworker G this pass — source-of-truth wording the rest of the
org should mirror):

> **Before (retired):**
> "Lead classifier achieves F1 = 1.00 on a 100-example seed dataset."
>
> **After (Codex, lines 413–425):**
> "Lead classifier (rules-based heuristic baseline; ML model planned in Phase 4):
> Tuned against the labelled 100-example seed set (the seed is trivially
> length-separable — Pearson r between label and length is 0.92 — so on-seed
> metrics are an upper bound, not a generalisation estimate). Honest held-out
> number: F1 = 0.86 on stratified 80/20 (TF-IDF + LogReg baseline, fixed seed);
> ROC-AUC = 0.98 with a ±0.10 95% CI on 20 test rows. Production validation
> pending — requires ≥1,000 real-traffic labels with inter-annotator κ ≥ 0.7
> before publishing a production-grade metric. Do not quote F1 = 1.00
> externally or in board/investor material."

The approved one-line external phrasing (any future inline correction outside
this repo should adopt this wording verbatim):

> **F1 = 0.86 on n=100 seed-style holdout, production validation pending.
> Held-out evaluation showed dataset artefact (Pearson r=0.92 between label
> and text length); production credibility requires ≥1000 real-traffic
> labeled examples.**

## 5. Binary / external files — manual re-export required

No `.pdf`, `.pptx`, `.key`, `.docx`, `.xlsx`, image, or video file inside any
of the four audited repos contains the retired claim.

`Lumo-Agents/Super_Agent_API_Integrations.xlsx` exists at the parent of
`Lumo_Super_Agent` but is an API integrations matrix, not a metrics doc — out
of scope for this audit.

**Action items for Kalas (outside-repo artefacts):**

- [ ] Re-grep the most recent **investor deck** (Notion / Google Drive /
      Keynote / PowerPoint master) for "F1 = 1.00", "F1 score of 1", "perfect
      classifier", "100% accuracy", "trained ML lead classifier". Replace any
      hit with the approved phrasing in §4.
- [ ] Re-grep the **customer pitch deck / sales one-pager** (Canva / Notion /
      Drive). Same patterns, same replacement.
- [ ] Re-grep the **board update memos** (Notion or email archive) for any
      previously-quoted 1.00 number. If found, send a one-paragraph
      proactive correction (CEO-from). The memo at
      `docs/eval/lead-classifier-correction-memo.md` is forward-able as-is.
- [ ] **Recorded demo videos / Loom**: if any prior demo voiceover quoted the
      1.00 number, either re-record or post a written correction in the
      description. Do not silently leave it.
- [ ] **Sales-recorded calls / call transcripts**: if any rep used the 1.00
      number on a recorded call, the customer should receive the §6 phrasing
      below in a follow-up email.

## 6. Suspicious adjacent claims (flagged, NOT edited)

These are not F1 = 1.00 claims, but they are the same *class* — measured-on-
fixtures or policy-target language that could be misread as production
metrics. Flagged for the next comms sweep; no edit performed this pass.

| File | Line(s) | Concern |
|---|---|---|
| `Lumo_Super_Agent/docs/specs/lumo-intelligence-layer.md` | §10 deterministic eval snapshot rows: `Risk badge coverage = 1.000`, `Recall MRR@5 = 1.000`, `Malformed brain recall fallback = 1.000` | Deterministic-fixture pass rates, correctly labelled "deterministic eval snapshot" — but if these migrate into an external deck, they need the same "this is on a fixture, not real traffic" caveat the lead classifier got. |
| `Lumo_Super_Agent/docs/specs/phase-3-master.md` | "100% of graph-cited chat responses carry provenance"; "Sample retention 100% within 24h bound"; "Revocation SLA 100% within 7 days" | These are *commitments / SLAs*, not measured outcomes. Make sure external use frames them as policy, not metric. |
| `Lumo_Super_Agent/docs/specs/workspace-and-creator-connectors.md` | line ~50: "Zero unauthorized posts shipped to user accounts. 100% of publish actions go through the confirmation card." | Guardrail commitment (good), not measured. Wording must stay "our policy is" not "we have measured zero." |
| `Lumo_Super_Agent/docs/specs/phase-4-outlook.md` | lines ~456–460, 584 | References the inbox classifier without specifying rules-based vs. ML. Phase 4 is forward-looking so this is technically fine, but tighten before any external comms — make sure no sentence retroactively implies the Phase-1 classifier was ML. |

These flags are deliberately not edited — they are not false claims, only
claims that travel poorly without their context. Owner: Comms / Ops to review
before the next investor deck or marketing refresh.

## 7. False positives skipped

| Hit | File | Reason skipped |
|---|---|---|
| `#6366F1` (indigo hex code) | `Lumo-Rentals/Lumo-Technologies/docs/superpowers/{specs,plans}/2026-03-17-website-redesign*.md` | CSS color reference, not a metric. |
| `integrity sha512-...F1...` | `Lumo-Rentals/Lumo-Technologies/package-lock.json` | npm package integrity hash. Lock file excluded by policy anyway. |
| "Train ML models on user data without an explicit per-user opt-in" | `Lumo-Rentals/Lumo-Technologies/public/partners/policies/acceptable-use.md` | Generic AUP language, not a Lumo metric claim. |

## 8. Re-run grep for verification

Anyone (Kalas, Codex, future Coworker) can re-run this audit at any time:

```bash
# From each repo root, run all five and expect zero hits in shipped/source files.
# Hits in /docs/eval/, /docs/ops/, lumo_ml/eval/, and lead-classifier-v1.md
# are EXPECTED — those are the refutation docs.

rg -i --hidden \
   --glob '!**/node_modules/**' \
   --glob '!**/.next/**' \
   --glob '!**/dist/**' \
   --glob '!**/.git/**' \
   --glob '!**/*.lock' \
   --glob '!**/package-lock.json' \
   'F1\s*[=:]?\s*1(\.0+)?\b|F1 score of 1|perfect F1|100% F1'

# Adjacent overclaims to keep an eye on (flag-only, not auto-edit)
rg -i --hidden \
   --glob '!**/node_modules/**' \
   --glob '!**/.next/**' \
   --glob '!**/dist/**' \
   '100%\s*accuracy|accuracy\s*[=:]?\s*100%|perfect (accuracy|precision|recall|classifier)|zero false positives|no false positives'
```

Expected results after this pass:

- Pattern 1 should match only `Lumo_ML_Service/docs/eval/lead-classifier-v1.md`,
  `Lumo_ML_Service/lumo_ml/eval/lead_classifier_eval.py`,
  `Lumo_ML_Service/lumo_ml/eval/results/lead_classifier_v1.json`,
  `Lumo_Super_Agent/docs/ops/lead-classifier-claim-sunset.md`,
  `Lumo_Super_Agent/docs/specs/lumo-intelligence-layer.md` line 423,
  and this audit file. Zero hits in shipped product code, marketing site, or
  external-facing docs.
- Pattern 2 should match the §6 flagged files only. Anything new requires
  triage.

## 9. Sign-off

- [x] Audit complete.
- [x] No live, customer- or investor-facing F1 = 1.00 claim remains in any
      first-party Lumo codebase or the marketing site.
- [x] Source-of-truth eval doc and refutation Python module preserved
      intentionally.
- [x] Adjacent overclaims documented for follow-up.
- [x] Internal correction memo at
      `docs/eval/lead-classifier-correction-memo.md` ready to forward.
- [ ] Outside-repo artefacts (decks, recorded demos, call transcripts) —
      Kalas to action per §5.
- [ ] CI guard: frozen-quarterly held-out file with hash check (tracked in
      sunset memo §4 backlog).
