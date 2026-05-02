# Doctrine: selection card 280ms confirmation pattern (iOS)

**Decision:** every interactive selection card renders a tap as the
commit, not a tap-then-Continue. The pattern: tap row → state cascade
→ 280ms confirmation window → submit. No separate "Continue" CTA.

**Canonical for:** every iOS selection card the orchestrator can
emit — `flight_offers` (shipped), `food_menu`, `time_slots`,
`hotel_offers` (future), `restaurant_offers` (future).

## The pattern in detail

When the user taps a row:

1. **Immediate feedback (0 ms)** — the tapped row gets the accent
   left-stripe and shows a "Selected" pill. The chip / button /
   stripe state flips synchronously inside the SwiftUI
   `@State`-bound view. No network, no async waiting — purely a
   visual response to the touch event.
2. **Sibling cascade (0 ms)** — every non-selected row in the same
   card fades to 40% opacity (`opacity(dimmed ? 0.4 : 1)`) and
   becomes non-tappable (`.disabled(true)`). This signals "your
   choice is locked in; the others are no longer the active path"
   without removing them from the layout.
3. **Confirmation window (~280 ms)** — the user sees the cascade
   land and the card holds in this state. The window is long
   enough for the user to register their commit and reflexively
   reach for an undo (we don't ship undo today, but the window is
   the affordance) and short enough to feel responsive.
4. **Submit (after 280 ms)** — the card calls `onSubmit(text)`
   with the natural-language string the orchestrator's already-
   established handoff parser expects. For flight offers that's
   `FlightOffersSubmit.text(for:)` →
   `"Go with offer <id> — the <time> <carrier> direct for <price>."`
   The orchestrator handles the rest; the card has done its job.

A separate "Continue" / "Confirm" CTA would force a second tap to
commit the choice the user already made. The single-tap pattern
costs one re-render but saves one tap on every booking flow — and
the booking flow is the product's primary path.

## Why 280 ms specifically

Mirrors the `SUBMIT_DELAY_MS = 280` value baked into the web
component. Reasons that drove the original number:

- **Below 200 ms** the cascade animation hasn't finished landing
  yet (SwiftUI's `LumoAnimation.quick` is ~250 ms; we want the
  visual to settle before submit fires).
- **Above 350 ms** users start tapping a second time because they
  think the first tap didn't register.
- 280 ms threads the needle — long enough for the cascade, short
  enough that the chat surface doesn't feel laggy.

Cross-platform parity is also a soft constraint: web's component
ships the same number, so a user moving between iPhone and laptop
sees the same commit cadence on both surfaces.

## What every selection card MUST share

The doctrine is the contract — every selection card on the iOS
side has to:

| Behaviour | Required |
|---|---|
| Tap row → immediate accent stripe + "Selected" pill on that row | Yes |
| Tap row → sibling rows fade to 40% opacity + become non-tappable | Yes |
| 280 ms (`±20 ms`) confirmation window before `onSubmit` fires | Yes |
| `onSubmit` carries a natural-language string the orchestrator's existing handoff parser already understands | Yes |
| No separate Continue / Confirm CTA inside the card | Yes |
| `initialSelectedID: String? = nil` parameter for the DEBUG fixture seam (so screenshot capture can land the post-tap state without scripting a touch) | Yes |
| Pre-tap row taps disabled while `isStreaming` (parent's responsibility — pass `isDisabled: viewModel.isStreaming`) | Yes |

Two things are explicitly NOT required:

- **Undo affordance** — we ship the 280 ms window as the *implicit*
  undo (user can mentally cancel during it) but no UI undo. If user
  research surfaces accidental-commits as a problem, revisit with
  an explicit undo banner that appears for 3-5 seconds post-submit.
- **Visual choice between accent-stripe and full-row-fill for the
  selected state** — accent-stripe is the canonical Lumo style; if
  a future card has a stronger reason to fill the row instead
  (e.g., a colour-coded category), the doctrine is still satisfied
  as long as the cascade + window + submit-string contract holds.

## Reference implementation

`apps/ios/Lumo/Components/FlightOffersSelectCard.swift` is the
canonical implementation. New cards (food menu, time slots, hotel
offers) should keep:

- `private static let submitDelay: TimeInterval = 0.28`
- `selectedOfferID` (or analogous `@State`) drives the cascade
- `dimmed = selectedOfferID != nil && !selected` for sibling rows
- `.opacity(dimmed ? 0.4 : 1)` + `.disabled(dimmed)`
- `Task.sleep(nanoseconds: UInt64(Self.submitDelay * 1_000_000_000))`
  before calling `onSubmit`

The `FlightOffersSubmit` enum that builds the natural-language
submit string is per-card (each kind has its own handoff format
the orchestrator expects); the *shape* of the helper —
`enum <Kind>Submit { static func text(for: <Payload>) -> String }`
— is uniform and tested.

## When to revisit

Revisit if user research surfaces:

- Accidental commits ("I tapped the wrong row and there was no way
  to undo"). Answer: add a 3-5 second undo banner; keep the 280 ms
  window the same.
- 280 ms feeling laggy at the chat surface (e.g., on a low-end
  device where cascade + submit + next-turn typing-indicator stack
  visibly). Answer: profile the chain, lower if the cascade lands
  faster than 250 ms with measured paint.
- A card type with > 5 rows where the cascade-fade looks chaotic.
  Answer: scroll-into-view on the selected row + don't fade rows
  that are off-screen.

Cross-card UX consistency is the win — when a user taps their
first iOS booking flow, the cadence should match every flow they
use after.

## Source pointers

- `apps/ios/Lumo/Components/FlightOffersSelectCard.swift` —
  canonical implementation (CHAT-FLIGHT-SELECT-CLICKABLE-1).
- `apps/web/components/FlightOffersSelectCard.tsx` —
  cross-platform reference; `SUBMIT_DELAY_MS = 280`.
- `apps/ios/Lumo/Models/Selection.swift` — typed payloads for the
  three known kinds (flight_offers, food_menu, time_slots) +
  `*Submit` helpers (only flight_offers shipped today; food and
  time slots will land their helpers when the SwiftUI cards land
  in IOS-SELECT-CLICKABLE-FOOD-1 / -RESTAURANT-1).
- `apps/ios/LumoTests/FlightOffersSelectCardTests.swift` —
  pinned 280 ms contract.
