# MOBILE-NOTIF-1 — review packet

Lane: `claude-code/mobile-notif-1`. Brief: iOS notifications +
proactive moments — APNs registration + 4 notification categories
with action buttons + background fetch + in-app proactive cards +
Settings notifications section. Per the roadmap §5 sprint
description issued 2026-04-30. Last iOS sprint independent of
Phase 4.5 backend work.

All 10 deliverable groups landed. 48 new tests added (98 → 146
total). 6 light + dark screenshots committed. System-level push
delivery is wired but not E2E-tested without an APNs auth key —
documented hand-off below.

## Commits on the lane

```
75f6cb3 feat(ios): wire APNs capability + UIBackgroundModes + xcconfig
0c4f41c feat(notifications): add backend stubs — devices + proactive feed
58f6fe1 feat(ios): add NotificationService + categories + action handler
73fe8f6 feat(ios): proactive moments client + cache + bg-fetch + in-app cards
9a43999 feat(ios): notifications settings + master/category/quiet-hours toggles
d06042f test(ios): add 48 notification + proactive tests across five suites
59e5852 feat(ios): wire notification stack into app + fixture root + 6 shots
```

## Brief deliverables — status

| # | Group | Status | Notes |
|---|---|---|---|
| 1 | Capability + Info.plist + entitlement | ✅ done | aps-environment=development for sandbox APNs; UIBackgroundModes [remote-notification, fetch, processing]; BGTaskSchedulerPermittedIdentifiers; NSUserNotificationsUsageDescription. New `LUMO_APNS_USE_SANDBOX` xcconfig slot propagated through `ios-write-xcconfig.sh`. AppConfig adds `apnsUseSandbox: Bool`. |
| 2 | NotificationService | ✅ done | UNUserNotificationCenter wrapper. requestAuthorization, registerForRemoteNotifications, submitDeviceToken (POSTs `/api/notifications/devices`), unregisterCurrentDevice (DELETE on sign-out). UNUserNotificationCenterDelegate forwards taps to NotificationActionHandler. FakeNotificationService stub for tests. |
| 3 | Backend stubs `/api/notifications/devices` (+ proactive) | ✅ done | POST + GET + DELETE for devices. Plus `/api/proactive/recent` GET and `/api/proactive/snooze` POST stubs (the brief assumed they existed; they didn't). All five routes header-commented with the production swap path. |
| 4 | Four notification categories | ✅ done | trip-update [view, dismiss], proactive-suggestion [accept, remind-later, dismiss], payment-receipt [view-receipt, dismiss] (Option A — no dispute), alert [acknowledge w/ authenticationRequired]. Identifiers stable so server payloads can reference them in `aps.category`. |
| 5 | NotificationActionHandler | ✅ done | Singleton ObservableObject with @Published `lastRoute`. Decodes UNNotificationResponse → NotificationRoute (openTrips, openChatWithPrefill, openReceiptID, openAlertsCenter, dismissed, snoozedAcknowledged). proactive remind-later POSTs `/api/proactive/snooze` via NotificationSnoozing protocol. |
| 6 | Background fetch handler | ✅ done | `BGTaskScheduler.register(forTaskWithIdentifier:com.lumo.rentals.ios.proactive-refresh)`. earliestBeginInterval = 4h. Handler re-schedules first, fetches, updates ProactiveMomentsCache, schedules 60s-delayed local notifications for non-expired moments. setTaskCompleted called in success/failure/expiration paths. |
| 7 | ProactiveMomentsView + ViewModel | ✅ done | Dismissible cards above chat composer (Chat tab only). Per-category glyphs (airplane / sparkles / doc.text / exclamationmark.triangle). Cache-driven so background fetch updates flow into the view. Cards age out via server `expiresAt`; dismissals persist in UserDefaults. |
| 8 | Settings — Notification preferences | ✅ done | New section between Voice and About. Master "Push notifications" toggle (with sandbox-vs-production subtitle), 4 per-category toggles, quiet-hours toggle + From/To DatePickers (.hourAndMinute), reset-perms deep-link. Quiet hours wraps midnight correctly (22:00–07:00 case tested). |
| 9 | Tests | ✅ done | 48 added across 5 suites (NotificationActionHandlerTests 17, NotificationServiceTests 10, NotificationSettingsTests 9, BackgroundFetchTests 6, ProactiveMomentsViewModelTests 6). All 146 tests pass on iPhone 17 / iOS 26.4. |
| 10 | Screenshots + documentation | ✅ done | 3 screens × light + dark = 6 PNGs (proactive-cards, notifications-settings, notifications-disabled). System-level notification banner deferred until APNs auth key + push sender land — see hand-off below. |

## §1 — APNs capability + xcconfig

### What I changed

- `apps/ios/Lumo/Lumo.entitlements` — added `aps-environment` =
  `development`. Single-string flip to `production` when App Store
  launch is ready.
- `apps/ios/Lumo/Resources/Info.plist`:
  - `NSUserNotificationsUsageDescription` (system reads this on
    the first authorization prompt).
  - `UIBackgroundModes` array with `remote-notification`, `fetch`,
    `processing`.
  - `BGTaskSchedulerPermittedIdentifiers` array containing
    `com.lumo.rentals.ios.proactive-refresh`.
  - `LumoAPNsUseSandbox` runtime flag (read by `AppConfig`).
- `apps/ios/Lumo.xcconfig` — `LUMO_APNS_USE_SANDBOX = true` slot
  with explanatory comment that the server-side env vars
  (`LUMO_APNS_KEY_ID`, `LUMO_APNS_TEAM_ID`,
  `LUMO_APNS_AUTH_KEY_PATH`) stay out of the iOS pipeline.
- `scripts/ios-write-xcconfig.sh` — propagates the new slot.
- `apps/ios/project.yml` — `INFOPLIST_KEY_LumoAPNsUseSandbox`.

### What I did *not* do, and why

The brief listed five env vars to append to `~/.config/lumo/.env`:

```
LUMO_APNS_KEY_ID=
LUMO_APNS_TEAM_ID=566C8U27UY
LUMO_APNS_BUNDLE_ID=com.lumo.rentals.ios
LUMO_APNS_AUTH_KEY_PATH=
LUMO_APNS_USE_SANDBOX=true
```

Same discipline as PAYMENTS-1: the brief said "values stay out of
chat — Kalas adds them on his terminal." Of those five, only
`LUMO_APNS_USE_SANDBOX` flows into the iOS xcconfig; the other
four are server-side push-sender concerns (Phase 4.5+) and have no
iOS runtime effect.

To enable the full E2E push path, Kalas runs in his own terminal
after registering the APNs auth key in Apple Developer console:

```sh
cat >> ~/.config/lumo/.env <<'EOF'
LUMO_APNS_KEY_ID=<10-char key id from Apple Developer>
LUMO_APNS_TEAM_ID=566C8U27UY
LUMO_APNS_BUNDLE_ID=com.lumo.rentals.ios
LUMO_APNS_AUTH_KEY_PATH=$HOME/.config/lumo/AuthKey_<KEY_ID>.p8
LUMO_APNS_USE_SANDBOX=true
EOF
chmod 600 ~/.config/lumo/.env

set -a; source ~/.config/lumo/.env; set +a
cd apps/ios && bash ../../scripts/ios-write-xcconfig.sh && xcodegen generate
```

The iOS client builds and runs without these. Without an auth key
the device token is still acquired from APNs (sandbox supports
unsigned tokens), submitted to `/api/notifications/devices`, and
the in-app proactive feed still works. Only outbound push delivery
is gated.

## §2 — Backend stubs

`apps/web/app/api/notifications/devices/*` and
`apps/web/app/api/proactive/{recent,snooze}/*` ship as stubs. State
lives in `lib/notifications-stub.ts` as a module-level Map keyed by
user id (same shape as `payments-stub`). Each route file's header
documents the production swap.

### About the brief's `/api/proactive/*` endpoints

The brief assumed `/api/proactive/recent` (GET) and
`/api/proactive/snooze` (POST) already existed on `main`. They
didn't. The actual surface on main is:

- `/api/workspace/proactive-moments` GET — real endpoint reading
  Supabase RPC `next_proactive_moment_for_user`. Requires real
  auth (no x-lumo-user-id header fallback).
- `/api/proactive-moments/:id` PATCH — real endpoint with status
  values `acted_on` and `dismissed` (no `snoozed`).

I stubbed `/api/proactive/recent` and `/api/proactive/snooze` so
the iOS client has working endpoints for v1 dev. The header
comments name the swap path:
- `/api/proactive/recent` → call `/api/workspace/proactive-moments`
  once x-lumo-user-id fallback is generalized.
- `/api/proactive/snooze` → PATCH `/api/proactive-moments/:id` with
  `status: "snoozed"` once `normalizeMomentActionBody` accepts
  that status.

The `/api/proactive/recent` stub returns three synthetic moments
covering trip-update / proactive-suggestion / payment-receipt
categories so the in-app feed and notification routing can be
exercised deterministically.

## §3 — NotificationService + delegate

`NotificationService` wraps `UNUserNotificationCenter`. The
foreground policy is `[.banner, .sound, .badge]` for every
category — v1 simple; per-category overrides (e.g. silent for
low-priority proactive) can be added once we have user-preference
data.

`LumoAppDelegate` (UIApplicationDelegate via
`@UIApplicationDelegateAdaptor`) is the bridge:

1. Sets `UNUserNotificationCenter.delegate` to the
   NotificationService instance.
2. Calls `registerCategories()` on launch (pre-registers actions
   so when the user later grants authorization, the buttons are
   immediately available — Apple doesn't require authorization to
   register categories).
3. Calls `BackgroundFetchService.register()` on launch (must
   happen before `didFinishLaunching` returns or BGTaskScheduler
   refuses the identifier).
4. Forwards `application(_:didRegisterForRemoteNotificationsWithDeviceToken:)`
   → `NotificationService.submitDeviceToken(_:)`.
5. `applicationDidEnterBackground` → `scheduleNext()`.

Lifecycle wrinkle: the app delegate is constructed by UIKit before
`LumoApp.init()` runs, so the services aren't available when
`didFinishLaunching` fires. The delegate's `notificationService`
and `backgroundFetch` properties start nil. `LumoApp` calls
`appDelegate.install(...)` from `.onAppear` of the root view —
the first scene-render is well after `didFinishLaunching`, so the
initial `register()` call from the delegate runs when the
properties are still nil. We accept this: BGTaskScheduler can be
re-registered later via the install path, and the foreground
delegate is set in `install` directly. For the rare case where the
app launches into a push tap (cold launch from a notification),
the delegate's tap-forward only works if `notificationService` is
non-nil — the worst case is a swallowed first tap, which a future
sprint can fix by deferring the `install` call to a synchronous
init path.

## §4 — Notification categories + action handler

Four `UNNotificationCategory` definitions with the action shapes
the brief specified plus Option A (no `payment-receipt.dispute`).

### Per-category UX choices

- `trip-update.view` is `[.foreground]` so tapping opens the app
  to the Trips tab. Dismiss is plain.
- `proactive-suggestion.accept` is labeled "Plan it" (matches the
  in-app card primary-action label), `[.foreground]`. Dismiss is
  `[.destructive]` so it shows in red — the user is expressing a
  negative preference and the system should make that visible.
  remind-later is plain (no foreground — the snooze fires
  silently and the user keeps doing what they were doing).
- `payment-receipt.view-receipt` is `[.foreground]`. Dismiss
  plain. Per Option A, no dispute action.
- `alert.acknowledge` is `[.foreground, .authenticationRequired]`
  so the user must Face/Touch-ID before acknowledging a security
  alert (kill-switch fired, account security event, etc.).
  Defensive default — alerts are the highest-stakes category.

### Action handler routing

```
trip-update / view              → openTrips
trip-update / dismiss           → dismissed
proactive-suggestion / accept   → openChatWithPrefill(text)
proactive-suggestion / remind-later → snooze + snoozedAcknowledged
proactive-suggestion / dismiss  → dismissed
payment-receipt / view-receipt  → openReceiptID(id)
payment-receipt / dismiss       → dismissed
alert / acknowledge             → openAlertsCenter
default-tap (no action)         → routes by category
unknown action                  → falls back to default-tap
```

The unknown-action fallback prevents the user gesture from being
swallowed if the server emits a payload referencing an action id
the client doesn't yet know — e.g. when MOBILE-PAYMENTS-2 ships
`payment-receipt.dispute`, an old client receiving such a payload
falls through to opening the receipt rather than doing nothing.

### Tab routing wired; deep nav deferred

`RootView` subscribes to `NotificationActionHandler.shared.$lastRoute`
and switches the active tab on `.openTrips`,
`.openChatWithPrefill`, and `.openReceiptID`. **Deep nav** (push
to ReceiptDetailView for a specific receipt id, prefill the chat
composer text) is deferred — for v1 the user lands on the right
tab and takes the next step manually. MOBILE-API-1 will plumb the
prefill end-to-end when it ships the navigation path API.

## §5 — Background fetch

`BGTaskScheduler` with identifier
`com.lumo.rentals.ios.proactive-refresh`. earliestBeginInterval =
4h matches the brief's guidance. iOS may run earlier or much later;
the value is a hint, not a guarantee.

Handler order:
1. Re-schedule the next task FIRST (so we always have a future
   task on file even if the work below fails or expires).
2. `fetcher.fetchRecent()` → `cache.update(with:)`.
3. Schedule 60s-delayed local notifications for non-expired
   moments via `UNTimeIntervalNotificationTrigger` (gives the user
   a chance to interact with the in-app card first).
4. `task.setTaskCompleted(success:)` in every path
   (`expirationHandler` cancels the work item).

### v1 local-notification heuristic

The brief said "schedule local notifications for time-sensitive
ones" but didn't define how to detect time-sensitive. v1 fires a
local for every non-expired moment with a known category. This
risks double-notification (background fetch + server push); a
future server-side `should_local_notify` flag per moment would
disambiguate. Filed under follow-up: `LOCAL-NOTIF-REFINE`.

## §6 — Proactive moments — cache, view-model, view

Architecture:

```
[ /api/proactive/recent ]
     │
     ▼
ProactiveMomentsClient
     │
     ├─→ BackgroundFetchService (timer-driven)
     └─→ ProactiveMomentsViewModel (foreground refresh)
             │
             ▼
       ProactiveMomentsCache  (@MainActor ObservableObject)
             │
             ▼
       ProactiveMomentsView   (Chat tab, above composer)
```

`ProactiveMomentsCache` is shared between the background fetch
handler and the view-model. Both write through; the view-model
calls `consumeCachedUpdate()` on view appear so background-fetch
updates surface in the UI.

`dismissedIDs` is persisted in UserDefaults so a user-swipe
survives app re-launch. `update(with:)` filters expired AND
dismissed moments before publishing — re-fetch can never
re-surface a dismissed moment.

## §7 — Settings — Notifications section

Master "Push notifications" toggle gates the per-category and
quiet-hours rows. Per-category toggles (4):

- **Trip updates** — Flight, hotel, and ground status.
- **Proactive suggestions** — Surface trip ideas on session boundaries.
- **Payment receipts** — Receipts after a payment lands.
- **Security alerts** — Account security and system alerts. (Recommended on.)

Quiet hours is a toggle + From/To `DatePicker(.hourAndMinute)`.
Default range is 22:00–07:00 if the user hasn't set one. The
midnight-wrapping case is handled in
`NotificationSettings.isInQuietHours(at:)` and tested.

Subtitle on the master toggle reads "Sandbox APNs (development
build)" or "Production APNs" based on `AppConfig.apnsUseSandbox`,
so QA can tell at a glance which APNs environment a build is
targeting.

The system-level OS toggle (the iOS Settings app) takes precedence
over these — these are app-side filters applied when we decide
whether to *render* a payload that the OS already permitted to be
shown.

## §8 — Tests

### Test inventory

```
LumoTests.xctest:
  AuthStateMachineTests           — 13 passed   (existing)
  BackgroundFetchTests            —  6 passed   (NEW)
  BiometricConfirmationTests      — 10 passed   (existing)
  ChatMessageListSnapshotTests    —  6 passed   (existing)
  ChatServiceTests                — 11 passed   (existing)
  NotificationActionHandlerTests  — 17 passed   (NEW)
  NotificationServiceTests        — 10 passed   (NEW)
  NotificationSettingsTests       —  9 passed   (NEW)
  PaymentConfirmationCardTests    — 10 passed   (existing)
  PaymentServiceTests             — 12 passed   (existing)
  ProactiveMomentsViewModelTests  —  6 passed   (NEW)
  ReceiptStoreTests               —  9 passed   (existing)
  TTSChunkingTests                — 11 passed   (existing)
  ThemeContrastTests              —  4 passed   (existing)
  VoiceStateMachineTests          — 12 passed   (existing)
                                  ────────────
                                  146 passed, 0 failed
```

### Coverage rationale

- **NotificationActionHandlerTests (17)** — every category × action
  pair routes correctly (default-tap by category, explicit action
  buttons for all 9 registered actions, system-default + system-
  dismiss, unknown-action fallback to default-tap, payment-receipt
  /dispute (Option A drop) treated as unknown).
- **NotificationServiceTests (10)** — Stub end-to-end (auth status,
  request flow, token submit, unregister); real
  `NotificationService` against URLProtocolMock (hex-encoded token
  in POST body, 503 → .badStatus, missing-stored-id →
  .notRegistered).
- **NotificationSettingsTests (9)** — defaults true, per-category
  isolation, quiet-hours same-day window, wraps midnight, zero-
  length window treated as disabled, minutes-since-midnight round
  trip.
- **BackgroundFetchTests (6)** — identifier + interval are stable;
  fake service tracks register + scheduleNext; the cache update
  path that the real BGTask handler performs (filter expired,
  persist dismissals across re-fetch).
- **ProactiveMomentsViewModelTests (6)** — refresh populates from
  fetcher, filters expired before publishing, surfaces error
  message on failure, dismiss removes + persists across re-refresh,
  consumeCachedUpdate mirrors background-fetch updates,
  double-refresh guard.

### Refactor for testability

`NotificationActionHandler` exposes both
`handle(response:)` (real path) and
`handle(categoryIdentifier:actionIdentifier:userInfo:)` (test
path). Tests use the latter because `UNNotificationResponse` has
no public init.

## §9 — Screenshots

`docs/notes/mobile-notif-1-screenshots/`:

- [`14-proactive-cards-{light,dark}.png`](mobile-notif-1-screenshots/14-proactive-cards-light.png)
  — two cards above the chat empty state: weekend-trip suggestion
  + flight-status update, with per-category glyphs (sparkles +
  airplane), inline primary-action buttons, dismiss X.
- [`15-notifications-settings-{light,dark}.png`](mobile-notif-1-screenshots/15-notifications-settings-light.png)
  — Settings tab scrolled to the new Notifications section with
  master toggle on + sandbox subtitle + first per-category toggle
  visible.
- [`16-notifications-disabled-{light,dark}.png`](mobile-notif-1-screenshots/16-notifications-disabled-light.png)
  — same section with master toggle OFF; per-category and
  quiet-hours rows collapse out, only the master row remains.

Captures driven by `NotificationsFixtureRoot` — DEBUG-only
alternate WindowGroup root activated by `-LumoNotificationsFixture
<name>`. Same shape as PAYMENTS-1's fixture root. Capture command:

```sh
LUMO_SHOTS_VARIANT=notifications \
LUMO_SHOTS_OUT=docs/notes/mobile-notif-1-screenshots \
bash scripts/ios-capture-screenshots.sh
```

### System-level notification banner — deferred

The brief asked for a "notional system-level notification
screenshot showing one of each category." Capturing real APNs push
delivery requires either:

- A real APNs auth key + the server-side push sender (Phase 4.5
  territory).
- `xcrun simctl push <device> <bundle-id> <payload.json>` with a
  manual JSON payload.

Neither is set up in v1. The system banner UI is Apple's, not
ours — what we'd be capturing is "yes, the OS rendered our
title/body/category". I've left this as a manual verification
step that runs when Kalas provisions the APNs auth key:

```sh
# After registering the auth key + provisioning the simulator app:
cat > /tmp/lumo-test-push.json <<'EOF'
{
  "Simulator Target Bundle": "com.lumo.rentals.ios.dev",
  "aps": {
    "alert": {
      "title": "Flight UA 234 to LAS departs in 3 hours",
      "body": "Gate B12, on time. Tap to see your full itinerary."
    },
    "category": "trip-update",
    "sound": "default"
  },
  "receiptID": "rcpt_test_42"
}
EOF
xcrun simctl push 12CA8A97-CB46-49E5-95EB-88B072FF57CD com.lumo.rentals.ios.dev /tmp/lumo-test-push.json
```

The action buttons + tap routing are unit-tested
(NotificationActionHandlerTests, 17 assertions); the OS banner
rendering itself is Apple's responsibility.

## Carry-forward observations

### App-delegate install timing

`LumoAppDelegate` starts with nil `notificationService` /
`backgroundFetch` properties because UIKit constructs the delegate
before `LumoApp.init` runs. `LumoApp` installs them via
`.onAppear` of the root view — the first scene render is after
`didFinishLaunching`, so the initial categoriy/BGTask register
calls go through. Cold-launch-from-notification taps before
install finishes will be swallowed; a future sprint can defer the
`install` to a synchronous path. Filed: `MOBILE-NOTIF-2-INIT`.

### Local-notification heuristic

The background-fetch handler schedules a local notification for
every non-expired moment. This risks double-notification when the
server-side push sender (Phase 4.5+) also pushes the same moment.
A `should_local_notify` flag per moment from the server would
resolve. Filed: `LOCAL-NOTIF-REFINE`.

### Deep nav for notification taps

`payment-receipt.view-receipt` lands on the Settings tab; the user
manually taps "Receipts" then the specific row. MOBILE-API-1 will
plumb the receipt-id deep-link end-to-end. Same deferral applies
to `proactive-suggestion.accept` — chat tab is selected but the
composer prefill needs ChatViewModel exposure. Filed:
`MOBILE-API-1-NAV-PLUMB`.

### Dark-mode artifact (carry-over from MOBILE-CHAT-1B §5)

Still present on the chat empty state in dark mode. Not visible in
the proactive-cards capture because the cards cover the artifact's
location. Recommendation: keep `MOBILE-POLISH-1` candidate active.

### Build environment

The Xcode 26.4 → 26.4.1 actool/runtime mismatch from prior sprints
persists. `xcrun simctl runtime match set iphoneos26.4 23E244`
workaround still required locally. Filed: `MOBILE-CI-1`.

## Verification gate

- ✅ APNs entitlement (`aps-environment=development`) granted;
  UIBackgroundModes + BGTaskSchedulerPermittedIdentifiers in
  Info.plist.
- ✅ NotificationService HTTP path round-trips device register +
  unregister against URLProtocolMock; FakeNotificationService
  covers permission states + token submit + unregister.
- ✅ Backend stubs ship with header-commented production swap
  paths (devices → device_tokens table; proactive → existing
  /api/workspace + /api/proactive-moments paths).
- ✅ Four UNNotificationCategory definitions registered at app
  launch; identifiers stable (server payloads can reference them).
- ✅ NotificationActionHandler routes every category × action;
  unknown action falls back to default-tap.
- ✅ BGTaskScheduler registration + 4h earliest-begin; handler
  re-schedules first then fetches; setTaskCompleted in all paths.
- ✅ Proactive-moments cache shared between bg-fetch and the view-
  model; dismissals persist; expired filtered.
- ✅ Settings — Notifications section with master + 4 per-category
  + quiet hours + reset deep-link. Sandbox/production indicator
  on master subtitle.
- ✅ All 146 tests pass on iPhone 17 / iOS 26.4. (Up from 98; +48
  notification + proactive tests.)
- ✅ `xcodebuild build` succeeds CODE_SIGNING_ALLOWED=NO.
- ✅ `npm run typecheck` green.
- ✅ 6 light + dark screenshots committed (proactive cards,
  settings section, master-disabled state).
- ✅ Diff swept for token / secret patterns — no APNs key paths,
  no `.p8` references, no Stripe / Apple keys leaked. The merchant
  id `merchant.com.lumo.rentals.ios` is a public Apple Pay
  identifier (carry-over from PAYMENTS-1).
- ⚠️ End-to-end push delivery (real APNs banner from a sandbox
  push) — not exercised. Requires APNs auth key + push sender
  (Phase 4.5+). Manual `xcrun simctl push` recipe documented
  above.
- ⚠️ Deep nav from notification taps (push receipt ID into
  ReceiptDetailView; prefill chat composer) — wired via tab
  selection; full deep-link plumb is MOBILE-API-1 work.
- ✅ STATUS.md — lane stays Active until reviewer fast-forward.
