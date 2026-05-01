# IOS-BOOKING-CONFIRM-AUTOFILL-1 — progress + ready-for-review, 2026-05-01

Branch: `claude-code/ios-booking-confirm-autofill-1` (5 commits,
branched from `origin/main` at `e839a62`).

Path A re-scope: mirrors web's existing `ItineraryConfirmationCard`
exactly. The richer payload (traveler/payment summary rows,
"Different traveler" button) the original brief envisioned isn't
achievable today because web doesn't emit those fields — that work
is filed as `IOS-CONFIRMATION-RICH-PAYLOAD-1` and lands as a small
follow-up once Codex extends `ConfirmationSummary.payload` and web's
card.

## What shipped

| Δ | Surface | Outcome |
|---|---|---|
| 1 | SSE frame parsing | `ChatService.parseFrame` decodes `summary` frames into a typed `.summary(ConfirmationSummary)` ChatEvent. Only `structured-itinerary` gains a typed payload today; other kinds (`structured-trip`, `structured-reservation`, `structured-cart`, `structured-booking`) round-trip via `.summary(.unsupported(kind:))` — same forward-compat pattern as the `selection` envelope from CHAT-FLIGHT-SELECT-CLICKABLE-1. |
| 2 | Models | New `apps/ios/Lumo/Models/Confirmation.swift`: `ConfirmationSummary` enum, `ConfirmationEnvelope` (hash + session/turn/rendered_at), `ItineraryPayload` + `ItinerarySlice` + `ItinerarySegment` (mirror of the web `ItineraryPayload`), `ConfirmationDecision` enum (`.confirmed` / `.cancelled`), `BookingConfirmationSubmit` pure helpers (`confirmText` / `cancelText` byte-identical with `apps/web/app/page.tsx`'s `onConfirm` / `onCancel` calls). |
| 3 | View-model | `ChatViewModel.summariesByMessage: [UUID: ConfirmationSummary]` keyed by assistant message id, attached when a `summary` frame arrives. `summary(for:)` is the public read-side helper — returns the cached summary regardless of subsequent user messages (unlike chips and selection cards, the summary stays visible after the user acts so it can show the decided-label receipt). `summaryDecision(for:)` reads the next user message after the assistant turn and derives `.confirmed` / `.cancelled`, mirroring web's `userMessageExistsAfter(m.id)` → `decidedLabel` pattern. |
| 4 | View | `BookingConfirmationCard.swift` — SwiftUI counterpart of `apps/web/components/ItineraryConfirmationCard.tsx`. Header: route summary (left) + total (right) with the same micro-label / value typography as web. Slice/segment list with mono carrier chips, IATA route, and departure→arrival times. Footer: offer_id (small mono, middle-truncated) + Confirm + Cancel buttons, OR the decided-label state (`Confirmed — booking…` / `Cancelled`) once the user has acted. Same Linear/Vercel-dark visual posture web uses. |
| 5 | ChatView mount | The card mounts in the per-message `VStack` between `FlightOffersSelectCard` and `SuggestionChips`. Confirm + Cancel both route through `ChatViewModel.sendSuggestion(_:)` — the same entry point chip taps and flight-row taps use — so the orchestrator's `isAffirmative` regex sees an indistinguishable confirm-turn whether the user typed `Yes, book it.`, tapped a chip, or tapped Confirm here. |
| 6 | DEBUG fixture | `RootView.applyDebugLaunchArgs` grows a `-LumoSeedBookingConfirmation YES` branch + `seedBookingConfirmationFixture` (DEBUG-only); `scripts/ios-capture-screenshots.sh` adds the `ios-booking-confirm-autofill-1` variant. |

## Web ↔ iOS parity

The orchestrator-side autofill from CHAT-PROFILE-AUTOFILL-1 is upstream and invisible to this card — the orchestrator now skips the "give me your name / email / payment" turn when scopes are connected, so the user lands directly on this confirmation card from the offer-select step. The card itself renders the same fields as web; the autofill effect is in the routing.

| Behaviour | Web | iOS |
|---|---|---|
| Frame arrives | `frame.type === "summary"` → `m.summary` on UIMessage | `.summary(ConfirmationSummary)` ChatEvent → `summariesByMessage[assistantID]` upsert |
| Render rule | `m.role === "assistant" && m.summary?.kind === "structured-itinerary"` | `viewModel.summary(for: message)` returns `.itinerary` |
| Confirm tap | `onConfirm={() => void sendText("Yes, book it.")}` | `onConfirm: { viewModel.sendSuggestion(BookingConfirmationSubmit.confirmText) }` |
| Cancel tap | `onCancel={() => void sendText("Cancel — don't book that.")}` | `onCancel: { viewModel.sendSuggestion(BookingConfirmationSubmit.cancelText) }` |
| Decided state | `decidedLabel` prop set when `userMessageExistsAfter(m.id)` | `summaryDecision(for:)` reads the next user message + classifies on `cancel`-prefix |
| Stays visible after decision | yes — shows `Confirmed — booking…` / `Cancelled` | yes — same terminal labels |

The Confirm / Cancel submit strings are pinned by a contract test (`test_confirmText_andCancelText_locked`) so a drift in either surface trips the build.

## Visual

| State | iOS shot |
|---|---|
| Light | `confirmation-card-light.png` — user "Yes, the Frontier 9:30 nonstop." → assistant "Here's the final price — tap Confirm to book." → confirmation card with route header (San Francisco → Las Vegas), $189 total, F9 segment row, offer_id (middle-truncated), Cancel + Confirm pill |
| Dark | `confirmation-card-dark.png` — same content, dark surface tokens; Confirm pill inverts to `LumoColors.label` background with `LumoColors.background` text (matches web's `bg-lumo-fg text-lumo-bg`) |

Both shots at iPhone 17 simulator. The cyan-dot / inversion-pair pattern from prior iOS sprints holds.

## Tests

**12 new tests** in `apps/ios/LumoTests/BookingConfirmationCardTests.swift`, three slices:

- **Parse contract (4)** — `summary` frame → `.summary(.itinerary(...))`; unknown kinds round-trip via `.unsupported(kind:)`; missing envelope fields fall through to `.other(type: "summary")`; malformed segments drop while preserving well-formed siblings.
- **Render rule + decision (5)** — `summary(for:)` returns the cached summary regardless of later user messages; `summary(for:)` is nil for user-role messages; `summaryDecision(for:)` is nil before user acts; `.confirmed` for affirmative replies; `.cancelled` for cancel-prefixed replies.
- **Submit contract (3)** — `sendSuggestion(confirmText)` appends a user bubble carrying `"Yes, book it."`; `sendSuggestion(cancelText)` appends `"Cancel — don't book that."`; the pinned-string test (`confirmText_andCancelText_locked`) trips the build if either drifts.

xcodebuild test on iPhone 17 Sim → **all green**. LumoTests bundle 229 → 241 (+12).

## Gates

- `xcodebuild test` — green (229 → 241 tests).
- iOS build — clean (Swift 6 main-actor isolation warnings in unrelated files only).
- No web changes; npm test not run for this lane.

## Out of scope (per re-scoped brief)

- **Traveler / payment summary rows + "Different traveler" button.** The original brief envisioned a richer card but neither the web `ItineraryConfirmationCard` nor the orchestrator's `ConfirmationSummary.payload` carries those fields today. Filed as `IOS-CONFIRMATION-RICH-PAYLOAD-1` to land as a small follow-up once Codex extends `ConfirmationSummary` and web's card. Pair with `CHAT-CONFIRMATION-PAYLOAD-EXTEND-1`.
- **Compound `structured-trip` / `structured-reservation` cards.** Round-trip via `.summary(.unsupported(kind:))` today; their iOS counterparts ship in separate lanes when web's parallel cards mature.

## Notes for review

1. **`summariesByMessage` doesn't auto-suppress.** Unlike `suggestionsByTurn` and `selectionsByMessage` (which clear visually once a later user message lands), the summary card stays visible and transitions into a decided-label state. This matches web's `decidedLabel` prop behaviour exactly. The user sent the confirm/cancel turn — the rendered card is the *receipt* of their action while the next assistant turn streams in.

2. **`summaryDecision(for:)` is a pure read-side derivation.** No separate "decided" cache — the user's own message is the source of truth. Cancel-prefix matching (`cancel`/`Cancel — don't book that.`) handles both surfaces' submit strings; affirmatives default to `.confirmed`. If the orchestrator ever introduces a third terminal state, this expands easily.

3. **`BookingConfirmationSubmit.confirmText` / `cancelText` are pinned.** The contract test `test_confirmText_andCancelText_locked` asserts the byte-identical strings to apps/web/app/page.tsx. If web changes either, both surfaces must update together — these hit the orchestrator's `isAffirmative` regex contract (see `node_modules/@lumo/agent-sdk/src/confirmation.ts`).

4. **Confirm-button copy: "Confirm" not "Confirm booking".** First capture pass truncated to "Confirm…" on iPhone width because the times row + offer footer compete for space. Shortened the visible button label to "Confirm" + kept the full `"Confirm booking"` as the `accessibilityLabel` so VoiceOver still announces the longer copy. Web has the screen real estate for the longer label; iPhone doesn't.

5. **Offer footer middle-truncation.** `off_frontier_midmorning` is a 22-character offer_id; the footer line gets `.lineLimit(1) + .truncationMode(.middle)` so it renders as `off_fro…midmorning` rather than wrapping to a second line. Layout priority forces it to give way to the buttons rather than the buttons giving way to it.

6. **DEBUG fixture seam: `LumoSeedBookingConfirmation`.** Fourth such launch-arg fixture (after `LumoStartTab`, `LumoNotificationsFixture`, `LumoSeedChips`, `LumoSeedFlightOffers`) — already covered by the open `DEV-FIXTURE-CONSOLIDATION-1` follow-up.

## Estimate vs actual

Re-scoped brief implied ~similar scope to CHAT-FLIGHT-SELECT-CLICKABLE-1's iOS half. Actual: ~150 LOC iOS models + ~110 LOC iOS service decoder + ~70 LOC iOS view-model + ~205 LOC iOS view + 247 LOC iOS tests + 50 LOC iOS fixture + 12 LOC iOS capture-script variant + 2 PNGs across 5 commits. ~1 medium session.

Ready for review. Merge instructions per the standing FF-merge protocol.
