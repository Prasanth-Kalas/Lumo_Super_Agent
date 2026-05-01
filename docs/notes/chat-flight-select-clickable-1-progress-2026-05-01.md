# CHAT-FLIGHT-SELECT-CLICKABLE-1 — progress + ready-for-review, 2026-05-01

Branch: `claude-code/chat-flight-select-clickable-1` (8 commits,
branched from `origin/main` at `e00b7ef`).

## What shipped

The bug: in production, when the orchestrator returned flight options
the user had to type the carrier name in the chat composer to
select. The card showed clickable rows but only set a radio-style
selection — the actual commit lived behind a separate "Continue
with this flight" footer button. Tested twice on prod; second time
the orchestrator gracefully reverse-resolved "frontier" → Frontier
rows, but it's brittle.

Fix: tap a row, that row commits. Single step, with a transient
"Selected" pill + dim-others animation so the user sees the
commit before the chat advances.

| Δ | Surface | Outcome |
|---|---|---|
| 1 | Web row interaction | Each row in `apps/web/components/FlightOffersSelectCard.tsx` is still a `<button>`, but tap now sets `selectedId` and a `useEffect` cascade fires `onSubmit(buildOfferSubmitText(offer))` after a 280ms confirmation window. During that window the row shows a "SELECTED" pill, sibling rows fade to 40% opacity. The previous "Continue with this flight" footer CTA + the radiogroup role are gone — single-tap is now the only commit path. |
| 2 | Web keyboard nav | Each row is a focusable button with focus-visible ring (`focus-visible:bg-lumo-elevated/80 focus-visible:ring-1 focus-visible:ring-inset`). Tab walks rows in DOM order, Enter / Space fires the same tap path. `aria-pressed` on each row reflects the committed-row state. |
| 3 | iOS net-new | iOS had **no** flight-offers UI today — this lane added selection-frame plumbing from scratch. `ChatService.parseFrame` decodes `selection` SSE frames into a typed `.selection(InteractiveSelection)` ChatEvent (only `flight_offers` decoded today; `food_menu` / `time_slots` round-trip via `.unsupported(kind:)` so follow-ups don't need to re-route the SSE plumbing). New types in `apps/ios/Lumo/Models/Selection.swift`: `InteractiveSelection`, `FlightOffersPayload`, `FlightOffer` (+ Slice / Segment / Endpoint), `FlightOffersSubmit` (the submit-text builder, mirroring `buildOfferSubmitText`). |
| 4 | iOS view-model | `ChatViewModel.selectionsByMessage: [UUID: [InteractiveSelection]]` keyed by the assistant message id; `attachSelection` runs from the SSE `case .selection` branch. `selections(for:)` is the public read-side helper applying the same stale-suppression rule as `suggestions(for:)` — only the latest assistant message before any user message surfaces selections. The `hasUserMessageAfter` helper is shared between both rules. `_seedForTest` grows a `selections:` parameter for the test + DEBUG-fixture seam. |
| 5 | iOS card | `FlightOffersSelectCard.swift` is the SwiftUI counterpart to the web component. Each row is a `Button`, tap → `selectedOfferID` set → `DispatchQueue.main.asyncAfter(deadline: .now() + 0.28)` fires `onSubmit`. ChatView wires the submit closure through `viewModel.sendSuggestion(_:)` — same entry point chip taps use, so chip + card produce indistinguishable user turns from the orchestrator's perspective. |
| 6 | Pill compaction | The literal "SELECTED" text wrapped to two lines on iPhone width when the pill sat alongside the times row. Replaced with a compact 8pt cyan dot — VoiceOver still announces "selected" via `.accessibilityAddTraits(.isSelected)` on the row. |

## Web ↔ iOS parity

The orchestrator-handoff submit string is identical across both
surfaces (locked by tests on each side):

```
Go with offer {offer_id} — the {time} {carrier}{ direct | (with connection)} for {price}.
```

| Behaviour | Web | iOS |
|---|---|---|
| Frame arrives | `frame.type === "selection"` → `assistantSelections` array on UIMessage | `.selection(InteractiveSelection)` ChatEvent → `selectionsByMessage[assistantID]` upsert (latest-wins per kind) |
| Render rule | `m.role === "assistant" && m.selections?.length && !userMessageExistsAfter(m.id).exists` | `viewModel.selections(for: message)` (same stale-suppression rule as `suggestions(for:)`) |
| Tap commit | Row click → `setSelectedId` → `useEffect` after 280ms → `onSubmit(buildOfferSubmitText)` | `Button` action → `selectedOfferID = offer.id` → `DispatchQueue.main.asyncAfter(0.28)` → `onSubmit(FlightOffersSubmit.text(for:))` |
| Selected visual | Accent stripe on left edge, pill in row, sibling rows `opacity-40` | Same accent stripe, compact cyan dot, sibling rows `.opacity(0.4)` |
| Frozen window | `frozen = !!decidedLabel \|\| !!disabled \|\| selectedId !== null` | `frozen = isDisabled \|\| (selectedOfferID != nil && !selected)` |
| Typing fallback | Composer types still parsed by orchestrator; card never intercepts global keystrokes | Composer types still parsed by orchestrator; card never installs key-event handlers |

## Before / after

### Web — production "type to select"

Before this lane the only way to commit a flight selection on
production was to either tap the row to highlight it AND click the
"Continue with this flight" footer CTA, OR type the carrier name
into the chat composer. That second path is what users actually
hit twice in production testing — the row click looked
non-committal because nothing visually changed beyond a thin
accent stripe, and the CTA button's "Select a flight to continue"
copy in the disabled state read more like instruction than
action.

### Web — after this lane

`docs/notes/chat-flight-select-clickable-1-screenshots/web/flight-offers-{light,dark}.png`. Three offers listed (United 7:15 / Frontier 9:30 / Alaska 2:50). Frontier 9:30 is the post-tap selected row: accent stripe on left, "SELECTED" pill on the right side of the times row, sibling rows fade to 40% opacity. The footer CTA is gone — the only affordance is the row.

### iOS — before this lane

There was no flight-offers card on iOS at all. When the orchestrator
emitted a `selection` frame, iOS dropped it on the floor (no
parser) and rendered the assistant turn as plain prose listing
the options. Users had no choice but to type the carrier name in
the composer.

### iOS — after this lane

`docs/notes/chat-flight-select-clickable-1-screenshots/ios/flight-offers-{light,dark}.png`. Same three offers, same Frontier-selected post-tap state. iPhone 17 simulator. The card sits below the assistant prose ("Here are the morning options.") between the message bubble and the (absent in this fixture) suggestion-chip strip.

## Tests

**15 web tests** in `apps/web/tests/chat-flight-select-clickable.test.mjs`:

- 5 `buildOfferSubmitText` pure-helper tests — locks the orchestrator
  contract: `offer_id` verbatim, "direct" vs "(with connection)"
  phrasing, $-prefixed USD prices, carrier name included.
- 10 source-level structural tests on the `.tsx` — each row is a
  button with stable testid, `data-selected` + `data-dimmed`
  attributes, the `useEffect` submit cascade with cleanup, frozen
  state on committed selection, "Selected" pill inline, no
  surviving Continue-button CTA + no `role="radio"` /
  `role="radiogroup"` left, focus-visible ring, `aria-pressed`,
  typing-fallback preserved (no global keystroke listeners).

**11 iOS tests** in `apps/ios/LumoTests/FlightOffersSelectCardTests.swift`:

- 5 parse-contract tests — `.selection(.flightOffers(...))`
  decode, unknown kinds round-trip via `.unsupported`, missing
  kind / empty offers / malformed offers fall through gracefully.
- 3 render-rule tests — `selections(for:)` returns chips on the
  latest assistant before user message, isEmpty otherwise,
  isEmpty for user-role messages.
- 3 submit-contract tests — submit text carries `offer_id`
  verbatim, picks "direct" vs "(with connection)" correctly,
  `sendSuggestion` appends user bubble + render rule auto-clears
  the now-stale selection card.

xcodebuild test → all green. LumoTests bundle 218 → 229 (+11).

## Gates

- `npm run typecheck` — green.
- `npm run lint` — green; only the three pre-existing warnings
  in untouched files.
- `npm run lint:registry` — green.
- `npm run lint:commits` — green.
- `npm run build` — green.
- `npm test` — green; full suite (474 passing) + 15 new tests.
- `xcodebuild test` — green; 229 tests passing.

## Out of scope (per brief)

- **Hotel / restaurant / food selection cards.** Filed as
  follow-ups to replicate the pattern for the `food_menu` and
  `time_slots` selection kinds:
  - `WEB-SELECT-CLICKABLE-FOOD-1`
  - `WEB-SELECT-CLICKABLE-RESTAURANT-1` (i.e. time_slots)
  - `IOS-SELECT-CLICKABLE-FOOD-1`
  - `IOS-SELECT-CLICKABLE-RESTAURANT-1`
- **Server-side parser changes.** The orchestrator already understands
  the `Go with offer {offer_id}` submit text; no changes to
  `flight_price_offer` were needed.

## Notes for review

1. **Scope discovery: iOS half was bigger than the brief implied.**
   The brief named `FlightOffersSelectionView` as if it existed on
   iOS — it did not. iOS had zero `selection` SSE plumbing today;
   when the orchestrator emitted a flight-offers selection frame,
   iOS dropped it. So this lane built the SwiftUI card *and* the
   selection-frame parsing *and* the ChatViewModel state from
   scratch, in addition to the web row-interaction tweak. Roughly
   the same lift as CHAT-SUGGESTED-CHIPS-1-IOS. Flagged before
   coding, proceeded with both sides per the brief intent.

2. **`buildOfferSubmitText` contract.** The orchestrator's
   `flight_price_offer` handoff parses the `offer_id` substring
   out of the natural-language submit string — the rest is
   human-readable scaffolding. Both web (`buildOfferSubmitText`
   in `lib/flight-offers-helpers.ts`) and iOS
   (`FlightOffersSubmit.text(for:)` in `Models/Selection.swift`)
   produce the *byte-identical* string for the same offer
   payload. Locked by tests on each side. Don't drift.

3. **`SUBMIT_DELAY_MS = 280` (web) / `submitDelay: TimeInterval = 0.28` (iOS).**
   Long enough for the user to perceive the row commit (pill +
   dim-others animate) before the chat advances; short enough to
   feel responsive. If we want to make this configurable for
   accessibility, the value lives in one place per surface.

4. **Frozen state covers committed selections.** Once
   `selectedId` is set, sibling row taps are no-ops because the
   row buttons disable. This is the soft "no undo" — the user
   can't change their mind mid-window. If you want an undo
   affordance, add an explicit "Cancel" button; the brief picks
   single-tap-commit as the doctrine.

5. **No Continue-with-this-flight CTA.** The footer pill is gone
   in the offered state. When a turn comes back as
   `decidedLabel === "confirmed" | "cancelled"`, a thin status
   line replaces the row interactivity. This matches the
   confirmation-card pattern in
   `ItineraryConfirmationCard` /
   `TripConfirmationCard`.

6. **Pill → dot on iOS.** The literal "SELECTED" text wrapped on
   iPhone width when the pill sat alongside the times row.
   Compact cyan dot is the visual; VoiceOver gets the literal
   "selected" via `.accessibilityAddTraits(.isSelected)` on the
   row. If we move to iPad / watchOS later, the longer pill text
   may fit naturally; the visual is intentionally small to
   defend the times-row layout on mobile widths.

7. **DEBUG fixture seam: `initialSelectedID`.** The card grew a
   `var initialSelectedID: String? = nil` prop that pre-flips
   `selectedOfferID` at `.onAppear` — purely for screenshot
   capture of the post-tap visual state without scripting a
   touch event. Production callers leave this nil; the
   `-LumoFlightOffersSelectedID` launch arg is wrapped in
   `#if DEBUG` and read from `UserDefaults` inside ChatView.

8. **One more launch-arg fixture.** This lane adds
   `-LumoSeedFlightOffers YES` and `-LumoFlightOffersSelectedID
   <offer_id>` — that's now the fourth such DEBUG launch-arg
   fixture pattern after `-LumoStartTab`,
   `-LumoNotificationsFixture`, and `-LumoSeedChips`. The
   already-filed DEV-FIXTURE-CONSOLIDATION-1 follow-up should
   absorb this when it ships.

## Estimate vs actual

Brief implied a row-interaction tweak on web + a parallel iOS
tweak. Actual: ~190 LOC web component refactor + 30 LOC web
helper + 165 LOC web tests + ~220 LOC iOS models + ~70 LOC iOS
service decoder + ~70 LOC iOS view-model + ~245 LOC iOS view +
275 LOC iOS tests + 90 LOC iOS fixture + 75 LOC web fixture page
+ 75 LOC web capture script + 20 LOC iOS capture-script variant
+ 4 PNGs across 8 commits. ~1.5 medium sessions.

Ready for review. Merge instructions per the standing FF-merge
protocol.
