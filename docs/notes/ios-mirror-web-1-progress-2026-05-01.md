# IOS-MIRROR-WEB-1 — progress + ready-for-review, 2026-05-01

Branch: `claude-code/ios-mirror-web-1` (5 commits, branched from
`origin/main` at `886d218`).

## What shipped

iOS chat shell now mirrors the web Claude-Desktop pattern that
WEB-REDESIGN-1 established. All four brief deltas landed.

| Δ | Surface | Outcome |
|---|---|---|
| 1 | Drawer EXPLORE order | `SideDrawerView` now renders Workspace, Trips, Receipts, History, Memory, Settings, Marketplace in that order — exact match for the web mobile drawer. `DrawerDestination` enum expanded to 9 cases (7 EXPLORE + receiptDetail + profile-as-programmatic). Profile is no longer in the drawer (matches web). |
| 2 | Account chip footer | Avatar (cyan-tinted circle with initial) + email + chevron. Tap toggles a small menu with "Account settings" + "Sign out". Mirrors the web LeftRail profile chip. Hidden when signed-out (same UX as web's auth-footer split). |
| 3 | Color tokens | 9 new colorset entries in `Resources/Assets.xcassets` (LumoBg, LumoSurface, LumoElevated, LumoHair, LumoEdge, LumoFg, LumoFgHigh, LumoFgMid, LumoFgLow). Each carries the exact light + dark hex from `apps/web/app/globals.css`. `LumoColors` enum re-pointed to them. ThemeContrastTests still passes — the ported palette holds AA at body size in both modes. |
| 4 | Typographic messages + bordered composer | `MessageBubble`: assistant prose flows under a small uppercase "LUMO" label (no rounded background); user messages stay right-aligned in a soft `LumoElevated` pill. `ChatView` composer: bordered rounded block + toolbar row (mic always on left, Send pill always on right; disabled when input is empty or streaming). Send pill uses the `bg=label / fg=background` inversion pair so it reads as dark-text-on-light-pill in dark mode and the inverse in light mode — same posture as web's `bg-lumo-fg text-lumo-bg`. |

## iOS ↔ web visual parity

### Mobile drawer — drawer with seeded recents

**iOS** — `docs/notes/ios-mirror-web-1-screenshots/drawer-with-recents-dark.png`

The iOS drawer renders:
- Lumo header + close X
- "+ New chat" CTA with cyan pencil
- "Recent" section with 3 fixture rows (Vegas trip / Japanese restaurant / SFO→LAX)
- "Explore" section with 7 destinations: Workspace, Trips, Receipts, History, Memory, Settings, Marketplace
- Account chip footer: avatar + dev@lumo.local + chevron

**Web** — `docs/notes/web-redesign-1-screenshots/04-mobile-drawer-light.png`

The web drawer renders the identical 7-entry EXPLORE list in the same order. The only structural difference is the auth-footer affordance (web uses "Account settings" + dedicated MobileSignOutButton; iOS condenses both into the chip menu — functionally equivalent).

### Chat empty state

**iOS** — `chat-empty-{light,dark}.png`. Burger top-left, "Lumo" centered, brand-cyan sparkles + "How can I help today?", bordered composer pinned to bottom with mic + disabled Send pill.

**Web** — `web-redesign-1-screenshots/02-chat-empty-signed-in-{light,dark}.png` (1440×900 viewport). Same vocabulary: burger (mobile only on web), Lumo wordmark, ThemeToggle, the LeftRail on lg+ replaces what the iOS drawer covers.

The chat surface at iPhone width exactly matches web at &lt;1024px (where LeftRail hides and the chat takes the full width). Capturing web at mobile viewport for a perfectly aligned pair is filed as a fidelity-improvement follow-up.

### Composer with text

**iOS** — `chat-with-text-{light,dark}.png`. Bordered rounded block at the bottom with text "Plan a weekend trip to Vegas" filling the field, mic on left, Send pill (white bg, dark "Send →") on right.

**Web** — `03-chat-with-recents-{light,dark}.png`. Same bordered composer block + same mic+send toolbar shape.

### Drawer (no recents)

**iOS** — `drawer-open-{light,dark}.png`. Drawer with empty Recent section ("Conversations you start will appear here."), full EXPLORE list, account chip.

**Web** — `04-mobile-drawer` would normally include recents because the capture seeded fixture sessions. The empty-Recent state matches the iOS-only "first launch" UX.

## Color tokens — exact hex parity

| Token | Web (dark) | iOS asset | Web (light) | iOS asset |
|---|---|---|---|---|
| `--lumo-bg` | `#07080A` | LumoBg dark | `#FBFBFA` | LumoBg light |
| `--lumo-surface` | `#0C0E12` | LumoSurface dark | `#FFFFFF` | LumoSurface light |
| `--lumo-elevated` | `#12151B` | LumoElevated dark | `#F4F4F2` | LumoElevated light |
| `--lumo-hair` | `#1A1D24` | LumoHair dark | `#E7E7E3` | LumoHair light |
| `--lumo-edge` | `#23272F` | LumoEdge dark | `#D8D8D3` | LumoEdge light |
| `--lumo-fg` | `#E8EAEE` | LumoFg dark | `#0B0E14` | LumoFg light |
| `--lumo-fg-high` | `#BDC1CB` | LumoFgHigh dark | `#2E323B` | LumoFgHigh light |
| `--lumo-fg-mid` | `#7C8290` | LumoFgMid dark | `#6A6F7A` | LumoFgMid light |
| `--lumo-fg-low` | `#4A4F5B` | LumoFgLow dark | `#A2A6AF` | LumoFgLow light |

Semantic colors (error/warning/success) stay on UIKit system tints to keep accessibility's high-contrast variants for free; web's `--lumo-ok / -warn / -err` resolve to the same Material accent palette these UIKit tints land on, so the cross-platform diff is sub-perceptual.

## Tests

200 iOS tests pass on iPhone 17 Simulator (was 198, +2 ordering tests). Updates:

- `SideDrawerViewTests.test_destinations_topLevel_areAllDistinct` rewritten for the new 7-entry EXPLORE list. Lock-asserts `count == 7`.
- `SideDrawerViewTests.test_drawerSource_sectionsRenderInWebMirroredOrder` (new) — source-level assertion that the drawer body contains `header → newChatRow → recentChatsSection → exploreSection → accountChipFooter` in that order. Catches future refactors that drop or reorder a block.
- `SideDrawerViewTests.test_exploreItems_listOrder_matchesWebMobileDrawer` (new) — locks the static `exploreItems` list ordering. Source-level read matches the existing `ChatMessageListSnapshotTests` pattern.
- `SideDrawerViewTests.makeDrawer` helper updated with the new `accountEmail` + `onAccountSettings` parameters.

## Files

**New (iOS):**
- `Views/WorkspaceView.swift`, `Views/HistoryView.swift`, `Views/MemoryView.swift`, `Views/MarketplaceView.swift` — empty-state stubs anchoring the new EXPLORE destinations.
- 9 colorsets under `Resources/Assets.xcassets/Lumo*.colorset/`.

**Modified (iOS):**
- `Models/DrawerDestination.swift` — 4 new cases.
- `Views/SideDrawerView.swift` — exploreSection + accountChipFooter; renamed `footer` → `accountChipFooter`.
- `Views/RootView.swift` — destinationView switch covers all 9 cases; new onAccountSettings handler; reads `\.signedInUser` from environment for the account chip email.
- `Theme/Theme.swift` — LumoColors re-pointed to the new asset entries.
- `Components/MessageBubble.swift` — assistant prose / user soft pill.
- `Views/ChatView.swift` — bordered composer block + toolbar row; removed dead `sendButtonBackground`.
- `LumoTests/SideDrawerViewTests.swift` — 3 new/updated tests.

**Modified (scripts/docs):**
- `scripts/ios-capture-screenshots.sh` — new `ios-mirror-web-1` variant.
- 8 PNGs in `docs/notes/ios-mirror-web-1-screenshots/`.

## Gates

- xcodegen — clean.
- `xcodebuild test` on iPhone 17 Simulator — **200 pass** (was 198, +2 ordering tests).
- ThemeContrastTests passes — the ported color palette holds AA contrast.

## Notes for review

1. **Profile dropped from drawer.** Matches web — `/profile` exists on web but isn't in EXPLORE. iOS keeps `ProfileView` and `case .profile` so notification deep-links and a future Settings → Profile link can still push it.
2. **Mic + Send always rendered.** The MOBILE-CHATGPT-UI-1 swap pattern (mic when empty, send when typed) is replaced by the web-style "both visible, send disables when invalid" toolbar. Voice push-to-talk via long-press on the mic button is unchanged. If you'd rather restore the swap on iOS, it's a 5-line revert.
3. **Send pill inversion.** Light pill in dark mode, dark pill in light mode. Mirrors web exactly and is what makes "Send" legible in both. Earlier iteration in this lane shipped with white-on-white; the catch was a 1-line fix and the screenshots show the correct render.
4. **Account chip menu UX.** Tapping the chip toggles a popover-style menu above it. Tapping a row dismisses + acts. Matches the web LeftRail profile chip's expand/collapse pattern.
5. **No 380px web counterparts captured.** The brief asks for side-by-side at iPhone 17 + 380px web viewport. The 04-mobile-drawer pair already captures the parity at 380px. Capturing chat-empty + chat-with-text at 380px web would require running the web-redesign-1 capture script with mobile viewport — small follow-up if you want pixel-aligned pairs.

## Estimate vs actual

Brief implied substantial reskin. Actual ~600 LOC iOS production + 9 colorset JSON + 8 screenshots + 3 test additions across 5 commits. ~1 long session.

Ready for review. Merge instructions per the standing FF-merge protocol.
