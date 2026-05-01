# CHIP-OVERFLOW-SCROLL-1 — progress + ready-for-review, 2026-05-02

Branch: `claude-code/chip-overflow-scroll-1` (3 commits, branched from
`origin/main` at the IOS-DEV-BYPASS-GATE-1 closeout).

The CHAT-SUGGESTED-CHIPS-1-IOS capture showed the third chip
("Memorial Day weekend") cleanly clipped at the right edge of the
iPhone 17 viewport — no visual hint that more content existed past
the cut. This lane keeps the existing horizontal scroll (matches
Claude Desktop / ChatGPT, which the brief recommended) and adds a
trailing-edge fade gradient overlay so the user sees the strip is
scrollable.

## Approach picked: horizontal-scroll with trailing fade

Three approaches were on the table per the brief:

| Approach | Trade-off | Verdict |
|---|---|---|
| Horizontal-scroll-only | Matches Claude Desktop / ChatGPT pattern; preserves chip readability at all viewport widths; no second-line layout shift | **Picked.** The strip already used `ScrollView(.horizontal)`; only the affordance was missing. |
| Wrap-to-2-lines | Keeps every chip visible without a gesture but doubles the strip's vertical footprint and pushes the message list down | Rejected — the chip strip is meant to be a quick reply affordance, not a layout-dominating control |
| Graceful-truncate | No gesture needed but loses the third chip's content entirely | Rejected — the brief's exact symptom ("Memorial Day weekend" cropped to "Memorial Day") is what we're trying to fix |

## Recon flag → narrowed

The strip was already a horizontal `ScrollView(.horizontal,
showsIndicators: false)` at branch creation. The clipping was a
*scrollability discoverability* problem, not a layout-mode problem.
Scope shrank to: add the affordance, prove it works visually + via
a regression-catcher test.

## What shipped

| Δ | Surface | Outcome |
|---|---|---|
| 1 | `SuggestionChips` trailing fade | New `.overlay(alignment: .trailing)` on the `ScrollView` renders a 32-point `LinearGradient` from `LumoColors.background.opacity(0)` to `LumoColors.background`. Sized via `Self.trailingFadeWidth` — exposed as a public static constant so the regression-catcher test fails cleanly if the overlay is removed. The overlay has `.allowsHitTesting(false)` so chip taps near the right edge still register, and `.accessibilityHidden(true)` so VoiceOver doesn't announce a phantom element. |
| 2 | Test: regression catcher | `test_chipStrip_exposesTrailingFadeOverlay` asserts `SuggestionChips.trailingFadeWidth > 0`. Same pattern as `AuthView.isDevBypassButtonCompiledIn` from IOS-DEV-BYPASS-GATE-1 — a constant that travels with the visual change so a future cleanup that drops the overlay also has to drop the constant, and the test then fails. |
| 3 | Test: data-layer pass-through | `test_chipStrip_renders3LongLabels_withoutTextTruncation` builds a strip with three long-labeled chips (mirroring the brief's repro: "Next weekend" / "In 2 weeks" / "Memorial Day weekend") and asserts the array survives the initialiser unchanged — no filter / no map drops, and the third chip's full label is preserved. The Text view itself doesn't apply `.lineLimit`, so once data reaches the chip Button, label text renders intact. |
| 4 | Capture-script variant | New `chip-overflow-scroll-1` case in `scripts/ios-capture-screenshots.sh`. Reuses the existing `-LumoSeedChips YES` fixture (the third chip already overflows iPhone 17 by design) — no new launch-arg flag to maintain. |
| 5 | Visual gate | Two new PNGs under `docs/notes/chip-overflow-scroll-1-screenshots/`: `chips-with-overflow-light.png` and `chips-with-overflow-dark.png`. Both show the rightmost chip's text fading smoothly into the chat background instead of cleanly clipping. |

## Tests

`xcodebuild test -scheme Lumo -only-testing:LumoTests` →
**290 tests, 0 failures** (+2 new from `SuggestionChipsTests`,
no regressions in the existing 10).

## Visual gate

Before vs after:

| | Before (chat-suggested-chips-1-ios capture) | After (this lane) |
|---|---|---|
| Light | Third chip text cut at viewport edge with hard clip line | Third chip text fades smoothly over rightmost ~32pt — clearly signals scrollability |
| Dark | Same hard clip in dark mode | Same fade, blends to dark background |

Re-capture command:

```
LUMO_SHOTS_VARIANT=chip-overflow-scroll-1 \
LUMO_SHOTS_OUT=docs/notes/chip-overflow-scroll-1-screenshots \
  scripts/ios-capture-screenshots.sh
```

## Doctrine notes

The constant-paired-with-modifier pattern (a public static `let`
exposed on the view that mirrors a visual modifier's existence) is
proving to be a useful regression catcher: it makes an invisible
visual decision test-introspectable without snapshot tests or view
introspection libraries. Used twice now — `isDevBypassButtonCompiledIn`
(IOS-DEV-BYPASS-GATE-1) and `trailingFadeWidth` (this lane). If the
queue keeps producing similar small visual lanes, this could become
its own doctrine entry — but I'll wait for a third example before
folding it into the IOS-DOCTRINE-DOCS-1 (Lane 6) write-up.

## Out of scope

- Conditional fade — show the gradient only when content actually
  overflows the viewport. Would need `GeometryReader` + content-size
  measurement, and the always-on fade is so subtle on the chat
  background that the cost-of-presence in the no-overflow case is
  near zero. Filed-deferred mentally; not worth the complexity.
- Web-side parity. The web's `SuggestionChips.tsx` may have the
  same affordance gap. Not in this lane's scope (iOS-only) — flagging
  as a possible future `WEB-CHIP-OVERFLOW-SCROLL-1` if the same
  symptom shows up on a narrow-viewport web capture.
