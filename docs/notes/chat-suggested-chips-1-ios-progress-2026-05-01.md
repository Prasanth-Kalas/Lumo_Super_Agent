# CHAT-SUGGESTED-CHIPS-1-IOS — progress + ready-for-review, 2026-05-01

Branch: `claude-code/chat-suggested-chips-1-ios` (5 commits, branched
from `origin/main` at `dceb9f8`).

Mirrors Codex's CHAT-SUGGESTED-CHIPS-1 (web). The SSE frame and
behavioral contract are owned by Codex; this lane plumbs the same
contract into the iOS chat shell with no protocol changes.

## What shipped

| Δ | Surface | Outcome |
|---|---|---|
| 1 | SSE frame parsing | `ChatService.parseFrame` decodes `assistant_suggestions` frames into a typed `.suggestions(turnID:items:)` ChatEvent. Frames missing `turn_id`, with empty `suggestions`, or with malformed items fall through to `.other(type:)` — defending the view layer from runtime checks. |
| 2 | Per-turn chip cache | `ChatViewModel` gains `suggestionsByTurn: [String: [AssistantSuggestion]]` keyed by `turn_id`, plus an optional `suggestionsTurnId` on `ChatMessage`. Mirrors web's `UIMessage.suggestionsTurnId` + `suggestionsByTurn` shape (apps/web/app/page.tsx). |
| 3 | Stale-suppression rule | `ChatViewModel.suggestions(for:)` only returns chips for the latest assistant message before any user message. Same rule as web's `userMessageExistsAfter(m.id)` — once a user bubble lands after the assistant, the strip vanishes implicitly. No separate clear logic needed. |
| 4 | Chip-tap submit | `sendSuggestion(_:)` mirrors `send()` but takes the chip's `value` directly and adds a user bubble. The chip's `label` is only the chip face — `value` is what gets submitted. |
| 5 | `SuggestionChips` view | Horizontal pill strip in a SwiftUI `ScrollView(.horizontal)`; pills use `LumoColors.surface.opacity(0.7)` background + `LumoColors.separator` border + `LumoColors.labelSecondary` text. Mounted in `ChatView`'s message-list `LazyVStack` directly below the assistant `MessageBubble`, gated by `viewModel.suggestions(for: message).isEmpty`. |

## Web ↔ iOS parity

The SSE contract — `{ type, value: { kind, turn_id, suggestions: [{ id, label, value }] } }` — is unchanged. The same orchestrator that emits the frame for web is the source of truth for iOS. No client-side derivation, no per-platform suggestion logic.

### Behavioural parity

| Behaviour | Web | iOS |
|---|---|---|
| Frame arrives | `assistantSuggestionsToUI(frame.value)` decodes; `suggestionsByTurn[turn_id]` updates; assistant `UIMessage.suggestionsTurnId` set | `attachSuggestions(turnID:items:assistantID:)` decodes; `suggestionsByTurn[turn_id]` updates; assistant `ChatMessage.suggestionsTurnId` set |
| Chip render rule | `m.suggestionsTurnId && !userMessageExistsAfter(m.id).exists` | `viewModel.suggestions(for: message)` |
| Chip-tap submit | `onChipSelect={(value) => void sendText(value)}` | `onSelect: { suggestion in viewModel.sendSuggestion(suggestion.value) }` |
| Clear-on-submit | Implicit via render rule once a user message lands | Implicit via render rule once a user message lands |
| Strip during streaming | `disabled={busy || isReplayLoading}` | `isDisabled: viewModel.isStreaming` |

### Visual

The fixture seeds the canonical date-suggestion chips from `apps/web/lib/chat-suggestions.ts` (Next weekend / In 2 weeks / Memorial Day weekend). Captures live in `docs/notes/chat-suggested-chips-1-ios-screenshots/`:

| State | iOS shot |
|---|---|
| Light | `chips-light.png` — user "Plan a weekend trip to Vegas" → assistant "When are you traveling?" → 3 chips below the LUMO label |
| Dark | `chips-dark.png` — same content, dark surface tokens; chip border + label both pass AA against `LumoBg` dark |

## Tests

**9 new tests** in `apps/ios/LumoTests/SuggestionChipsTests.swift`, three slices that mirror the web `chat-suggested-chips.test.mjs`:

- **Parse contract (4)** — `assistant_suggestions` decodes into `.suggestions(turnID, items)`; missing `turn_id` falls through to `.other`; empty `suggestions` falls through to `.other`; malformed items get filtered out, well-formed ones survive.
- **Render rule (3)** — `suggestions(for:)` returns chips when latest assistant has frame; returns `[]` when a user message follows the assistant; returns `[]` for assistant messages without a `suggestionsTurnId`; returns `[]` for user-role messages.
- **Click + clear (2)** — `sendSuggestion(_:)` appends a user bubble carrying the chip's `value` (NOT label); the appended user bubble flips the previous assistant message's chip strip to empty via the same render rule.

xcodebuild test on iPhone 17 Sim → **all green**. LumoTests bundle: 209 → 218 (+9).

## Gates

- `xcodebuild test` — green (209 → 218 tests).
- iOS build — clean (warnings are pre-existing Swift 6 main-actor isolation notes in unrelated files).
- No web changes; npm test not run for this lane.

## Out of scope (per brief)

- The server contract — owned by Codex's CHAT-SUGGESTED-CHIPS-1. We don't extend the frame, don't add iOS-only suggestion sources, don't second-guess the dedupe / 4-cap rules in `chat-suggestions.ts`.
- History replay — web's history-replay path also reattaches chips to past assistant messages. iOS doesn't have a history-replay UI today (filed as MOBILE-CHAT-2 substrate); when it lands, the same `suggestionsByTurn` cache pre-warms from the replay frames, no separate code path needed.
- Telemetry — chip-tap doesn't fire `lumo.chip.tap` or similar today. Easy to add when the analytics ask comes in (one line in `sendSuggestion`).

## Notes for review

1. **`_seedForTest` is the seam.** Marked `internal func _seedForTest(messages:suggestions:)` on `ChatViewModel`. Used by both `SuggestionChipsTests` and the DEBUG-only `RootView.seedChipsFixture` fixture path. The underscore + parameter shape signal "internal seam, not for production callers". I considered an `#if DEBUG` guard but the function is benign (just two assignments) and keeping it always-internal makes test ergonomics simpler. Open to gating it behind `#if DEBUG` if you'd rather draw a harder line.

2. **Render rule is pure-lookup.** `ChatViewModel.suggestions(for:)` reads `messages` + `suggestionsByTurn` and returns the chip array — it never mutates. The "clear-on-submit" behaviour is *emergent* from the rule + the user bubble landing in `messages`, not a separate clear pathway. This matches web exactly and means there's no race between "stream emits suggestions" and "user taps chip" — the UI just re-renders the rule.

3. **Pill style is web-identical, not Apple HIG.** The chip uses a custom capsule with border + soft surface fill, matching the web SuggestionChips styling rather than SwiftUI's default `Button(.bordered)`. Reasoning: visual parity between web and iOS is the lane's reason for existing — defaulting to system styling here would split the design vocabulary. ThemeContrastTests still passes against the `LumoColors.labelSecondary` over `LumoColors.surface.opacity(0.7)` pair.

4. **Empty `suggestions` array drops at parse time.** The orchestrator already enforces the ≥2 minimum (`if (suggestions.length < 2) return null`), but I drop empty arrays in the parser too — defends the view layer from a malformed/old replay frame producing an empty pill strip.

5. **Strip placement matches web.** The chips sit directly below the assistant `MessageBubble` in the message-list `LazyVStack`, inside a per-message `VStack(alignment: .leading)`. Web sits chips at `pl-[18px]` to align with the LUMO label indent; iOS uses `LumoSpacing.sm` between bubble and strip + the chip's own padding to match the visual rhythm.

6. **Fixture choice.** `RootView.seedChipsFixture` seeds the date-suggestion variant because date is the most common clarification path and exercises the longest chip labels (Memorial Day weekend at 21 chars). This deliberately overflows the visible viewport on iPhone 17 so the horizontal-scroll affordance gets visually exercised in the screenshots.

## Estimate vs actual

Brief implied 1 SwiftUI view + ChatViewModel changes + 3 tests + 2 screenshots; actual ~70 LOC service/parsing + ~50 LOC view-model + 50 LOC SwiftUI view + 25 LOC fixture seed + 184 LOC tests + 2 PNGs across 5 commits. ~1 short session.

Ready for review. Merge instructions per the standing FF-merge protocol.
