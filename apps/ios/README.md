# Lumo iOS

Native SwiftUI app for Lumo. This is the Phase 5 foundation — a "hello iOS" that hits the existing `/api/chat` SSE endpoint and renders a streaming response. Real chat polish, auth, voice, and payments come in subsequent sprints (MOBILE-CHAT-1, MOBILE-VOICE-1, MOBILE-PAYMENTS-1).

## Setup

You need:

- Xcode 17 or newer.
- `xcodegen` from Homebrew: `brew install xcodegen`.

The Xcode project is **not committed** — it's regenerated from `project.yml`. Run this once after cloning (and after pulling changes that edit `project.yml`):

```sh
cd apps/ios
xcodegen generate
open Lumo.xcodeproj
```

Then pick an iPhone simulator and run.

## Running against a custom API base

The app reads `LumoAPIBase` from `Info.plist`. Default is `http://localhost:3000`, which means you need the web app running locally:

```sh
# In another terminal, from apps/web/
npm run dev
```

To point the simulator at a remote server temporarily, edit `Lumo/Resources/Info.plist`:

```xml
<key>LumoAPIBase</key>
<string>https://lumo.example.com</string>
```

Don't commit that change. A future sprint will move this to a build-config-driven setting so Debug points at localhost and Release points at production automatically.

## Running tests

```sh
xcodebuild test \
  -project Lumo.xcodeproj \
  -scheme Lumo \
  -destination 'platform=iOS Simulator,name=iPhone 17'
```

The current suite covers the SSE frame parser (`ChatService.parseFrame`) plus an end-to-end streaming test that uses a `URLProtocol` mock to feed synthetic SSE bytes through the same code path the real app uses.

## Build configurations

- **Debug** — bundle id `com.lumo.rentals.ios.dev`, `SWIFT_ACTIVE_COMPILATION_CONDITIONS=DEBUG`. Default for simulator runs.
- **Release** — bundle id `com.lumo.rentals.ios`, optimization `-O`. Used by archive builds.

Code signing is disabled (`CODE_SIGNING_ALLOWED=NO`) because the bootstrap sprint runs only against simulators. CI signing is a Phase 5 sprint, not this one — when we get there it'll need a Lumo Apple Developer team set in `project.yml` and a signing certificate provisioned in CI secrets.

## Layout

```
apps/ios/
├── project.yml                  # xcodegen spec — edit this, not the .xcodeproj
├── Lumo/
│   ├── App/LumoApp.swift        # @main entry; wires ChatService into ChatView
│   ├── Models/Message.swift     # Message + ChatRequest types
│   ├── Services/ChatService.swift  # POST /api/chat + SSE line parser
│   ├── Views/ChatView.swift     # SwiftUI chat UI (input, streaming display, errors)
│   ├── Resources/
│   │   ├── Info.plist           # ATS exception for localhost; LumoAPIBase
│   │   └── Assets.xcassets/     # AppIcon, AccentColor (Lumo cyan #1FB8E8)
│   └── Lumo.entitlements        # empty for now (no capabilities yet)
└── LumoTests/
    └── ChatServiceTests.swift   # parser unit tests + URLProtocol-mocked stream test
```

## Known limitations (will be addressed in Phase 5 sprints)

- **No auth flow.** The app sends an unauthenticated POST. The web `/api/chat` route's auth is stubbed today; once it's wired to real auth, MOBILE-CHAT-1 picks up the iOS side.
- **No rich-frame rendering.** The SSE parser collects `text` and `done` frames; `summary`, `selection`, `mission`, `tool`, and `leg_status` frames are surfaced as `.other(type:)` and ignored by the view. MOBILE-CHAT-1 wires real card UI for these.
- **No real Lumo branding.** Accent color is set to the Lumo cyan but there's no app icon, no splash, no font system. MOBILE-POLISH-1.
- **No voice input or TTS.** MOBILE-VOICE-1.
- **No persistence.** Each app launch is a fresh session_id; no chat history is restored. MOBILE-CHAT-1.
- **`LumoAPIBase` is plist-only.** Switching API base means editing the plist and rebuilding. A build-config-driven setting comes later.
