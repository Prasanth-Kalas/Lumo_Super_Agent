# IOS-CONFIRMATION-RICH-PAYLOAD-1 — progress + ready-for-review, 2026-05-01

Branch: `claude-code/ios-confirmation-rich-payload-1` (5 commits,
branched from `origin/main` at `fbc0c11`).

Mirrors web's `CHAT-CONFIRMATION-PAYLOAD-EXTEND-1` extension on the
iOS `BookingConfirmationCard`. Adds the visible side of Codex's
server-side payload extension: traveler row, payment row, "Prefilled
from approved profile" subheader, missing-fields per-input form,
Different-traveler footer button.

## What shipped

| Δ | Surface | Outcome |
|---|---|---|
| 1 | Wire-shape extension | `ItineraryPayload` grows four optional trailing fields — `traveler_summary: String?`, `payment_summary: String?`, `prefilled: Bool`, `missing_fields: [String]` — mirroring web's TypeScript shape exactly. A custom initializer defaults all four to nil/false/empty so older callers (tests + DEBUG fixture) keep working unchanged. New `hasAutofillBlock` convenience matches web's gate (any of traveler/payment/missing present). |
| 2 | Decoder | `ChatService.decodeItineraryPayload` reads the new fields tolerantly: `null` and missing decode identically to nil; empty-string traveler/payment also collapse to nil so the autofill block suppresses cleanly when the orchestrator emits an empty descriptor; `missing_fields` strings are trimmed + deduped while preserving order, mirroring web's `normalizeMissingFields` helper. Older summaries without the trailing fields decode the same as before. |
| 3 | Submit-string contract | `BookingConfirmationSubmit` grows four byte-identical strings/helpers locked by tests: `differentTravelerText` (`"Use a different traveler"` — no period, matching `apps/web/app/page.tsx onDifferentTraveler` exactly); `missingFieldsText(entries)` builds web's `submitMissingFields` semicolon-joined format verbatim; `missingFieldLabel` / `missingFieldPlaceholder` mirror web's per-field maps; `travelerInitial` extracts the first uppercased character with `"P"` fallback. |
| 4 | Autofill block | New section between header and slices, render-gated by `payload.hasAutofillBlock`. Renders: `"PREFILLED FROM APPROVED PROFILE"` subheader (only when `prefilled`), traveler row (initial-letter marker chip + `TRAVELER` caption + `traveler_summary`), payment row (`CARD` marker + `PAYMENT` caption + `payment_summary`), missing-fields form (per-field `TextField` + `Send details` button). Single-column form on iPhone (web's `sm:grid-cols-2` two-column form would crowd the iPhone width). |
| 5 | Different-traveler button | Render-gated by the `onDifferentTraveler` closure being non-nil + `decision == nil`. Stacks BELOW Confirm/Cancel rather than alongside them (iPhone footer can't host offer_id + 3 buttons on a single row). Same submit string web uses, so the orchestrator's intent classifier sees identical confirm/cancel/different-traveler turns from both surfaces. |
| 6 | Wiring | `ChatView` passes both new closures (`onDifferentTraveler`, `onMissingFieldsSubmit`) through `ChatViewModel.sendSuggestion` — same entry point chips and flight-row taps use, so all five booking turn types (confirm / cancel / different-traveler / missing-fields / chip) produce indistinguishable user turns from the orchestrator's perspective. |

## Web ↔ iOS parity

The wire shape is byte-identical. The submit strings are pinned by
contract tests on each side.

| Field | Web type | iOS type |
|---|---|---|
| `traveler_summary` | `string \| null \| undefined` | `String?` |
| `payment_summary` | `string \| null \| undefined` | `String?` |
| `prefilled` | `boolean \| undefined` | `Bool` (defaults false) |
| `missing_fields` | `string[] \| undefined` | `[String]` (defaults []) |

| Behaviour | Web | iOS |
|---|---|---|
| Autofill block render gate | `payload.traveler_summary \|\| payload.payment_summary \|\| missingFields.length > 0` | `payload.hasAutofillBlock` (same predicate) |
| Prefilled subheader | `payload.prefilled` true | `payload.prefilled` true |
| Traveler row marker | `value.trim().charAt(0).toUpperCase() \|\| "P"` | `BookingConfirmationSubmit.travelerInitial(value)` (same fallback) |
| Payment row marker | `"CARD"` literal | `"CARD"` literal |
| Missing-fields form layout | `grid sm:grid-cols-2` (2-col on ≥640px) | single-column on iPhone width |
| Different traveler position | inline before Cancel + Confirm | stacked below Cancel + Confirm (iPhone footer width) |
| Different traveler submit | `"Use a different traveler"` | `"Use a different traveler"` (locked) |
| Missing-fields submit | `"Here are the missing booking details: <Label>: <value>; …"` | same (locked) |

## Visual

| State | iOS shot |
|---|---|
| Light | `confirmation-card-prefilled-light.png` — user "Yes, the Frontier 9:30 nonstop." → assistant "Here's the final price — tap Confirm to book." → confirmation card with header, "PREFILLED FROM APPROVED PROFILE" subheader, traveler row (P marker + Prasanth Kalas · prasanth.kalas@lumo.rentals), payment row (CARD marker + Visa ending in 4242), F9 segment row, footer (offer_id middle-truncated + Cancel + Confirm pill + Different traveler text below) |
| Dark | `confirmation-card-prefilled-dark.png` — same content, dark surface tokens; Confirm pill inverts to `LumoColors.label` background with `LumoColors.background` text; ThemeContrastTests still green for traveler/payment row text against the surface |

iPhone 17 simulator. Both shots in `docs/notes/ios-confirmation-rich-payload-1-screenshots/`.

## Tests

**13 new tests** appended to `apps/ios/LumoTests/BookingConfirmationCardTests.swift`:

- **Parse contract (4)** — all four trailing fields decode; older summaries without the trailing fields stay backwards-compatible (nil/false/[]); `missing_fields` are deduped + trimmed; empty-string traveler/payment collapse to nil.
- **Submit-string contracts (2)** — `differentTravelerText` pinned; `missingFieldsText` builds the exact semicolon-joined format web emits.
- **Builder edge cases (2)** — empty values drop; nil when nothing's filled.
- **Helper parity (2)** — `missingFieldLabel` maps the four web overrides + title-cases unknowns; `travelerInitial` extracts first uppercased letter with "P" fallback.
- **Render rule (1)** — `hasAutofillBlock` gates true on any of traveler/payment/missing-fields present.
- **Submit cascade (1)** — `sendSuggestion(differentTravelerText)` appends a user bubble with the no-period exact string, asserts no trailing period.

xcodebuild test on iPhone 17 Sim → **all green**. LumoTests bundle 234 → 247 (+13).

## Gates

- `xcodebuild test` — green (234 → 247 tests).
- iOS build — clean.
- No web changes; npm test not run for this lane.

## Notes for review

1. **Backwards-compatible decoder.** Older `summary` frames without the four trailing fields decode identically to before — `traveler_summary`/`payment_summary` are nil, `prefilled` is false, `missing_fields` is `[]`. The card's autofill block then suppresses (via `hasAutofillBlock`) so the visible UX matches the pre-CHAT-CONFIRMATION-PAYLOAD-EXTEND-1 card. Locked by `test_parseFrame_summary_itinerary_richFieldsOmitted_backwardsCompat`.

2. **Empty-string normalization.** Web treats `null` and missing identically; iOS *additionally* collapses empty-string `""` traveler/payment into nil. Reasoning: an orchestrator that emitted `""` for a missing scope would otherwise render a spurious "TRAVELER\n" row with no value. Tests cover this via `test_parseFrame_summary_itinerary_emptyStringTraveler_decodesAsNil`.

3. **Different-traveler placement diverges from web on iPhone.** Web hosts all three buttons (Different traveler / Cancel / Confirm) on one row at desktop width. iPhone 17 width can't accommodate that plus the offer_id text in the same row, so iOS stacks the Different-traveler affordance below Cancel/Confirm. Same button + same submit string + same enable-disable rules — purely a layout adaptation. The progress doc's "Different traveler position" row in the parity table makes this explicit.

4. **Missing-fields form is single-column on iPhone.** Web uses `grid sm:grid-cols-2` (two columns on ≥640px). iPhone 17 width sits below that breakpoint, so iOS renders single-column. SwiftUI doesn't have a clean "two-column on regular size class, single on compact" idiom for an arbitrary-length missing-fields list, and the typical missing-fields count is 1–2 anyway, so single-column doesn't lose content.

5. **`onDifferentTraveler` and `onMissingFieldsSubmit` are optional callbacks.** Their nil-default mirrors web's prop semantics: when the parent doesn't wire a handler, the corresponding affordance hides. ChatView wires both today, so production users see both. A future surface (e.g. read-only history view) could leave them nil.

6. **`hasAutofillBlock` convenience.** Pulled onto the model rather than computed inline in the SwiftUI view because the same gate is queried twice — once to skip the block + its trailing divider, once for the screenshot test seam. Pure; no allocation.

## Estimate vs actual

Brief implied a small extension to the existing card. Actual: ~50 LOC model extension (new fields + initializer + helpers) + ~70 LOC decoder + 13 LOC submit-string helpers + ~120 LOC SwiftUI extension (autofill block + missing-fields form + Different-traveler stack) + ~12 LOC ChatView wiring + ~190 LOC tests + 2 PNGs + 12-line capture-script variant + 6 LOC fixture-seed extension across 5 commits. ~1 short session.

Ready for review. Merge instructions per the standing FF-merge protocol.
