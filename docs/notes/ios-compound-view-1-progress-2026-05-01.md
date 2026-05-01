# IOS-COMPOUND-VIEW-1 — progress + ready-for-review, 2026-05-01

Branch: `claude-code/ios-compound-view-1` (5 commits, branched from
`origin/main` at `15f196b`).

Mirrors Codex's `WEB-COMPOUND-VIEW-1` `CompoundLegStrip` on iOS.
The orchestrator emits an `assistant_compound_dispatch` SSE frame
when a turn fans out into a multi-agent compound transaction; iOS
now decodes it, mounts a per-leg dispatch strip in-thread, and
subscribes to the per-compound `/api/compound/transactions/:id/stream`
for live status updates. Settled-state suppression matches web
exactly.

## What shipped

| Δ | Surface | Outcome |
|---|---|---|
| 1 | Wire-shape parsing | `ChatService.parseFrame` decodes `assistant_compound_dispatch` into a typed `.compoundDispatch(CompoundDispatchPayload)` ChatEvent. Tolerant: drops malformed legs, falls back to `.manual_review` for unknown statuses (matches web's `normalizeDispatchStatus`), returns nil when the dispatch carries no usable legs so the strip never renders empty. |
| 2 | Models | New `apps/ios/Lumo/Models/CompoundDispatch.swift`: `CompoundDispatchPayload`, `CompoundLeg`, `CompoundLegStatus` (8-value enum mirroring `LEG_STATUS_V2_STATUSES` in `apps/web/lib/sse/leg-status.ts`), `CompoundDispatchHelpers.{isSettled,glyph(for:)}` pure helpers. `isTerminal` mirrors web's `TERMINAL_STATUSES` set, `isPulsing` drives the cyan-dot pulse, `label` replaces underscores with spaces (web's `replace(/_/g, " ")`). |
| 3 | Live subscription | New `apps/ios/Lumo/Services/CompoundStreamService.swift` opens an SSE connection to `/api/compound/transactions/:id/stream` via `URLSession.bytes` and parses the `event: leg_status\ndata: <json>` two-line frame format web's EventSource consumes natively. Heartbeat comments (`: heartbeat`) skip; error events close. Returns an `AsyncThrowingStream<CompoundLegStatusUpdate>`; cancellation propagates through Task cancellation. |
| 4 | View-model | `ChatViewModel` grows `compoundDispatchByMessage[UUID:Payload]` + `compoundLegStatusOverrides[String:[String:CompoundLegStatus]]` (per-compound transaction id → leg id → latest status). `attachCompoundDispatch` seeds the override layer from the dispatch's initial statuses + opens the live subscription if the strip isn't already settled. The subscription closes itself when every leg reaches a terminal status (matches web's `if (settled) return` gate). `reset()` and `cancelAllCompoundStreams()` tear subscriptions down cleanly. |
| 5 | Public read helpers | `compoundDispatch(for:)` returns the cached payload regardless of subsequent user messages (like summary cards, the strip stays visible). `compoundLegStatus(compoundID:legID:fallback:)` reads the override layer with a fallback to the dispatch's initial status. `compoundSettled(_:)` is a convenience for the view to drive the Live/Settled badge. |
| 6 | View | `CompoundLegStrip` SwiftUI counterpart of `apps/web/components/CompoundLegStrip.tsx`. Header (MULTI-AGENT DISPATCH micro-label + "Planning the trip across N agents" + Live/Settled pill); N rows with agent glyph chip (✈ for flights, ⌂ for hotels, ◆ otherwise — matches web's substring rules) + description + agent_display_name + status pill. Pill color tokens match web exactly: success/error/warning for terminal kinds; elevated/edge with pulse dot for `in_flight` + `rollback_pending`; subtle inset for `pending`. Pulse animation suppresses once settled. |
| 7 | Wiring | `ChatView` mounts the strip below `BookingConfirmationCard` in the per-message `VStack` (the orchestrator emits compound-dispatch and confirmation summaries on different turn phases, so they never co-mount in practice). `RootView` injects a real `CompoundStreamService.makeFromBundle()` into ChatViewModel so live subscriptions hit the same `LumoAPIBase` URL as the chat stream. Tests pass nil so `attachCompoundDispatch` becomes a no-op on the subscription side. |
| 8 | DEBUG fixture | `RootView.seedCompoundDispatchFixture(state:)` keyed by `LumoSeedCompoundDispatch` launch arg; `live` → flight committed, hotel in_flight, restaurant pending; `settled` → all three committed. Capture-script gains `ios-compound-view-1` variant emitting both states. |

## Web ↔ iOS parity

The wire shapes are byte-identical. Status enum is pinned by a contract test on each side (web's `LEG_STATUS_V2_STATUSES` is the source of truth).

| Behaviour | Web | iOS |
|---|---|---|
| Frame arrives | `frame.type === "assistant_compound_dispatch"` → `m.compoundDispatch` on UIMessage | `.compoundDispatch(CompoundDispatchPayload)` ChatEvent → `compoundDispatchByMessage[assistantID]` upsert |
| Live subscription | `new EventSource("/api/compound/transactions/<id>/stream")` + `addEventListener("leg_status", …)` | `URLSession.bytes` consuming `event: leg_status\ndata: …` two-line frames via `CompoundStreamService.subscribe(...)` |
| Settled gate | `payload.legs.every(leg => TERMINAL_STATUSES.has(statuses[leg.leg_id] ?? leg.status))` | `CompoundDispatchHelpers.isSettled(legs:statuses:)` (same predicate) |
| Settled side-effects | Close EventSource; suppress pulse animation; badge → "Settled" | Cancel subscription Task; suppress pulse animation; badge → "Settled" |
| Strip stays visible after later user message | Yes | Yes (`compoundDispatch(for:)` reads cached payload regardless) |
| Pulse statuses | `in_flight` + `rollback_pending` | `in_flight` + `rollback_pending` (locked by test) |
| Status label | `status.replace(/_/g, " ")` | `rawValue.replacingOccurrences(of: "_", with: " ")` (locked by test) |
| Agent glyph | substring `flight`/`hotel` else `◆` | substring `flight`/`hotel` else `◆` (locked by test) |

## Visual

| State | iOS shot |
|---|---|
| Live, light | `compound-dispatch-light.png` — Live pill, flight committed (green), hotel in flight (cyan dot pulsing), restaurant pending (subtle gray) |
| Live, dark | `compound-dispatch-dark.png` — same content, dark surface tokens; cyan-dot pulse holds AA against the dark surface |
| Settled, light | `compound-settled-light.png` — Settled badge, all three legs committed (green pill) |
| Settled, dark | `compound-settled-dark.png` — same; pulse animation suppressed (no dot on any pill) |

iPhone 17 simulator. All four under `docs/notes/ios-compound-view-1-screenshots/`.

## Tests

**15 new tests** in `apps/ios/LumoTests/CompoundLegStripTests.swift`:

- **`assistant_compound_dispatch` parse contract (4)** — happy-path 3-leg decode, empty legs → `.other`, malformed leg drops while well-formed siblings survive, unknown status falls back to `.manual_review` (matches web's `normalizeDispatchStatus` fallback).
- **Leg-status frame parse (4)** — `CompoundStreamService.parseLegStatusFrame` happy path, empty `leg_id` → nil, unknown status → nil (iOS-side strict; keeps the previous status rather than mapping to `manual_review` mid-stream), malformed JSON → nil.
- **Render rule + settled (3)** — `compoundDispatch(for:)` returns the cached payload regardless of subsequent user messages; user-role messages never surface dispatches; `compoundSettled` flips true only when every leg's override-or-initial status is terminal, transitioning correctly through partial → fully settled.
- **Status enum invariants + glyph (4)** — terminal-status set matches web's `TERMINAL_STATUSES` exactly; pulsing set matches web's pulse gate; `status.label` replaces underscores with spaces; `glyph` substring match catches all four web cases.

xcodebuild test on iPhone 17 Sim → **all green**. LumoTests bundle 247 → 262 (+15).

## Gates

- `xcodebuild test` — green (247 → 262 tests).
- iOS build — clean.
- No web changes; npm test not run for this lane.

## Out of scope (per brief)

- **Tap-leg-for-detail UX.** Filed as `IOS-COMPOUND-LEG-DETAIL-1` follow-up.
- **Rollback visualization** (failed leg + rollback indication on dependent legs). Filed as `IOS-COMPOUND-ROLLBACK-VIEW-1` follow-up.
- **Compound-init from iOS.** Out of scope per brief — orchestrator owns dispatch initiation; iOS just renders.

## Notes for review

1. **Compound strip stays visible after user moves on.** Same pattern as `BookingConfirmationCard`: `compoundDispatch(for:)` reads the cached payload without checking for a later user message. The strip becomes a settled record once all legs terminal, mirroring web's `data-settled="true"` static state.

2. **Live subscription closes on settled.** `attachCompoundDispatch` opens the URLSession-bytes subscription only if the strip isn't already settled, and the subscription's per-frame loop exits as soon as `compoundSettled(_:)` flips true. Mirrors web's `if (settled) return` gate exactly. Cleanup happens via `Task.cancel()` paths (reset, view teardown).

3. **iOS-side strict on unknown leg-status frames.** Web's `parseLegStatusFrame` returns null for unknown statuses; iOS does the same (rather than the dispatch-frame `manual_review` fallback). Reasoning: the dispatch frame's status is the *initial* posture (often `pending`), while the per-compound stream's per-leg updates are *transitions*. A garbage transition shouldn't override a known good status with `manual_review` — better to keep the previous status and wait for the next valid frame.

4. **`CompoundStreamService.makeFromBundle()` injection.** Constructed in RootView from the same `LumoAPIBase` Info.plist key as `ChatService`. Tests pass `nil` for the service so `attachCompoundDispatch` becomes a no-op on the subscription side; the override layer is driven directly via `_applyCompoundLegStatusForTest`. Keeps tests fast and deterministic without faking URLSession.

5. **`CompoundLegStrip` mount order.** Below `BookingConfirmationCard`, above `SuggestionChips` in the per-message `VStack`. The orchestrator emits dispatch and confirmation summaries on different turn phases (dispatch on the trip-fan-out turn, confirmation on the per-leg gate), so they don't co-mount in practice. If a future orchestrator path emitted both on the same turn, the visual order is: confirmation first, then dispatch — matches web's component-render order in `apps/web/app/page.tsx`.

6. **DEBUG fixture seam: `LumoSeedCompoundDispatch <state>`.** Fifth such launch-arg fixture (after `LumoStartTab`, `LumoNotificationsFixture`, `LumoSeedChips`, `LumoSeedFlightOffers`, `LumoSeedBookingConfirmation`) — already covered by the open `DEV-FIXTURE-CONSOLIDATION-1` follow-up. Takes a string value rather than a bool because the strip needs to render two distinct states for capture.

## Estimate vs actual

Brief implied a SwiftUI strip + frame parsing + EventSource subscription + settled-state. Actual: ~110 LOC iOS models + ~50 LOC dispatch decoder + ~85 LOC live-stream service + ~120 LOC view-model state/subscription/helpers + ~210 LOC SwiftUI view + ~25 LOC ChatView mount + 247 LOC tests + ~70 LOC fixture seed + ~20 LOC capture-script variant + 4 PNGs across 5 commits. ~1.5 medium sessions.

Ready for review. Merge instructions per the standing FF-merge protocol.
