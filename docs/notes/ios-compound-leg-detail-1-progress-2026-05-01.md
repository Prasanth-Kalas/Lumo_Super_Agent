# IOS-COMPOUND-LEG-DETAIL-1 — progress + ready-for-review, 2026-05-01

Branch: `claude-code/ios-compound-leg-detail-1` (5 commits, branched
from `origin/main` at `68a4798`).

iOS gets the per-leg detail surface first; the web port follows in a
separately-filed lane once the iOS shape settles. Tap a leg row in
`CompoundLegStrip` to expand an inline panel that shows what that
specialist agent is actually doing — keyed on the leg's status with
five branches (pending / in_flight / committed / failure trio /
manual_review).

## What shipped

| Δ | Surface | Outcome |
|---|---|---|
| 1 | Leg-status SSE metadata pass-through | `CompoundLegStatusUpdate` grows three optional trailing fields — `timestamp`, `provider_reference`, `evidence` — captured from the leg-status frames the saga already emits (see `apps/web/lib/sse/leg-status.ts::serializeLegStatusSse`). iOS just wasn't reading them. Backwards-compat: older parser paths that only need leg_id+status keep working when those fields are nil. |
| 2 | Per-leg metadata model | New `CompoundLegMetadata` (`Models/CompoundDispatch.swift`): `firstSeenInFlightAt` (stamped on the in_flight transition; survives commit so the elapsed-time record stays meaningful after a leg lands), `lastUpdatedAt`, `provider_reference`, `evidence: [String: String]`. Non-string evidence values are coerced to a string form so the dict stays Equatable + the parser doesn't drop the frame. |
| 3 | View-model state | `ChatViewModel.compoundLegMetadata[String:[String:CompoundLegMetadata]]` keyed compound_id → leg_id → metadata. `applyCompoundLegStatusUpdate` stamps `firstSeenInFlightAt` on the in_flight transition, refreshes `lastUpdatedAt` on every frame, and absorbs `provider_reference` / `evidence` when present. `compoundLegDetailExpandedFor: Set<String>` holds tap-to-expand state — multiple legs may be expanded concurrently per the brief's comparison-friendly UX requirement. Public helpers: `compoundLegMeta(compoundID:legID:)` (returns `.empty` fallback so the view always reads a value), `isCompoundLegDetailExpanded(legID:)`, `toggleCompoundLegDetail(legID:)`. `reset()` clears both layers. |
| 4 | Inline-expand UX choice | The detail panel renders **inline below the row** inside the same strip cell, not as a modal sheet. A right-pointing chevron rotates 90° on expand. Reasoning: the strip lives in the chat scroll surface and a sheet would lose context for the demo flow; the inline expand also lets multiple legs stay expanded for side-by-side comparison without a stack of overlapping sheets. Tap-outside collapse is the row tap itself (toggles); tapping a different leg expands that one without collapsing the first. |
| 5 | Status branches | `CompoundLegDetailContent` pure view (`Components/CompoundLegDetailContent.swift`). All five branches: pending shows "QUEUED — Waiting for [previous-leg description]" (best-effort dep resolution from the leg list); in_flight + rollback_pending show "SEARCHING [provider] for [activity]" + a TimelineView-driven elapsed-time ticker at ~1 s resolution (suppresses on settled compound state); committed shows "CONFIRMED Booking complete." + provider_reference + sorted evidence dict; failed / rolled_back / rollback_failed show the humanized failure reason from evidence (recognized snake_case → readable copy: `rate_unavailable` → "Rate unavailable — provider re-quoted between price-lock and book.") + saga action plain copy; manual_review shows the awaiting-review notice + reason. |
| 6 | Live ticker | `TimelineView(.periodic(from: .now, by: 1.0))` re-renders the elapsed label once per second without a manual `Timer`/`Task`. `Elapsed: Ns` for the first minute, then `Elapsed: Mm Ss`. Suppresses when settled = true so a leg that landed doesn't keep ticking under the historical record. |
| 7 | Strip wiring | `CompoundLegStrip` row becomes tappable when an `onTapLeg` closure is provided (older non-interactive callers keep the original look — `metadataFor`/`isExpanded`/`onTapLeg` all default to no-ops). ChatView passes four closures: `metadataFor`, `isExpanded`, `onTapLeg` (with an `.easeInOut(duration: 0.18)` animation on the toggle). Chevron rotation is its own short animation tied to the `expanded` flag; together they feel of a piece. |

## Visual

| State | Light | Dark |
|---|---|---|
| Pending | `leg-detail-pending-light.png` — hotel row expanded; QUEUED / Waiting for "Booking flight ORD → LAS" | — |
| In flight | `leg-detail-in-flight-light.png` — hotel row expanded; SEARCHING / Booking.com — available rooms / Elapsed: 17s ticker | — |
| Committed | `leg-detail-committed-light.png` — flight row expanded; CONFIRMED / Booking complete / DUFFEL_ord_… reference + 4-line evidence dict (carrier / depart / route / seats) | `leg-detail-committed-dark.png` |
| Failed | `leg-detail-failed-light.png` — hotel row expanded; FAILED / Rate unavailable… + SAGA / Saga halted; dependent legs will roll back. | — |
| Manual review | `leg-detail-manual-review-light.png` — hotel row expanded; MANUAL REVIEW / Awaiting manual review… + REASON | — |

iPhone 17 simulator. Brief calls for 5 light + 1 committed-dark = 6 PNGs total. All under `docs/notes/ios-compound-leg-detail-1-screenshots/`.

## Tests

**11 new tests** in `apps/ios/LumoTests/CompoundLegDetailTests.swift`, five slices:

- **Frame metadata pass-through (2)** — provider_reference + timestamp + evidence flow through the parser; non-string evidence values coerce to a string form rather than dropping the frame; older frames without metadata still decode.
- **Metadata stamping on transition (3)** — the in_flight transition stamps `firstSeenInFlightAt`; redundant in_flight re-emits don't reset the stamp; provider_reference + evidence land on commit; the in_flight stamp survives the committed update so the "Elapsed" record stays meaningful after the leg lands.
- **Tap-to-expand state (3)** — `toggleCompoundLegDetail` flips the `Set<String>` idempotently; multiple legs may be expanded concurrently (comparison-friendly UX); `reset()` clears both metadata and the expanded set.
- **`.empty` fallback (1)** — `compoundLegMeta` returns the empty record for an unseen leg so the view always reads a usable value rather than branching on nil.
- **Seed seam (1)** — `_seedForTest` accepts `compoundMetadata` + `compoundExpanded` so fixture and tests can drive both layers.

Plus: the existing `CompoundLegStripTests.test_parseLegStatusFrame_decodesLegIDAndStatus` equality assertion drops to a per-field check now that the struct grew three optional trailing fields. The byte-perfect equality the old test relied on no longer holds when the wire frame carries a timestamp; checking `leg_id` + `status` keeps the contract intent without depending on which trailing fields the parser captures.

xcodebuild test on iPhone 17 Sim → **all green**. LumoTests bundle 262 → 273 (+11).

## Gates

- `xcodebuild test` — green (262 → 273 tests).
- iOS build — clean.
- No web changes; npm test not run for this lane.

## Out of scope (per brief)

- **Web port.** Web doesn't have this surface yet; iOS is canonical. File `WEB-COMPOUND-LEG-DETAIL-1` follow-up to mirror the same shape on web once the iOS UX has soaked.
- **Edit/cancel actions on a leg from the detail panel.** File `IOS-COMPOUND-LEG-EDIT-1` follow-up.
- **Rollback animation showing dependent-leg cascade.** Already covered by the separately-filed `IOS-COMPOUND-ROLLBACK-VIEW-1`.

## Notes for review

1. **Inline expand vs sheet — chose inline.** Three reasons: (1) the strip lives in the chat scroll surface, and a sheet would lose context for the demo flow (the user is watching a multi-agent dispatch unfold; popping to a modal feels heavy); (2) the brief explicitly calls out "comparison-friendly UX" — multiple legs may be expanded simultaneously, which is awkward in a sheet; (3) the chevron rotation pattern is more native for an expand-in-place affordance and reads well at the per-row scale (vs sheet semantics, which feel right for a full-screen drill-down).

2. **Dependency-name resolution is a heuristic.** The orchestrator's `assistant_compound_dispatch` frame doesn't ship an explicit dependency graph today, so the pending branch names "the previous leg in dispatch order" as the wait target. This matches what users typically see (legs roughly in dispatch order). When/if the orchestrator-side payload is extended with explicit dep edges, this view flips to the real graph — same view, replace one helper. Filed as part of the future WEB-COMPOUND-LEG-DETAIL-1 brief.

3. **`firstSeenInFlightAt` survives across status transitions.** Locked by `test_metadataPersists_throughCommittedAfterInFlight`. The intent: even after a leg lands, the detail panel can still display "Elapsed: …" as a historical record (today the committed branch doesn't display it, but future content surfaces — e.g. "Booked in 1m 12s" badges — can read the same value).

4. **Failure reason mapping is light-touch.** `humanizeReason` covers six recognized snake_case codes (`rate_unavailable`, `card_declined`, `provider_timeout`, `inventory_changed`, `policy_blocked`, `duplicate_idempotency`) with cleaner copy; unknown codes pass through with underscores → spaces rather than risk hiding signal. The mapping is small enough that adding new codes as the saga ships them is a one-line edit.

5. **TimelineView for the ticker.** SwiftUI's TimelineView is the right idiom — it re-renders the body once per second without a manual Timer/Task and doesn't leak when the view disappears. Suppression is via the outer `if let started = …, !settled` gate; the timeline simply stops rendering when the gate fails.

6. **Saga-action copy is plain English, not a status taxonomy reference.** Reviewers will see "Saga halted; dependent legs will roll back." rather than "TX_FAILED → halt + cascade compensations." The user-facing surface is the demo and the ops-on-call view; both want plain copy. The status taxonomy is still surfaced verbatim in the row pill (`failed`, `rolled back`) for the technical eye.

7. **DEBUG fixture seam.** Sixth such launch-arg fixture (`LumoStartTab`, `LumoNotificationsFixture`, `LumoSeedChips`, `LumoSeedFlightOffers`, `LumoSeedBookingConfirmation`, `LumoSeedCompoundDispatch`, now `LumoSeedCompoundLegDetail`). Already covered by the open `DEV-FIXTURE-CONSOLIDATION-1` follow-up; one CONTRIBUTING note will document the convention once that lane fires.

## Estimate vs actual

Brief implied a tap-to-expand SwiftUI panel + 5 status branches + live ticker + 6 PNGs. Actual: ~40 LOC model extension + ~70 LOC decoder/VM extension + ~250 LOC SwiftUI detail view + ~40 LOC strip wiring + ~10 LOC ChatView wiring + 273 LOC tests + ~110 LOC fixture seed + ~30 LOC capture-script variant + 6 PNGs across 5 commits. ~1.5 medium sessions.

Ready for review. Merge instructions per the standing FF-merge protocol.
