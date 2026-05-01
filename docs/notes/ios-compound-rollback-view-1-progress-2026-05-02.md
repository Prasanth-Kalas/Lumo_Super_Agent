# IOS-COMPOUND-ROLLBACK-VIEW-1 — progress + ready-for-review, 2026-05-02

Branch: `claude-code/ios-compound-rollback-view-1` (5 commits, branched
from `origin/main` at the IOS-COMPOUND-LEG-DETAIL-1 closeout).

When a compound leg fails, the dispatch strip surfaces the cascade
visually — the failed leg's red pill plus the dependent legs'
rollback indicator. Tapping the failed leg expands the LEG-DETAIL-1
panel and now also enumerates the saga's rollback plan ("the hotel
and the dinner reservation are being rolled back").

## Recon flag → Path A executed

The brief asserted dependency edges were "already on the wire," but
recon turned up otherwise: `apps/web/lib/saga.ts::CompoundLegSnapshot.depends_on`
exists DB-side, but `buildAssistantCompoundDispatchFrame` was
stripping it on the way out. I flagged the disconnect, proposed
three paths (extend the frame here / heuristic-only / hold for
Codex), and you greenlit Path A. The frame extension is small,
forward-compatible, and unblocks both this lane's cascade visual
and the future `WEB-COMPOUND-LEG-DETAIL-1` dep-name resolution.

## What shipped

| Δ | Surface | Outcome |
|---|---|---|
| 1 | Web frame extension | `CompoundDispatchLeg` (apps/web/lib/compound/dispatch-frame.ts) grows `depends_on: string[]`. `buildAssistantCompoundDispatchFrame` copies it through with an `Array.isArray` guard so older snapshots without the field decode as `[]`. Two new contract tests in `tests/web-compound-view.test.mjs` lock the round-trip + the empty-default. |
| 2 | iOS frame decode | `CompoundLeg` grows `depends_on: [String]` with a default-empty initializer so existing call sites compile unchanged. `ChatService.decodeCompoundDispatchPayload` reads the new field; older frames without it decode as `[]`, which the cascade compute treats as "no dependents." |
| 3 | Cascade compute helpers | Two pure helpers on `CompoundDispatchHelpers`: `cascade(failedLegID:legs:)` runs an iterative O(N + edges) BFS over the reverse-dependency adjacency (failed leg excluded from result); `rollbackCascade(legs:statuses:)` aggregates across every currently-failed leg in the override layer and unions the cascades. Both pure — no view-model state, fully testable. |
| 4 | Strip explainer line | `CompoundLegStrip` computes `cascadeSet` once per body render. Rows that fall in the cascade gain a third meta line under the agent_display_name: `"Rolled back — [failed leg description] failed"` in warning color. Mirrors the brief's "tooltip" semantics inline (iOS doesn't have hover tooltips at the row scale). |
| 5 | Strike-through on terminal cascaded legs | When a row's status reaches `rolled_back` or `rollback_failed` AND the leg is in the cascade set, the description text gets a `.strikethrough()` in tertiary tone. The pill itself already swaps to warning color via the existing rollback-pill styling, so the strike-through reinforces the "this booking was undone" framing on the description. |
| 6 | Detail-panel ROLLBACK PLAN branch | `CompoundLegDetailContent`'s failure branch (already shipped in IOS-COMPOUND-LEG-DETAIL-1) gains a new `ROLLBACK PLAN` labeledLine when the failed leg has dependents. `rollbackPlanText()` groups dependents by live status into three buckets — "rolling back" / "already rolled back" / "escalated to manual review" — and joins them with sentence-case grammar. Reads from the override layer rather than the dispatch payload's stale initial. Empty when the failed leg has no dependents (one-liner fixtures still render cleanly). |
| 7 | DEBUG fixture | `RootView.applyDebugLaunchArgs` grows `-LumoSeedCompoundRollback <state>` keyed across four saga-arc snapshots (failed_cascade / rollback_pending / rolled_back / manual_review); auto-expands the failed flight leg so the ROLLBACK PLAN copy lands in every capture. Capture-script gains `ios-compound-rollback-view-1` variant. |

## Web ↔ iOS parity

The dispatch-frame `depends_on` is now byte-identical on both surfaces (locked by web's `dispatch frame helper produces ordered, display-ready legs` test asserting `depends_on` round-trip + iOS's `test_parseFrame_compoundDispatch_capturesDependsOn`). The cascade compute itself lives only on iOS for this lane — `WEB-COMPOUND-LEG-DETAIL-1` is the natural future port.

| Behaviour | Web (pre-rollback) | Web (post-rollback) | iOS |
|---|---|---|---|
| `depends_on` on the wire | stripped | round-tripped | round-tripped |
| Cascade compute | n/a | (will use iOS as reference) | `CompoundDispatchHelpers.cascade(...)` BFS |
| Strip explainer line on cascaded legs | n/a | (future) | "Rolled back — [failed leg] failed" warning text |
| Strike-through on terminal cascaded legs | n/a | (future) | `.strikethrough()` on description in tertiary tone |
| Detail panel ROLLBACK PLAN branch | n/a | (future) | grouped sentence-case copy on the failed leg only |

## Visual

| State | iOS shot |
|---|---|
| Failed-with-cascade | `rollback-failed-cascade-light.png` — flight `failed` pill; FAILED + SAGA + ROLLBACK PLAN ("The hotel and the dinner reservation are being rolled back."); hotel + restaurant rows show `rollback pending` pills with "Rolled back — Booking flig…" explainer |
| Rollback-pending mid | `rollback-pending-mid-light.png` — same failed root; hotel `rollback pending`, dinner still `pending`; ROLLBACK PLAN reads "The dinner reservation and the hotel are being rolled back." |
| Fully rolled back | `rollback-rolled-back-light.png` — Settled badge; ROLLBACK PLAN "already rolled back"; descriptions show `.strikethrough()`; both dependents in warning-tone `rolled back` pill |
| Manual review escalation | `rollback-manual-review-light.png` — hotel `rolled back` cleanly, dinner `manual review`; ROLLBACK PLAN groups: "The hotel is already rolled back. The dinner reservation escalated to manual review." |

iPhone 17 simulator. All four under `docs/notes/ios-compound-rollback-view-1-screenshots/`.

## Tests

**11 new tests** in `apps/ios/LumoTests/CompoundRollbackViewTests.swift`, five slices:

- **Frame decode (2)** — `depends_on` flows through `ChatService.parseFrame`; older frames without the field decode as `[]`.
- **`cascade(failedLegID:legs:)` (5)** — closure correctness across the canonical graph shapes: serial chain (all downstream), exclusivity (failed leg never in its own cascade), fan-out (parallel branches both cascade), fan-in (independent root + its legs not cascaded), isolated leg (empty cascade).
- **`rollbackCascade` aggregator (3)** — unions across multiple concurrent failures; excludes failed roots themselves; reads the override layer rather than the dispatch payload's stale initial.
- **Detail panel `rollbackPlanText` copy (3)** — groups dependents into three sentences with sentence-case joining; empty when no dependents; pre-rollback (committed) dependents read as "rolling back" since that's the saga's intent.

Plus 2 new web tests in `tests/web-compound-view.test.mjs` that lock the dispatch-frame `depends_on` round-trip + the `[]` default.

xcodebuild test green; LumoTests bundle 273 → 284 (+11). web-compound-view test 7 → 9 (+2).

## Gates

- `xcodebuild test` — green (273 → 284 tests).
- iOS build — clean.
- `node tests/web-compound-view.test.mjs` — green (7 → 9 tests).
- `npx tsc --noEmit` (apps/web) — green.

## Out of scope (deferred)

- **Web port of the cascade visual.** Will land in `WEB-COMPOUND-LEG-DETAIL-1` (already filed) — the dep-edge plumbing this lane shipped on web is the prerequisite that lane was waiting on.
- **Editable / cancel-rollback actions.** Out of scope for view-only; covered by `IOS-COMPOUND-LEG-EDIT-1`.

## Notes for review

1. **Frame extension was the right call.** The heuristic alternative (Path B — "every later leg in dispatch order is a transitive dependent") would have broken silently on parallel-branch DAGs (two independent legs that both fail wouldn't cascade to each other in the real saga, but the heuristic would say they do). The frame extension is ~10 LOC of web change for the right contract, no false positives, and it unblocks the future web port too.

2. **`depends_on` is forward-compatible.** Older iOS clients that pre-date this lane's decoder change will silently ignore the new field (it just isn't read), so a Vercel deploy of the web change is safe before TestFlight pushes the iOS change. New iOS clients reading older frames default to `[]`, matching pre-extension behaviour.

3. **Cascade exclusivity matters.** The failed leg itself is never in its own cascade — a small but load-bearing detail. If it were included, the strike-through + explainer line would render on the failed leg too, double-marking it. Locked by `test_cascade_isExclusiveOfFailedLeg`.

4. **`rollbackCascade` reads the override layer.** A dispatch payload's `status` field is the *initial* state at the moment the orchestrator emitted the frame. By the time the failure surfaces, the override layer has the live status. Cascade compute uses overrides to find the currently-failed roots; the dispatch list provides the graph topology. Pinned by `test_rollbackCascade_readsOverrideLayer_notDispatchInitial`.

5. **Plan-text grammar cases.** The three-bucket grouping ("rolling back" / "already rolled back" / "escalated to manual review") covers every saga state without needing per-status copy. Pre-rollback (still `committed`) dependents are bucketed as "rolling back" since the saga's compensation will reach them shortly — better UX than "the hotel will eventually be rolled back" hedging.

6. **Strike-through is on the description, not the pill.** The pill's color already swaps to warning when `rolled_back`, so a strike-through there would over-decorate. The description strike-through reinforces the "this booking was undone" reading on the human-readable text the user sees first.

7. **Sixth DEBUG launch-arg fixture.** `-LumoSeedCompoundRollback` joins the existing six (`LumoStartTab`, `LumoNotificationsFixture`, `LumoSeedChips`, `LumoSeedFlightOffers`, `LumoSeedBookingConfirmation`, `LumoSeedCompoundDispatch`, `LumoSeedCompoundLegDetail`). Already covered by the open `DEV-FIXTURE-CONSOLIDATION-2` follow-up.

## Estimate vs actual

Brief implied a SwiftUI cascade visual + detail panel extension. Actual: ~10 LOC web frame extension + 22 LOC web tests + ~50 LOC iOS model/decoder + ~60 LOC pure cascade helpers + ~50 LOC strip wiring/explainer + ~85 LOC detail-panel rollback plan + 239 LOC iOS tests + ~95 LOC fixture seed + ~25 LOC capture-script variant + 4 PNGs across 5 commits. ~1.5 medium sessions including the recon flag round-trip.

Ready for review. Merge instructions per the standing FF-merge protocol.
