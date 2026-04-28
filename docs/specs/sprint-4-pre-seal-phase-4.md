# Sprint 4 PRE — Seal Phase 4 design pass

**Status:** Design draft, written during Kalas-Cowork session 2026-04-28, pending Kalas seal.
**Author:** Claude coworker (Cowork session), reviewed by Kalas.
**Implements:** the git-hygiene precondition for every Phase 4 sprint that follows.

---

## Goal

Commit the four Phase 4 ADRs and the Phase 4 master spec from untracked
to sealed on `main` and push to `origin`. After this lands, every
downstream Phase 4 sprint cites a file that exists in `git log`, not a
file that exists only on the operator's laptop.

Per repo policy, all work commits directly to `main`. No feature
branches.

This is the smallest possible Codex task. It is a precondition, not a
feature. SDK-1 (Phase 4 W1) cannot be reviewed against unsealed ADRs —
the seal is what turns "Coworker M's architecture pass" into a binding
contract Codex implements against.

---

## What's untracked today

`git status --short` on `main` shows the following Phase 4 design files
as `??` (untracked):

- `docs/specs/adr-013-agent-runtime-contract.md`
- `docs/specs/adr-014-agent-permissions-capabilities.md`
- `docs/specs/adr-015-marketplace-distribution-trust-tiers.md`
- `docs/specs/adr-016-agent-cost-metering-budgets.md`
- `docs/specs/phase-4-master.md`

Plus three adjacent untracked surfaces that the Phase 4 work references:

- `docs/eval/` — held-out classifier eval artefacts (`f1-sunset-audit.md`,
  `lead-classifier-correction-memo.md`)
- `docs/ops/` — operator note `lead-classifier-claim-sunset.md`
- `scripts/synthetic-vegas-data/` — synthetic seed used by the Phase 4
  ship-gate run

`docs/specs/lumo-intelligence-layer.md` is also marked `M` (modified,
unstaged) — its tracked version was extended during the Phase 4
architecture pass to reference the new ADRs.

---

## What this sprint does

Two commits, one push, on `main`. No code changes.

### Commit 1 — `docs: seal phase 4 architecture decisions`

Adds the five sealed Phase 4 design files plus the modified intelligence
layer ADR. Mirrors the message style of `b780776 docs: seal phase 3
architecture decisions`.

```
git add docs/specs/adr-013-agent-runtime-contract.md \
        docs/specs/adr-014-agent-permissions-capabilities.md \
        docs/specs/adr-015-marketplace-distribution-trust-tiers.md \
        docs/specs/adr-016-agent-cost-metering-budgets.md \
        docs/specs/phase-4-master.md \
        docs/specs/lumo-intelligence-layer.md
git commit -m "docs: seal phase 4 architecture decisions"
```

### Commit 2 — `docs: capture phase 4 ship-gate scaffolding`

Adds the eval, ops, and synthetic-data artefacts that the master spec
cites but which currently live untracked.

```
git add docs/eval/ docs/ops/ scripts/synthetic-vegas-data/
git commit -m "docs: capture phase 4 ship-gate scaffolding"
```

### Push

```
git push origin main
```

Direct commit to `main` per repo policy. Subsequent sprints reference
the ADR commit hashes in their own commit messages.

---

## What this sprint does NOT do

- **No edits to the ADRs.** The files land exactly as drafted in the
  architecture pass. If a reviewer flags a change, that's a separate
  commit on top of the seal.
- **No new ADRs.** ADR-017+ are out of scope. Phase 4 is bounded to
  013-016 by master spec §"Phase 4 deliverable index".
- **No `Lumo_Agent_SDK` changes.** That repo's `@lumo/agent-sdk@0.4.0`
  stays in place until SDK-1 (the next sprint) replaces it with
  `packages/lumo-agent-sdk@1.0.0` inside this monorepo.
- **No feature branch.** Per repo policy, the seal lands on `main`
  directly. No `codex/*` branch is created or pushed for this work.

---

## Acceptance

This sprint is shippable when:

1. `git log --oneline -3 main` shows two new commits at the head:
   `docs: capture phase 4 ship-gate scaffolding` and `docs: seal phase
   4 architecture decisions`.
2. `git status --short` shows zero untracked files under `docs/specs/`,
   `docs/eval/`, `docs/ops/`, and `scripts/synthetic-vegas-data/`.
3. `git diff --stat HEAD~2 HEAD -- docs/specs/` reports exactly six
   files touched: the four ADRs (added), `phase-4-master.md` (added),
   and `lumo-intelligence-layer.md` (modified).
4. `git ls-tree origin/main docs/specs/` (after push) lists every
   Phase 4 ADR and the master spec.

---

## Out of scope

- Merge to `main`.
- ADR review feedback.
- Any code change.
- Any migration.
- Any deletion of pre-existing tracked files.

---

## File map

Six tracked files at sprint end (additions and one modification),
plus whatever lives under `docs/eval/`, `docs/ops/`, and
`scripts/synthetic-vegas-data/`. No source code is touched.

---

## Notes for the operator (Kalas)

After Codex pushes, two things to verify on the GitHub UI before
SDK-1 starts:

1. Open the diff for commit 1 and confirm the ADRs are the same
   versions you reviewed in this Cowork session.
2. Confirm the `lumo-intelligence-layer.md` modification is the
   small Phase-4-cross-reference addition, not an unrelated edit
   that drifted in from another working tree.

Once both checks pass, `sprint-4-sdk-1-agent-sdk-v1.md` is unblocked.
