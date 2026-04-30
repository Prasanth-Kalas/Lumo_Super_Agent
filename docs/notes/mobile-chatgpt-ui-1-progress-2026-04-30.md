# MOBILE-CHATGPT-UI-1 — progress + ready-for-review, 2026-04-30

Branch: `claude-code/mobile-chatgpt-ui-1` (8 commits, branched from
`origin/main` at `c1ffb32`).

## What shipped

All 10 deliverables from the brief.

| # | Deliverable | Outcome |
|---|---|---|
| 1 | Drop TabView in RootView; root = NavigationStack hosting ChatView | Done. `RootView.swift` rewritten; chat root pinned to `path: $path`. |
| 2 | `BurgerMenuButton` toolbar leading item | Done. `Components/BurgerMenuButton.swift` (24 lines). |
| 3 | `SideDrawerView` slide-in left, ~80% iPhone / 320pt iPad, backdrop + spring | Done. `Views/SideDrawerView.swift` (200+ lines). `LumoAnimation.smooth` spring. |
| 4 | Drawer rows: New Chat, Recent Chats, Trips, Receipts, Profile, Settings, Sign Out | Done. Sign-out gated by `signedIn` input — defense-in-depth so signed-out fixtures can't trigger logout. |
| 5 | `ChatView` promoted from tab into the root surface | Done. ChatView's body unchanged; `RootView` now wraps it with `ProactiveMomentsView` above the composer (same layout the prior `ChatTab` had). |
| 6 | Notification action routing through new arch | Done. Extracted to a pure `NotificationRouteResolver` so the deep-link semantics are unit-testable. `RootView.handleNotificationRoute` now appends destinations onto the NavigationStack instead of switching tabs. |
| 7 | Proactive moments cards stay above composer | Done. Moved from the deleted `ChatTab` into `RootView.chatRoot`; layout identical. |
| 8 | Auth gate preserved in `AppRootView` | Untouched — `RootView` interior is the only thing that changed. |
| 9 | Visual polish — sparkles glyph + "How can I help today?" | Done. Empty state in `ChatView`: brand-cyan sparkles at 48pt light + single-line prompt. |
| 10 | Tests + screenshots + acceptance gates | Done. 38 new tests across 4 bundles; 8 light+dark screenshots. xcodebuild test green on iPhone 17 sim. |

## Architecture overview

```
AppRootView (auth gate; unchanged)
└─ RootView (signed-in shell — rewritten)
   ├─ NavigationStack(path: $path)
   │  ├─ chatRoot
   │  │  ├─ ProactiveMomentsView (cards above composer)
   │  │  └─ ChatView (composer at bottom via safeAreaInset)
   │  │     • Toolbar leading: BurgerMenuButton
   │  └─ navigationDestination(for: DrawerDestination.self)
   │     ├─ .trips           → TripsView
   │     ├─ .receipts        → ReceiptHistoryView
   │     ├─ .receiptDetail   → ReceiptDetailLookupView (resolves id → Receipt)
   │     ├─ .profile         → ProfileView
   │     └─ .settings        → SettingsView (renamed from SettingsTab; body unchanged)
   ├─ SideDrawerView overlay (slide-in)
   │  • New Chat → chatViewModel.reset() + clear path
   │  • Recent Chats list (RecentChatsStore, UserDefaults-backed)
   │  • Top-level destinations
   │  • Sign Out (confirmation dialog, clears recents on confirm)
   └─ confirmationDialog: "Sign out of Lumo?"
```

## State ownership

- `chatViewModel` + `voiceComposer` + `proactiveViewModel` hoisted from
  `ChatView` to `RootView` so the drawer's "New Chat" can call `reset()`
  and notification deep-links can mutate `input` without re-creating
  the view tree. `ChatView`'s test-only init is now its only init —
  the previous default that built its own VM is unused (`RootView` is
  the only caller).
- `RecentChatsStore` is `@MainActor`-owned by `RootView`; persists via
  `UserDefaults` with a 30-entry cap. `signOut` flow calls `clear()`.
- `path: NavigationPath` lives on `RootView`. Notification routes and
  drawer rows both append into it.

## File summary

**New (10):**
- `Components/BurgerMenuButton.swift`
- `Models/DrawerDestination.swift`
- `Models/NotificationRouteResolver.swift`
- `Services/ProfileSettings.swift`
- `Services/RecentChatsStore.swift`
- `Views/SideDrawerView.swift`
- `Views/ProfileView.swift`
- `Views/ReceiptDetailLookupView.swift`
- `LumoTests/SideDrawerViewTests.swift`
- `LumoTests/BurgerMenuToggleTests.swift`
- `LumoTests/ChatRootViewTests.swift`
- `LumoTests/ProfileSettingsTests.swift`

**Renamed:**
- `Views/Tabs/SettingsTab.swift` → `Views/SettingsView.swift` (struct renamed; body unchanged)
- `Views/Tabs/TripsTab.swift` → `Views/TripsView.swift` (struct renamed; body unchanged)

**Deleted:**
- `Views/Tabs/ChatTab.swift` — content inlined into `RootView.chatRoot`.

**Modified:**
- `Views/RootView.swift` — full rewrite (TabView → NavigationStack + drawer overlay).
- `Views/ChatView.swift` — empty-state copy, `chat.send` accessibility identifier, init comment updated.
- `Views/NotificationsFixtureRoot.swift` — `SettingsTab` → `SettingsView` reference.
- `ViewModels/ChatViewModel.swift` — `reset()` method added.
- `ViewModels/VoiceComposerViewModel.swift` — comment update.
- `scripts/ios-capture-screenshots.sh` — `chatgpt-ui` variant (4 states × 2 themes = 8 shots).
- `STATUS.md`.

## Tests

**184 tests pass** on iPhone 17 Simulator (xcodebuild test):

- 146 prior tests untouched.
- 38 new across 4 bundles:

| Bundle | Tests | Coverage |
|---|---|---|
| `SideDrawerViewTests` | 11 | RecentChatsStore upsert/dedupe/cap/clear/persistence + DrawerDestination hashable identity (receiptDetail with different ids treated as distinct) + sign-out gate input contract |
| `BurgerMenuToggleTests` | 4 | Construction smoke + Binding<Bool> propagation through close/toggle/destination-select handlers |
| `ChatRootViewTests` | 12 | ChatViewModel.reset() drops all state + every NotificationRouteResolver mapping + canSend predicate (whitespace-only rejected, streaming rejected) |
| `ProfileSettingsTests` | 11 | UserDefaults round-trip for displayName/cabinClass/seatPreference + unknown-raw-value fallback + clear-on-empty |

SwiftUI Button taps aren't directly invokable from XCTest (no
ViewInspector / no XCUITest in this repo), so the drawer / burger
suites cover the underlying contract — bindings, callbacks, data
sources — rather than the rendered tap path. The ChatRootView suite
got a leg up from extracting `NotificationRouteResolver` as a pure
mapping; that resolver is now what powers the deep-link semantics in
both production and tests.

## Notification routing — new mapping

| Route | Old (tab) | New (NavigationStack) |
|---|---|---|
| `.openTrips` | `selection = .trips` | `path = [.trips]` |
| `.openReceiptID(id?)` | `selection = .settings` | `path = [.receipts, .receiptDetail(id)]` (or just `[.receipts]` if id nil/empty) |
| `.openChatWithPrefill(s)` | `selection = .chat` | `path = []`; `chatViewModel.input = s` |
| `.openAlertsCenter` | (no-op) | `path = [.settings]` (no dedicated alerts surface; settings owns notif prefs) |
| `.dismissed` / `.snoozedAcknowledged` | no-op | no-op |

## Visual gates

8 PNGs captured at `docs/notes/mobile-chatgpt-ui-1-screenshots/`:
- `18-chat-empty-{light,dark}.png` — sparkles + "How can I help today?" + Ask Lumo… composer with mic.
- `19-composer-with-text-{light,dark}.png` — composer pre-filled, mic swapped to cyan paperplane send button.
- `20-drawer-open-{light,dark}.png` — drawer over empty chat, no recents.
- `21-drawer-with-recents-{light,dark}.png` — drawer with three seeded recents (Vegas trip / Japanese restaurant / SFO→LAX rebook), four destination rows, red Sign out footer.

DEBUG launch args added to `RootView` to drive these:
- `-LumoAutoSignIn YES` — bypasses auth (existing).
- `-LumoStartChatInput "..."` — pre-fills the chat composer.
- `-LumoStartDrawerOpen YES` — opens the drawer on cold launch.
- `-LumoSeedRecents YES` — seeds three deterministic recent-chat rows.
- `-LumoStartDestination {trips|receipts|profile|settings}` — pushes
  that destination on cold launch (replaces the old `-LumoStartTab`
  arg that's no longer applicable).

## CI compatibility

`.github/workflows/ios-build.yml` runs `xcodegen generate` then
`xcodebuild test -destination 'platform=iOS Simulator,name=iPhone 17'`.
Local run on the same destination passes (184 tests). xcodegen handles
the new file additions automatically (the project.yml uses `path: Lumo`
so all .swift files under that directory are picked up — no project.yml
edit needed).

## Notes for review

1. **Old screenshot variants still reference `-LumoStartTab`.** The
   `default`, `voice`, `payments`, `notifications` variants in
   `scripts/ios-capture-screenshots.sh` use `-LumoStartTab settings`.
   Those launch args no longer have an effect (tabs are gone), but
   the screenshots still capture the right state because the relevant
   fixtures (e.g., `-LumoNotificationsFixture permission-prompt`) drive
   the screen directly through `NotificationsFixtureRoot`. If you want
   me to migrate those variants to `-LumoStartDestination`, that's a
   small follow-up commit.
2. **`/settings/voice` swap to drawer Sign Out.** The renamed
   `SettingsView` still has its own internal Sign Out button (was on
   the prior tab). The drawer also has Sign Out. Both work and route
   to the same handler. Two entry points to the same destructive
   action might warrant a follow-up to remove one — recommend keeping
   the drawer's footer as the canonical and dropping the inline
   Settings → Account → Sign out button to reduce duplication. Filed
   as `MOBILE-SETTINGS-DEDUP-1`.
3. **`AppRootView` injects `signedInUser` environment on the prior
   `RootView` selection only.** The new `RootView` doesn't pass it
   through into pushed destinations. `SettingsView` reads
   `\.signedInUser` from environment so it still works (environment
   inherits down the stack). Verified by running through the drawer
   → Settings flow on the simulator and checking the Account section
   renders the email/name correctly.
4. **Backdrop tap dismiss + tap-outside.** Drawer dismisses via three
   paths: backdrop tap, X-button tap (drawer header), and any drawer
   row's `close()` after invoking its callback. Tested via
   `BurgerMenuToggleTests` against the binding contract.
5. **Sign-out clears `RecentChatsStore`.** A fresh sign-in won't see
   the prior account's recents (covered by the `clear()` call in the
   confirmation dialog's destructive button).

## Estimate vs actual

Brief implied a substantive refactor; actual ~700 LOC production code
+ ~480 LOC tests + 8 screenshot PNGs across 8 commits. ~1 long session
of work, mostly unblocked execution after the recon phase.

Ready for review. Merge instructions per the standing FF-merge protocol.
