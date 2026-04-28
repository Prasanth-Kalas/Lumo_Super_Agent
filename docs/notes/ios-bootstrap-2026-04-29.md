# iOS bootstrap — 2026-04-29

Lane: `claude-code/ios-bootstrap`. Brief: the "Brief to Claude Code" issued by the reviewer on 2026-04-29 (iOS-first foundation for Phase 5). This note captures what shipped, what deviated from the brief, what the next sprint should pick up, and a couple of rough edges worth flagging.

## What shipped

Two logical commits on the branch:

1. **`chore(monorepo): relocate web app to apps/web/ and adopt npm workspaces`** — moved every web file under `apps/web/` via `git mv` (preserves rename history), kept `samples/` at root as a sibling workspace, created `packages/shared-types/` placeholder, and adjusted root scripts and CI for the new paths. Verified `npm install` + `npm run build --workspace apps/web` + `npm run lint:registry` + `npm run eval:phase1` all pass after the move.
2. **iOS scaffold + chat impl** (this commit + follow-ups) — `apps/ios/` SwiftUI app, xcodegen-driven, hits `/api/chat`, parses SSE frames, displays streaming text. Hand-rolled SSE client over `URLSession.bytes(for:).lines`. Zero third-party SwiftPM dependencies.

## Deviations from the brief

- **Brief said `iPhone 15 Simulator`; I used `iPhone 17`.** Xcode 26.4 (the version installed on the dev box) doesn't ship iPhone 15 simulators by default, only iPhone 16 / 16 Pro / 16e / 17 / 17 Pro / 17 Pro Max. The choice doesn't affect the deliverable; substitute whatever simulator is available locally. The CI workflow uses `iPhone 17` to match.
- **Brief's literal root `package.json` was `{"workspaces": ["apps/web", "packages/*"]}`.** I added `"samples/*"` to that list because the existing repo had `samples/*` registered as a workspace and removing it would silently break the four reference agents. The samples are siblings to `apps/web/` rather than nested under it (they only depend on `@lumo/agent-sdk`, not on the web app's `lib/`), which keeps the workspace tree flat and avoids npm's nested-workspace edge cases.
- **Live streaming demo not captured.** The brief asks for a screenshot showing a streaming response. I have an integration test that proves the end-to-end SSE parse against a `URLProtocol` mock (passes), and a launch screenshot showing the running iOS app on the simulator. A live-streaming screenshot would require the dev server with real backend creds (`ANTHROPIC_API_KEY`, Supabase, etc.); standing those up was outside the bootstrap scope. See "Verification" below for the full evidence chain.

## Verification

- `cd apps/web && npm install && npm run build` — green. All routes compile, middleware compiles. Production deploy contract preserved.
- `cd apps/web && npm run lint:registry` — green (3 registry JSONs validate).
- `npm run eval:phase1` (root passthrough) — green (all phase-1 evals pass).
- `cd apps/ios && xcodegen generate && xcodebuild -scheme Lumo -destination 'platform=iOS Simulator,name=iPhone 17' build` — `BUILD SUCCEEDED`.
- `xcodebuild test -scheme Lumo -destination 'platform=iOS Simulator,name=iPhone 17'` — `TEST SUCCEEDED`, 11 tests, 0 failures. Coverage:
  - 10 unit tests over `ChatService.parseFrame` (text frames, done frame, error frames, unknown types, blank lines, comment lines, malformed JSON, missing-type guard).
  - 1 integration test that pipes synthetic SSE bytes through `URLProtocol` into the real `ChatService.stream(...)` and asserts text chunks arrive in order and `.done` terminates the stream.
- iOS app launched on iPhone 17 Simulator (UDID `12CA8A97-CB46-49E5-95EB-88B072FF57CD`). Screenshot at [`ios-bootstrap-screenshots/01-launch-empty.png`](ios-bootstrap-screenshots/01-launch-empty.png) shows the running app with the empty state, input bar, and Lumo header rendered correctly.

## Manual follow-ups (NOT done in this sprint)

- **Vercel project's "Root Directory" must change to `apps/web` in the dashboard.** `vercel.json` moved with the web app. Until the dashboard setting matches, the next deploy will fail to find `package.json`. This is a one-click change in the Vercel UI; needs whoever has Vercel admin to flip it before the next push to main triggers a deploy.
- **Branch protection on `main`.** I checked rather than configured — see "What I did NOT touch" below.
- **`apps/web/.env.microsoft.local` is committed plaintext.** That file existed pre-conversion (it was at repo root before the move) and contains what looks like local-dev Microsoft Graph creds. The monorepo conversion didn't change this — I just moved it to `apps/web/` along with the rest of the web app. Worth a separate audit pass: rotate any live secrets, move to a real secret manager, or at minimum confirm everything in there is dev-only and document why it's checked in. Out of scope for this sprint.

## What I did NOT touch

- **Branch protection on `main`.** The brief's Step 6 says "verify branch protection is enabled" and offered an example `gh api -X PUT` call to configure it if missing. Configuring branch protection is a permanent admin-level change to the GitHub repo, visible to every collaborator. I didn't run it because:
  1. I'd be changing shared GitHub state without an explicit "yes, set branch protection now" confirmation, and
  2. I can't easily verify the right rules (status check names, required-reviewers count, etc.) without seeing how the team currently merges.
  Recommend the reviewer apply branch protection manually with the rules they want, or explicitly ask me to run a specific configuration.
- **Vercel dashboard.** As above — the rootDirectory setting is git-invisible and I can't reach the dashboard from here.
- **Codex's lanes** (any branch with `codex/` prefix). Saw branches like `codex/perm-1-permissions-and-consent`, `codex/adr-017-clarifications` exist in other worktrees while I was working — left them alone.

## Recommendations for MOBILE-CHAT-1 (next sprint)

Things I learned scaffolding that the next operator should pick up:

1. **The SSE wire format is documented at the top of `apps/web/app/api/chat/route.ts`.** It defines eight frame types (`text`, `mission`, `tool`, `selection`, `summary`, `leg_status`, `error`, `done`). The bootstrap handles only `text`, `error`, `done` and ignores the rest. MOBILE-CHAT-1 needs proper view models for `summary` (confirmation cards), `selection` (rich UI cards), `leg_status` (compound trip progress), `mission` (app install gate), and `tool` (debug overlay only).
2. **The route also accepts a `mode: "voice"` flag** which the orchestrator uses to adapt response length and formatting. MOBILE-VOICE-1 should send this when the user is in hands-busy mode.
3. **The route auth comment says "wire Clerk in a follow-up PR".** Don't build iOS auth on top of a stub; coordinate with whichever sprint wires real auth on the server side first.
4. **The `device_kind: "ios"` field is now flowing.** The orchestrator can branch on this for device-aware behavior (e.g., shorter responses on watch, etc.) — confirm with the orchestrator team whether they want that signal yet.
5. **The hand-rolled SSE parser handles `URLSession.bytes(for:).lines` correctly** but it's a thin layer. If MOBILE-CHAT-1 needs reconnection, multi-line frames, retry-after, or proper `event:` typing, consider promoting it to a small dedicated `SSEClient` type rather than expanding the inline parser.
6. **`URLProtocol` mocking via `URLSessionConfiguration.protocolClasses` works cleanly for streaming tests** — see `LumoTests/ChatServiceTests.swift`. Use the same pattern when adding tests for richer frame types so they don't need a live server.
7. **xcodegen 2.45.4 + Xcode 26.4** generates a clean project from `project.yml` with no manual Xcode editing. Keep it that way — don't commit `Lumo.xcodeproj`.

## Summary

iOS bootstrap is functional. Web app survived the monorepo conversion. iOS tests green, build green, app runs on simulator. Two manual follow-ups (Vercel dashboard rootDirectory, branch protection) are explicitly NOT done and flagged here for the reviewer.
