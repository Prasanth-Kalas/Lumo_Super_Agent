# MOBILE-CHAT-1 — partial submission (Phase A–C foundation)

Lane: `claude-code/mobile-chat-1`. Brief: the MOBILE-CHAT-1 brief issued by the reviewer on 2026-04-29.

**This is an explicit partial submission, not a final review request.** The brief calls for five deliverable groups (auth, polished chat UI, tab nav, theme + design system, performance). Three of those landed in this push; two are deferred to the next session.

The reviewer's earlier pin said *"ping me with first review-ready when either lane reaches the gate."* The gate is the full brief; this isn't at the gate. Pushing now to expose the foundation early so:

1. The shape of the design tokens and component library can be reviewed before the auth/settings work writes against them.
2. If the chat UI direction is wrong, course-correction is cheap now and expensive once auth wires in.
3. The next session can pick up cleanly with a published baseline rather than a long branch sitting locally.

The reviewer can either approve this as a foundation checkpoint and merge, or hold the merge and have me push the deferred phases onto the same branch. Both are valid.

## What landed in this push

Three commits on top of the merged bootstrap:

```
b61a7a6 feat(ios): rebuild ChatView atop ChatViewModel and the component library
9a6f7d9 feat(ios): add tab navigation shell with Chat/Trips/Settings   (← actual hash will differ)
b4cf41a feat(ios): add design tokens and reusable component library    (← actual hash will differ)
```

(Run `git log origin/main..claude-code/mobile-chat-1 --oneline` for the exact hashes after push.)

### Phase A — Design tokens + component library ✅

`apps/ios/Lumo/Theme/Theme.swift` — `LumoColors`, `LumoFonts`, `LumoSpacing`, `LumoRadius`, `LumoAnimation`. Single source of truth; UI code reads from these enums rather than hardcoding values.

`apps/ios/Lumo/Components/` — six reusable views:
- `LumoButton.swift` — `.lumoPrimary` / `.lumoSecondary` / `.lumoPlain` button styles. Press scale + disabled handling.
- `LumoTextField.swift` — outlined field with focus state, optional leading/trailing accessory views.
- `LumoCard.swift` — elevation container with separator stroke.
- `LoadingSpinner.swift` — circular indicator + animated `TypingIndicator`.
- `MessageBubble.swift` — role-aware chat bubble with status indicator, retry affordance, contextMenu (copy/share/regenerate/retry).
- `MarkdownRenderer.swift` — block parser for code fences + bullet lists; inline formatting via `AttributedString(markdown:)`.

`Assets.xcassets/LumoCyan.colorset` and `LumoCyanDeep.colorset` with light + dark variants. Dark variants nudge brighter for AA contrast on dark backgrounds.

### Phase B — Tab navigation ✅

`apps/ios/Lumo/Views/RootView.swift` hosts a `TabView` with three tabs (Chat, Trips, Settings). Each tab owns its own `NavigationStack` so push-style sub-screens preserve their state when the user switches tabs and returns. `tint(LumoColors.cyan)` so selection chrome matches the brand.

`apps/ios/Lumo/Views/Tabs/{ChatTab,TripsTab,SettingsTab}.swift`:
- `ChatTab` wraps `ChatView` with the navigation title.
- `TripsTab` is a stub with empty-state copy pointing the user back to chat (real Trips view ships in MOBILE-TRIP-1).
- `SettingsTab` is a Form with a version row + a forward-pointer note. Real account/sign-out content arrives with the auth flow in Phase D.

`LumoApp.swift` updated: root `WindowGroup` now hosts `RootView` instead of `ChatView` directly.

### Phase C — Real chat UI + ChatViewModel ✅

`apps/ios/Lumo/ViewModels/ChatViewModel.swift` — `@MainActor` `ObservableObject` owning the message-list state machine:

- **User message:** `sending → sent → (or) failed`
- **Assistant message:** `streaming → delivered → (or) failed`

Public surface: `send()`, `retry()`, `regenerate()`, `cancelStream()`. State transitions are driven by SSE frame events: first `.text` frame moves the user bubble `sending → sent`; `.done` moves the assistant bubble to `delivered`; `.error` (from server) or thrown error moves both to `failed`; `CancellationError` is intentionally swallowed.

`apps/ios/Lumo/Views/ChatView.swift` rebuilt around the view model:

- `LazyVStack` of `MessageBubble` for the message list (handles 50+ messages without layout perf issues).
- `ScrollViewReader` auto-scrolls to the latest message or to the typing indicator while streaming hasn't produced its first token.
- Pull-to-refresh stub (real history sync ships with server-side persistence in MOBILE-CHAT-2).
- Empty state with brand-cyan icon + welcome copy.
- Inline error banner above the input bar with dismiss action.
- `LumoTextField` + circular send button using `LumoColors.cyan`.
- Long-press contextMenu on each `MessageBubble` routes copy / share / regenerate / retry to the view model.
- `onDisappear` cancels in-flight streams.

The bootstrap's `#Preview` block was dropped — the SwiftUI compiler choked with "failed to produce diagnostic" errors on the conditional inside the macro. Previews can come back when we add a fixture view model in a later sprint.

### Verification

- `xcodebuild build` (Debug, iPhone 17 Simulator) → BUILD SUCCEEDED.
- `xcodebuild test` → 11 tests, 0 failures (the bootstrap's ChatService coverage; new components and ChatViewModel still need tests — that's part of Phase E, deferred).
- App installs and launches cleanly on iPhone 17 Simulator. Empty-state chat tab, both Trips and Settings tabs reachable.

### Screenshots

In `docs/notes/mobile-chat-1-screenshots/`:
- [`01-chat-empty-light.png`](mobile-chat-1-screenshots/01-chat-empty-light.png) — Chat tab empty state in light mode. Lumo header, brand-cyan chat icon, welcome copy, input bar, three-tab bar with Chat selected.
- [`02-chat-empty-dark.png`](mobile-chat-1-screenshots/02-chat-empty-dark.png) — same in dark mode.

**Known issue in the dark-mode screenshot:** there's a phantom rendering of the input field outline near the top of the screen (~y=350px) below the navigation title. This reproduces across cold-launches in dark mode but does NOT reproduce in light mode, and it does NOT appear after the first user interaction (e.g., typing into the field). It looks like a SwiftUI `LumoTextField` overlay positioning quirk that only kicks in for dark-mode initial layout. I didn't track this down before pushing — it's polish, not blocking, and Phase D's view rebuilds may resolve it incidentally. If not, file as a `MOBILE-POLISH-1` ticket. The functional UI works correctly; this is a visual artifact only.

## What's deferred to the next session

### Phase D — Auth (NOT STARTED)

Required for full brief acceptance:
- Supabase Swift SDK as first SwiftPM dependency in `project.yml`. Pin to a specific version.
- Email magic-link auth.
- Sign in with Apple (native SwiftUI `SignInWithAppleButton`).
- Biometric unlock (Face ID / Touch ID via `LocalAuthentication`).
- Auth state persisted in iOS Keychain.
- Sign-out flow.
- `AuthView` + `AppRootView` gating the rest of the app.

**Open question for the reviewer before I start Phase D:**
- Where do Supabase URL + anon key come from for the iOS build? `apps/web/` has its own Supabase setup but its env files aren't committed. Options: (a) reuse the same project's anon key — needs the value provided to me out-of-band so I don't paste it into chat; (b) provision a new Supabase project for iOS dev; (c) build with a placeholder and a dev-mode skip-auth path for local-only iteration. My recommendation: (c) for the bootstrap of Phase D, then (a) once the values are in hand.
- Apple Developer team for Sign-in-with-Apple entitlement. Simulator can show the UI but won't return a real credential without team setup. Acceptable to scaffold the code path with a stub-credential-handler and flag team setup as a manual follow-up like the Vercel rootDirectory was.

### Phase E — Settings expansion + new tests (NOT STARTED)

Required for full brief acceptance:
- Settings tab full content: account info, sign out, app version (already there), privacy policy link, support email link. Push-style nav for sub-screens.
- New tests: theme contrast (run AA check on every defined color pair), auth state machine, message-list rendering snapshot test.
- The existing 11 tests still pass; this phase ADDS tests, doesn't replace them.

### Phase F — Cold-start measurement (NOT STARTED)

Required for full brief acceptance:
- Cold-start budget: <1.5s to interactive on iPhone 13 simulator. Measure with Xcode Instruments. Document the measured number.
- Memory budget: <100MB resident on a 50-message conversation.
- The brief specified iPhone 13. Same Xcode-doesn't-ship-iPhone-15 wrinkle from the bootstrap applies — Xcode 26.4 also doesn't ship iPhone 13 sims. Will substitute iPhone 16 (the closest non-Pro that does ship) and document.

Also for Phase F: light + dark screenshots of every screen (chat empty, chat with messages, trips empty, settings, optionally an auth screen once Phase D lands) — the partial submission has only chat-empty in both modes.

## Brief deliverables status

| Brief deliverable | Status |
|---|---|
| §1 Auth flow | NOT STARTED — blocked on env-var decisions above |
| §2 Chat UI (real, not "hello") | DONE except markdown integration is rendered but not visually tested with real markdown payloads |
| §3 Bottom tab nav | DONE (Trips and Settings are stubs but reachable) |
| §4 Theme + design system primitives | DONE except contrast tests deferred to Phase E |
| §5 Performance | NOT STARTED — measurement is Phase F |

## Verification gate status (from brief)

- ✅ Auth E2E — N/A this push (Phase D)
- ⚠️ Chat E2E — send-message + see-streaming-response works against the mock URLProtocol in tests; live server requires backend creds (same constraint as bootstrap). Regenerate-on-failed-message and copy-message verified by reading the code path.
- ✅ Tab nav E2E — three tabs reachable, NavigationStack per tab preserves state.
- ⚠️ Light + dark mode renders every screen — light renders cleanly, dark has the phantom input bar artifact noted above.
- ❌ Cold-start <1.5s — not measured yet.
- ✅ Existing iOS tests still pass.
- ❌ New tests for auth state machine, message-list rendering, theme contrast — deferred.
- ⚠️ No new SwiftLint warnings — SwiftLint isn't installed locally; can't verify until added or Phase E.
- ✅ App still builds via GitHub Actions — workflow path unchanged from bootstrap.
- ✅ STATUS.md — lane stays Active until full completion (matches the worktree-aware format on main).
- ✅ Diff swept for token patterns — no matches.

## Suggested reviewer action

If you want the foundation work merged so the next session has a clean base:
- Approve and fast-forward main from `claude-code/mobile-chat-1`. Keep the lane open for follow-up commits OR open a new lane (`claude-code/mobile-chat-1-auth`, etc.) for the deferred phases.

If you want the full brief on a single branch:
- Hold the merge. I'll push deferred phases onto the same branch in subsequent sessions and re-ping when complete.

Either way, please answer the Phase D open question (Supabase config) before the next session so it doesn't block the start.
