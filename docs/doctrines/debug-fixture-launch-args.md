# Doctrine: DEBUG launch-arg fixture convention (iOS)

**Decision:** screenshot capture and deterministic preview state
ride on launch-arguments parsed by the app at cold start. Two
patterns, both DEBUG-only — pick the right one for your fixture.

**Canonical for:** every iOS surface that needs a deterministic
preview state for screenshot capture, design review, or local
iteration without spinning up the real backend.

## Why launch args

Three options were considered when MOBILE-CHAT-1B introduced the
first fixture:

| Option | Verdict |
|---|---|
| **Launch arguments** (`-LumoSeedX YES`) parsed at cold start | **Picked.** No code changes per fixture; just `xcrun simctl launch` flags from the capture script. Stripped from Release via `#if DEBUG`. |
| Build-time scheme variants (separate Lumo-Debug-Fixtures scheme) | Heavy. Every fixture needs scheme + Info.plist surgery; capture-script complexity scales linearly. |
| In-app developer menu (Settings → Fixtures → Pick state) | Manual: requires a tap to reach the state. Deterministic capture would still need scripted touches. |

Launch args won because the capture script is just a series of
`xcrun simctl terminate` → `xcrun simctl launch ... -<flag> <value>`
→ `xcrun simctl io screenshot` triples. Zero scripted touches,
fully reproducible, parallelisable across appearance + variant.

## Two patterns

### Pattern A — `applyDebugLaunchArgs` (in-app, mutates view-model state)

For fixtures that seed data into the *normal* app shell. The user
flow is: cold launch → auto-sign-in → drawer → fixture-seeded
state. The fixture is a layer on top of the production view tree.

Implementation: `RootView.applyDebugLaunchArgs()` runs in a
top-level `.task` after the view appears. Each fixture is an
inline `if defaults.bool(forKey: "LumoSeedX") { seedX() }` check;
the seeder calls `chatViewModel._seedForTest(...)` or sets state
on a shared view-model.

Use Pattern A when:

- The fixture is a snapshot of state (chat with seeded messages,
  drawer destination with seeded data, recent-chats list).
- The capture should look like the real app — same chrome, same
  navigation, same accessibility tree. Just deterministic data.
- The fixture composes with other launch args (auto-sign-in +
  start-destination + seed → one capture).

Today's Pattern A fixtures (inventory):

| Flag | Used for |
|---|---|
| `-LumoAutoSignIn YES` | Skip the auth screen, land on chat. |
| `-LumoStartDrawerOpen YES` | Cold-launch with the side drawer open. |
| `-LumoStartDestination <name>` | Cold-launch into a drawer destination (memory / marketplace / history / trips / receipts / settings / profile). |
| `-LumoStartChatInput "<text>"` | Pre-fill the composer text field. |
| `-LumoSeedRecents YES` | Seed deterministic recent-chats. |
| `-LumoSeedChips YES` | Seed `assistant_suggestions` chip strip on a fixture turn. |
| `-LumoSeedFlightOffers YES` | Seed `flight_offers` selection card with a Frontier row pre-committed. |
| `-LumoSeedBookingConfirmation YES` | Seed pre-tap booking confirmation. |
| `-LumoSeedCompoundDispatch <state>` | `live` or `settled` compound-dispatch strip. |
| `-LumoSeedCompoundLegDetail <state>` | `pending` / `in_flight` / `committed` / `failed` / `manual_review`. |
| `-LumoSeedCompoundRollback <state>` | `failed_cascade` / `rollback_pending` / `rolled_back` / `manual_review`. |
| `-LumoSeedDrawerScreens <mode>` | `YES` populated or `empty` empty-state for memory/marketplace/history. |
| `-LumoOpenMemoryEdit <category>` | Auto-present the Memory edit sheet for a category. |
| `-LumoOpenMarketplaceDetail <agent_id>` | Auto-render the agent detail panel in-place. |
| `-LumoVoiceFixture <name>` | `listening` / `transcript` voice-state seed (mocks SFSpeechRecognizer). |

### Pattern B — `*FixtureRoot` (full-screen, replaces the view tree)

For fixtures that need a completely different view tree — usually
because the surface is outside the normal navigation hierarchy or
needs to mock injected services.

Implementation: a `<Domain>FixtureRoot` SwiftUI root view, plus a
`<Domain>Fixture.current` static reader on a fixture descriptor.
Top-level `LumoApp.body` short-circuits the normal `AppRootView`
when the fixture is set:

```swift
WindowGroup {
    #if DEBUG
    if let fixture = PaymentsFixture.current {
        PaymentsFixtureRoot(fixture: fixture)
    } else if let fixture = NotificationsFixture.current {
        NotificationsFixtureRoot(fixture: fixture, cache: proactiveCache)
    } else {
        normalRoot
    }
    #else
    normalRoot
    #endif
}
```

Use Pattern B when:

- The fixture needs to bypass auth, navigation, and the chat
  shell entirely (payments confirmation card by itself, a
  notification preview without backend traffic).
- The fixture wires mock services (a fake PaymentService, a
  pre-seeded ProactiveMomentsCache) that would be awkward to
  inject into the normal app's DI graph.
- The screen is an end-state preview (receipt detail for a
  specific receipt id) where the navigation path to reach it
  in production is irrelevant to what's being captured.

Today's Pattern B fixtures (inventory):

| Flag | FixtureRoot |
|---|---|
| `-LumoPaymentsFixture <name>` | `PaymentsFixtureRoot` — empty-methods, saved-cards, add-card, confirm-ready, confirm-success, receipt-history, receipt-detail. |
| `-LumoNotificationsFixture <name>` | `NotificationsFixtureRoot` — system permission prompt + per-category proactive-moment previews. |

## Naming convention

Three prefixes, each with a distinct semantic:

- **`-LumoSeedX <value>`** — seed deterministic data into the
  production view tree (Pattern A). Value is `YES` for boolean
  fixtures or a state name for enum-driven fixtures.
- **`-LumoStartX <value>`** — set initial app state at cold launch
  (Pattern A). `LumoStartDrawerOpen`, `LumoStartDestination`,
  `LumoStartChatInput`. These are state transitions, not data
  seeds.
- **`-LumoOpenX <value>`** — auto-navigate to a sub-state inside a
  destination (Pattern A). `LumoOpenMemoryEdit`,
  `LumoOpenMarketplaceDetail`. One-shot — the binding clears after
  first use.
- **`-LumoXFixture <name>`** — top-level fixture root (Pattern B).
  `LumoPaymentsFixture`, `LumoNotificationsFixture`,
  `LumoVoiceFixture`. The `Fixture` suffix signals "this swaps the
  view tree, not just data."

The auto-sign-in flag (`-LumoAutoSignIn YES`) doesn't fit a
prefix — it's a session-state shortcut, conceptually orthogonal to
fixture data. Keep it as-is.

## DEBUG-only enforcement

Every fixture path lives behind `#if DEBUG` so Release builds
strip them. The `IOS-DEV-BYPASS-GATE-1` lane established the
defense-in-depth verifier for the auth-bypass button; the same
discipline applies to fixture seeders. If a future fixture needs
to ship to TestFlight or App Store, it's not a fixture — it's a
feature, and it should land via the normal product flow.

The capture script (`scripts/ios-capture-screenshots.sh`) only
runs against Debug-config builds; the `ios-dev-bypass-gate-1`
variant is the one exception that runs against a Release build,
and it's specifically capturing the absence of fixture
affordances.

## When to add a new fixture

1. **First ask: do I really need a fixture?** A test is usually
   the right answer when the goal is correctness. A fixture is
   the right answer when the goal is a deterministic *visual*
   state for capture or design review.
2. **Pick the pattern** based on whether the fixture seeds data
   into the production view tree (A) or replaces the view tree
   (B).
3. **Name the flag** following the prefix convention. If the flag
   takes an enum-of-states value, document the enum in the
   `applyDebugLaunchArgs` comment so the capture script's
   variants are discoverable.
4. **Add the capture-script variant** so re-capture is a single
   command. The variant block in `scripts/ios-capture-screenshots.sh`
   should call `capture <name> <appearance> <flags>` for each
   PNG it produces.
5. **Wrap in `#if DEBUG`** so Release builds strip it.

## When to revisit

Revisit if:

- The fixture inventory grows past ~20 flags and discoverability
  becomes a problem. Answer: add a `scripts/ios-list-fixtures.sh`
  that greps the codebase for the conventions and prints the
  current set with their value enums.
- A fixture needs production-like services (real Supabase,
  real Stripe in test mode) — that's not a fixture anymore;
  consider a separate `LumoStaging` scheme.
- The cold-launch path to a fixture state takes > 5 seconds (auth
  + nav + seed). Answer: investigate whether the fixture should be
  Pattern B (skip auth/nav entirely) instead.

## Source pointers

- `apps/ios/Lumo/Views/RootView.swift::applyDebugLaunchArgs()` —
  Pattern A entry point.
- `apps/ios/Lumo/App/LumoApp.swift` — Pattern B short-circuit in
  `body: some Scene`.
- `apps/ios/Lumo/Views/PaymentsFixtureRoot.swift`,
  `apps/ios/Lumo/Views/NotificationsFixtureRoot.swift` — Pattern B
  reference implementations.
- `scripts/ios-capture-screenshots.sh` — capture-script variants
  per fixture.
