# Doctrine: composer mic ↔ send button (iOS)

**Decision:** single trailing icon, content-aware swap. Mic when the
input is empty; paperplane (send) when the input has content;
waveform (pulsing) when the mic is open.

**Canonical for:** the Lumo iOS chat composer.

## Why this over always-both

Two patterns were on the table:

| Pattern | Where it's seen | Trade-off |
|---|---|---|
| **Single trailing icon, content-aware swap** | WhatsApp, Telegram, Signal, iMessage (newer iOS) | One icon at a time; cleaner chrome; matches the dominant mobile-messaging affordance for our user base. The user's hand stays in one place — the same trailing slot does both jobs. |
| Always-both (mic always left, send always right) | Older iMessage, some hybrid apps | Both affordances visible at all times; no ambiguity about what the icon does — but eats more chrome, splits the user's hand position, and feels like a desktop pattern in a mobile context. The web composer at `apps/web/app/page.tsx` uses a desktop-shaped variant of this; iOS doesn't need to mirror that. |

We previously shipped always-both in `IOS-MIRROR-WEB-1` to match web's
composer shape. That mirror was useful for the cross-platform parity
demo packets but the iOS form factor (one-thumb reach, mobile keyboard
takes most of the screen) makes the swap pattern strictly better in
practice. `IOS-COMPOSER-AND-DRAWER-SCREENS-1` reverses the call — web
and iOS composers are now allowed to diverge on this one detail.

## Implementation contract

Mode-pick logic lives in `ChatComposerTrailingButton.Mode.from(input:isListening:)`:

- `isListening == true` → `.waveform` (always wins; partial transcripts
  populating the input field don't flip the icon to send)
- `input` empty after trimming `.whitespaces` → `.mic`
- otherwise → `.send`

Listening trumps input because the alternative — flickering between
waveform and send as transcripts stream in — looks like a bug.

## When to revisit

Revisit if user research surfaces:

- A measurable rate of users tapping mic when they meant send (icon
  ambiguity in the swap window)
- A request for "explicit voice toggle" UX from accessibility users
  (some prefer always-visible affordances over content-aware ones)
- A need to add a third inline action (camera, attachment) — at three
  inline icons, the swap pattern starts to lose its simplicity
  argument and a toolbar row may pull ahead again

Web composer is unaffected; this doctrine is iOS-only.

## Source pointers

- `apps/ios/Lumo/Components/ChatComposerTrailingButton.swift` — the
  swap component
- `apps/ios/Lumo/Views/ChatView.swift::inputBar` — the mount point
- `apps/ios/LumoTests/ChatComposerSwapTests.swift` — pinned mode-pick
  contract (9 tests)
