# CHIP-A11Y-VOICEOVER-1 — progress + ready-for-review, 2026-05-02

Branch: `claude-code/chip-a11y-voiceover-1` (3 commits, branched from
`origin/main` at the IOS-COMPOSER-AND-DRAWER-SCREENS-1 closeout).

This is **Lane 4 of the renumbered small-lanes queue**. Bundles the
original CHIP-A11Y-VOICEOVER-1 brief with two filed-deferred items
the user elevated to near-term:

- **IOS-DRAWER-EDIT-DETAIL-CAPTURES-1** — capture the 2 missing
  PNGs from Lane 3 (memory-edit + marketplace-detail). Required an
  auto-open seam through RootView state that wasn't in the previous
  lane's value path.
- **IOS-DRAWER-SCREENS-DARK-MODE-1** — capture dark counterparts of
  the 4 drawer screens shipped in Lane 3.

## What shipped

### CHIP-A11Y-VOICEOVER-1 (original brief)

| Δ | Surface | Outcome |
|---|---|---|
| 1 | `SuggestionChips` chip a11y | Hint changed from `"Sends \(suggestion.value)"` (booking-specific copy leaked into VoiceOver) to canonical `"Sends as your reply"`. Added explicit `.accessibilityAddTraits(.isButton)` so VoiceOver announces the chip as a button regardless of how SwiftUI infers traits from the SwiftUI `Button` view. |
| 2 | Composer text-field a11y | Added `.accessibilityLabel(Text("Ask Lumo to book a flight, order dinner, plan a trip. Or pick a suggestion above."))` on the LumoTextField in `ChatView.inputBar`. The default TextField a11y label is just the placeholder, which doesn't tell the user that tapping a chip above is a valid alternative. Also pinned `chat.composer.input` accessibility identifier. |
| 3 | Tests | 6 new tests in `ChipAccessibilityTests` pin the contract symbolically: chip hint copy is canonical, identifiers are stable, composer label signals both paths, chip strip preserves source order for VoiceOver navigation. SwiftUI's accessibility tree isn't directly inspectable from unit tests, so the tests pin the constituent strings + identifiers; the manual VoiceOver smoke verification (focus traversal + announcement) is documented below. |

**Manual VoiceOver verification on iPhone 17 Sim** (turned on
Settings → Accessibility → VoiceOver, swiped through chips +
composer):

- Each chip announces as `"<label>, button. Sends as your reply.
  Double-tap to activate."` ✓
- Composer text field announces as `"Ask Lumo to book a flight,
  order dinner, plan a trip. Or pick a suggestion above. Text
  field."` ✓
- Swipe-right traversal goes chip 1 → chip 2 → chip 3 → composer in
  source order ✓
- Trailing fade overlay (CHIP-OVERFLOW-SCROLL-1) is announced
  silently — `.accessibilityHidden(true)` works ✓

### IOS-DRAWER-EDIT-DETAIL-CAPTURES-1 (bundled)

Auto-open seam through RootView for the 2 missing PNGs:

- New `@State` vars on RootView: `memoryAutoOpenCategory: MemoryCategory?`
  and `marketplaceAutoOpenAgentID: String?`.
- `MemoryView` accepts `autoOpenCategory: Binding<MemoryCategory?>`
  and on first appear, presents the edit sheet for that category +
  clears the binding (one-shot).
- `MarketplaceView` accepts `autoOpenAgentID: Binding<String?>` and
  when the binding matches a loaded agent, renders that agent's
  detail panel **in-place** (rather than auto-pushing through the
  outer NavigationStack) — avoids plumbing a nav-path binding
  through RootView's NavigationStack just for the capture. Real
  navigation still flows through the existing `NavigationLink` in
  `agentList(_:)`.
- Two new launch args wire the seam:
  - `-LumoOpenMemoryEdit <category>` → defaults to `.preferences`
    when the value is missing or unrecognised. Must be paired with
    `-LumoStartDestination memory`.
  - `-LumoOpenMarketplaceDetail <agent_id>` → defaults to
    `lumo-flights` (the seeded fixture's first agent). Must be
    paired with `-LumoStartDestination marketplace`.

### IOS-DRAWER-SCREENS-DARK-MODE-1 (bundled)

Dark counterparts of the 4 light drawer PNGs from Lane 3.
SwiftUI's semantic colours render correctly in dark mode without
any view changes — captures are purely a `simctl ui appearance dark`
swap on the existing fixtures.

## Tests

`xcodebuild test -scheme Lumo -only-testing:LumoTests` →
**326 tests, 0 failures** (was 320 before the lane: +6 in
`ChipAccessibilityTests`).

## Visual gates

8 net-new PNGs under
`docs/notes/chip-a11y-voiceover-1-screenshots/screens/`:

- IOS-DRAWER-SCREENS-DARK-MODE-1: `memory-list-dark`,
  `marketplace-list-dark`, `history-list-dark`, `history-empty-dark`.
- IOS-DRAWER-EDIT-DETAIL-CAPTURES-1: `memory-edit-light`,
  `memory-edit-dark`, `marketplace-detail-light`,
  `marketplace-detail-dark`.

Lane 3's PNGs (4 light drawer + 4 composer light/dark) live in
`docs/notes/ios-composer-and-drawer-screens-1-screenshots/` and are
unchanged.

## Cross-platform coordination

None — iOS-only lane. Web /chat already uses
`SuggestionChips.tsx` with its own a11y attributes; this lane's
hint-copy change ("Sends as your reply") is iOS-canonical and not
imported through `@lumo/shared-types`.

## Out of scope (filed)

- **CHIP-A11Y-DYNAMIC-TYPE-1** (new) — verify chip strip + composer
  scale correctly under Dynamic Type accessibility sizes
  (xxxLarge, AX1–AX5). Not in the brief but surfaced during manual
  VoiceOver smoke; the chip pills get tight at AX3+. Filed deferred.
- **CHIP-A11Y-VOICEOVER-FOCUS-RING-1** (new) — VoiceOver focus
  ring is rendering on the chip's HStack, not the chip's pill
  visual bounds, so the focus rect is slightly larger than the
  pill. Cosmetic only; filed deferred.
