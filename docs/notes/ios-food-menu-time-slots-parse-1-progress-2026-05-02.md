# IOS-FOOD-MENU-TIME-SLOTS-PARSE-1 — progress + ready-for-review, 2026-05-02

Branch: `claude-code/ios-food-menu-time-slots-parse-1` (3 commits,
branched from `origin/main` at the CHIP-A11Y-VOICEOVER-1 closeout).

Lane 5 of 7 in the renumbered small-lanes queue. **Parser-only
lane** — replaces the `.unsupported(kind:)` stubs in
`ChatService.parseFrame` for `food_menu` and `time_slots` selection
frames with typed payload models. SwiftUI cards land when web's
parallel lanes ship (IOS-SELECT-CLICKABLE-FOOD-1 /
IOS-SELECT-CLICKABLE-RESTAURANT-1).

## What shipped

### New typed payloads

`apps/ios/Lumo/Models/Selection.swift`:

| Model | Mirrors web | Source |
|---|---|---|
| `FoodMenuPayload` + `FoodMenuItem` | `FoodMenuSelection` from `apps/web/components/FoodMenuSelectCard.tsx` | `food_get_restaurant_menu` tool result |
| `TimeSlotsPayload` + `TimeSlotOption` | `TimeSlotsSelection` from `apps/web/components/TimeSlotsSelectCard.tsx` | `restaurant_check_availability` tool result |

Wire field names preserved exactly (`menu`, `slots`, `unit_price_cents`,
`starts_at`, `deposit_amount`, etc) so JSON decode is straight-through
with no field aliasing.

### New enum case: `.malformed(kind:reason:)`

`InteractiveSelection` grows from 2 cases to 5:

```swift
enum InteractiveSelection: Equatable {
    case flightOffers(FlightOffersPayload)
    case foodMenu(FoodMenuPayload)
    case timeSlots(TimeSlotsPayload)
    case unsupported(kind: String)
    case malformed(kind: String, reason: String)  // new
}
```

The `.malformed` case is the brief's key contract change. It
distinguishes:

| Case | Meaning |
|---|---|
| `.unsupported(kind:)` | Known frame envelope, kind we don't handle yet. Forward-compat for whatever web ships next. |
| `.malformed(kind:reason:)` | Known kind, payload failed decoding. Distinct from `.unsupported` so callers can log the decode failure separately. |

The distinction matters for log routing: `.unsupported` = "upgrade
iOS to catch up to web"; `.malformed` = "bug somewhere on the wire,
investigate". Same kind-string both ways, but the action is
different.

`sameKind(as:)` extends to dedupe across all 5 cases — `.malformed`
dedupes by kind ignoring reason (so latest re-emit replaces).

### Parser changes

`ChatService.parseFrame` selection case rewritten:

- `flight_offers` (existing) — empty offers array now produces
  `.malformed("flight_offers", "...")` instead of falling all the
  way through to `.other(type:)`. Preserves the kind context.
- `food_menu` (new) — decodes via `decodeFoodMenuPayload` (tolerant
  of missing item rows; drops items missing `item_id`/`name`/
  `unit_price_cents`).
- `time_slots` (new) — decodes via `decodeTimeSlotsPayload`
  (tolerant of missing slot rows; drops slots missing `slot_id`/
  `starts_at`/`party_size`).
- Unknown kinds (default branch) — still `.unsupported(kind:)`.

The two new decoders match `decodeFlightOffersPayload`'s style:
required-field guards on the envelope, `compactMap` over the array
fields to drop bad rows rather than fail the whole payload (matches
web's `payload.menu ?? []` / `payload.slots ?? []` posture).

## Tests

`xcodebuild test -scheme Lumo -only-testing:LumoTests` →
**335 tests, 0 failures** (was 326 before the lane: +9 in
`FoodMenuTimeSlotsParseTests`, 2 existing
`FlightOffersSelectCardTests` updated to align with the new
`.malformed` contract).

`FoodMenuTimeSlotsParseTests` covers four slices:

1. **food_menu parse** — full payload decodes typed; malformed
   items drop while well-formed survives; empty menu decodes
   successfully (distinct from missing).
2. **time_slots parse** — full payload decodes typed; malformed
   slots drop while well-formed survives.
3. **Malformed payload → `.malformed(kind:reason:)`** — missing
   required envelope fields (food_menu without restaurant_name,
   time_slots without slots array) produce `.malformed` with the
   kind preserved.
4. **Backwards-compat** — unknown future kinds still round-trip via
   `.unsupported(kind:)`. `sameKind(as:)` dedupes correctly across
   all 5 enum cases.

The 2 updated `FlightOffersSelectCardTests`:

- `test_parseFrame_selection_unknownKind_passesThroughAsUnsupported`
  — was using `food_menu` as the "unknown kind"; updated to
  `future_kind_we_dont_know`.
- `test_parseFrame_selection_flightOffers_emptyOffers_fallsThrough`
  → renamed to `_isMalformed` and updated to expect `.malformed`
  rather than `.other(type:)`.

## Visual gates

None — parser-only lane.

## Cross-platform coordination

None — iOS-only lane. Web's `FoodMenuSelectCard` /
`TimeSlotsSelectCard` are unchanged. The wire schema (web's
`InteractiveSelection.payload`) is `unknown` on the web side too;
this lane just gives iOS a typed view into the same JSON.

## Out of scope (filed)

- **IOS-SELECT-CLICKABLE-FOOD-1** — SwiftUI `FoodMenuSelectCard`
  view + ChatView mount + capture variant. Lands when web ships
  the canonical interaction model.
- **IOS-SELECT-CLICKABLE-RESTAURANT-1** — same for `TimeSlotsSelectCard`.

Both are blocked on the web counterparts settling — per the
chips/leg-detail pattern (web is canonical for selection cards),
we wait for web to ship its iOS-targeted interaction tweaks before
porting. The parser layer landing now means there's no contract
work blocking the view work when those briefs fire.
