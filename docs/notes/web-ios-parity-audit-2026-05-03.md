# Web ↔ iOS feature parity audit — 2026-05-03

Scope: map every user-facing feature in `apps/web/` to its iOS counterpart in
`apps/ios/Lumo/`, identify gaps, and produce a prioritized list of what to
build on iOS to bring it into lockstep with web.

This is a snapshot. The Deepgram migration is mid-flight (recon doc:
[apps/ios/docs/notes/deepgram-recon.md](../../apps/ios/docs/notes/deepgram-recon.md)) so
the voice rows will shift in the next 1–2 weeks.

## Revision — 2026-05-03 verification pass

The first pass had several false negatives. After grepping the iOS code
directly:

- **Suggestion chips** are at parity, not web-only — see
  [apps/ios/Lumo/Components/SuggestionChips.swift](../../apps/ios/Lumo/Components/SuggestionChips.swift)
  (with fade overlay + a11y identifiers, more polished than web).
- **Voice mode UI** is mostly at parity, not partial. iOS already has live
  transcript banner ([apps/ios/Lumo/Views/ChatView.swift:268](../../apps/ios/Lumo/Views/ChatView.swift#L268)),
  barge-in via `requestBargeIn()`
  ([apps/ios/Lumo/ViewModels/VoiceComposerViewModel.swift:137](../../apps/ios/Lumo/ViewModels/VoiceComposerViewModel.swift#L137)),
  full TTS phase machine mirroring web's `voiceMachinePhase`, mic-pause
  gating, post-speaking tail guard, tap-to-talk, and long-press PTT.
- **Voice picker** is at parity — already in
  [apps/ios/Lumo/Views/SettingsView.swift:214](../../apps/ios/Lumo/Views/SettingsView.swift#L214).
- **Notifications settings** are at parity — push toggle + four category
  toggles (trip / proactive / payment / alert) already in SettingsView.
- **Hands-free vs PTT** is an intentional iOS divergence per
  [docs/doctrines/mic-vs-send-button.md](../doctrines/mic-vs-send-button.md);
  mobile UX is push-to-talk by design, not a parity bug.
- **iOS Marketplace install button** is a local-state placeholder — does
  not actually call `POST /api/lumo/mission/install`. Tracked as
  IOS-MARKETPLACE-INSTALL-1 in the source comment.

The gap list below has been re-sorted with the corrected statuses. The
"voice barge-in / hands-free / transcript / picker" rows previously listed
as `partial` are removed; only wake-word remains a real voice-stack gap.

## Headline

iOS is missing roughly **40% of web's feature surface**. The gap concentrates
in five clusters:

1. **Voice mode UI** — STT/TTS plumbing exists on iOS (Deepgram), but the UI
   affordances around it (hands-free toggle, barge-in, wake-word, transcript
   display) are not wired.
2. **Memory depth** — iOS has profile only; web also has free-text Facts and
   read-only Patterns.
3. **History/trips depth** — iOS history is sessions-only; web merges sessions
   + trips with search, filter, expand-detail, and cancel/refund.
4. **Marketplace depth** — iOS has the catalog and detail; web also has OAuth
   connect, MCP token-paste, rich risk-badge cards, and connection status.
5. **Admin / publisher / autonomy / onboarding** — entirely web-only surfaces.

What is in good shape: chat SSE streaming, proactive moments feed, receipts
list, biometric unlock, auth gate, basic marketplace catalog, memory profile,
session history. The shared `/api/*` surface is wide — most iOS gaps are
**UI-side**, not backend-side.

## Section 1 — Parity matrix

Sorted: `web-only` → `partial` → `parity`.

| Web feature | Web route / component | iOS file | Shared API? | Status |
|---|---|---|---|---|
| Memory: free-text facts + patterns | [apps/web/app/memory/](../../apps/web/app/memory/) (Facts / Patterns sections) | — (`IOS-MEMORY-FACTS-1`) | `/api/memory`, `/api/memory/facts/[id]` | web-only |
| Marketplace: install button → real API call | install card in chat shell | placeholder in [MarketplaceAgentDetailView](../../apps/ios/Lumo/Views/MarketplaceView.swift) (`IOS-MARKETPLACE-INSTALL-1`) | `/api/lumo/mission/install` | web-only |
| Marketplace: rich agent cards (risk badges, OAuth, MCP, coming-soon) | [apps/web/components/AgentCard.tsx](../../apps/web/components/AgentCard.tsx) | — (`IOS-MARKETPLACE-RICH-CARDS-1`) | — | web-only |
| Marketplace: MCP token-paste modal | [apps/web/components/McpConnectModal.tsx](../../apps/web/components/McpConnectModal.tsx) | — | [apps/web/app/api/mcp/](../../apps/web/app/api/mcp/) | web-only |
| Marketplace: OAuth connect flow | [apps/web/app/marketplace/](../../apps/web/app/marketplace/) (startConnect) | — | `/api/connections/start` | web-only |
| History: search + filter | [apps/web/app/history/](../../apps/web/app/history/) (client-side) | — (deferred per [HistoryView.swift:9](../../apps/ios/Lumo/Views/HistoryView.swift#L9)) | `/api/history` | web-only |
| History: trip expand-detail row | [apps/web/app/history/](../../apps/web/app/history/) (TripRowCard) | — | `/api/trips`, `/api/trip/{id}/cancel` | web-only |
| Trips: list + leg detail (real content) | [apps/web/app/trips/](../../apps/web/app/trips/) | stub [TripsView.swift](../../apps/ios/Lumo/Views/TripsView.swift) (27 lines) | `/api/trips` | web-only (iOS file is a stub) |
| Workspace: dashboard (Today / Content / Inbox / Co-pilot / Operations) | [apps/web/app/workspace/](../../apps/web/app/workspace/) | stub [WorkspaceView.swift](../../apps/ios/Lumo/Views/WorkspaceView.swift) (28 lines) | `/api/workspace` | web-only (iOS file is a stub) |
| Connections: OAuth status dashboard | [apps/web/app/connections/](../../apps/web/app/connections/) | — | [apps/web/app/api/connections/](../../apps/web/app/api/connections/) | web-only |
| Wake-word enrollment + test | [apps/web/app/settings/wake-word/](../../apps/web/app/settings/wake-word/), [apps/web/components/wake-word/](../../apps/web/components/wake-word/) | — | — | web-only (no Deepgram wake-word API) |
| Hands-free continuous mode (auto-listen after TTS) | [apps/web/components/VoiceMode.tsx](../../apps/web/components/VoiceMode.tsx) | iOS uses tap-to-talk + long-press by design | — | intentional divergence — see [docs/doctrines/mic-vs-send-button.md](../doctrines/mic-vs-send-button.md) |
| Onboarding flow | [apps/web/app/onboarding/](../../apps/web/app/onboarding/) | — | — | web-only |
| Settings: account, cost leaves | [apps/web/app/settings/account/](../../apps/web/app/settings/account/), [apps/web/app/settings/cost/](../../apps/web/app/settings/cost/) | partial in [SettingsView.swift](../../apps/ios/Lumo/Views/SettingsView.swift) | `/api/preferences/*` | partial |
| Admin / Developer / Publisher / Autonomy / Intents / Ops | various web routes | — | various | web-only **by design** (operator surfaces) |
| Chat SSE streaming | chat shell `/` | [ChatView.swift](../../apps/ios/Lumo/Views/ChatView.swift) + [ChatService.swift](../../apps/ios/Lumo/Services/ChatService.swift) | `/api/chat` | parity |
| Suggestion chips in composer | [apps/web/components/SuggestionChips.tsx](../../apps/web/components/SuggestionChips.tsx) | [SuggestionChips.swift](../../apps/ios/Lumo/Components/SuggestionChips.swift) | — | parity |
| Voice mode UI (barge-in, transcript banner, phase machine, mic gate) | [apps/web/components/VoiceMode.tsx](../../apps/web/components/VoiceMode.tsx) | [VoiceComposerViewModel.swift](../../apps/ios/Lumo/ViewModels/VoiceComposerViewModel.swift) + ChatView banner + composer button | `/api/audio/deepgram-token` | parity |
| Voice ID picker | [apps/web/components/VoicePicker.tsx](../../apps/web/components/VoicePicker.tsx) | [SettingsView.swift:214](../../apps/ios/Lumo/Views/SettingsView.swift#L214) | `/api/memory/profile` (`preferred_voice`) | parity |
| Notifications settings (push + categories) | [apps/web/app/settings/notifications/](../../apps/web/app/settings/notifications/) | [SettingsView.swift](../../apps/ios/Lumo/Views/SettingsView.swift) | local + APNs | parity |
| Proactive moments feed | chat shell `/` | [ProactiveMomentsView.swift](../../apps/ios/Lumo/Views/ProactiveMomentsView.swift) | `/api/proactive/recent` | parity |
| Proactive moment: snooze action | proactive card on chat shell | [NotificationActionHandler.swift](../../apps/ios/Lumo/Services/NotificationActionHandler.swift) | `/api/proactive/snooze` | parity |
| Marketplace catalog (browse + detail) | [apps/web/app/marketplace/](../../apps/web/app/marketplace/) | [MarketplaceView.swift](../../apps/ios/Lumo/Views/MarketplaceView.swift) | `/api/marketplace` | parity (browse only — install is web-only, see above row) |
| Memory / Profile structured fields | [apps/web/app/profile/](../../apps/web/app/profile/) | [MemoryView.swift](../../apps/ios/Lumo/Views/MemoryView.swift) | `/api/memory/profile` | parity for profile section |
| History (sessions list) | [apps/web/app/history/](../../apps/web/app/history/) | [HistoryView.swift](../../apps/ios/Lumo/Views/HistoryView.swift) | `/api/history` | parity for sessions list |
| Receipts list + detail | [apps/web/app/receipts/](../../apps/web/app/receipts/) | [ReceiptHistoryView.swift](../../apps/ios/Lumo/Views/ReceiptHistoryView.swift), [ReceiptDetailView.swift](../../apps/ios/Lumo/Views/ReceiptDetailView.swift) | `/api/receipts` | parity |
| Auth (sign-in gate) | [apps/web/app/login/](../../apps/web/app/login/) (Supabase) | [AuthView.swift](../../apps/ios/Lumo/Views/AuthView.swift) (Apple Sign-In) | `/api/auth` | parity (different providers, same session model) |
| Biometric unlock | — | [BiometricUnlockView.swift](../../apps/ios/Lumo/Views/BiometricUnlockView.swift) | — | iOS-only (correct — no web equivalent needed) |
| Background proactive refresh | — | [BackgroundFetchService.swift](../../apps/ios/Lumo/Services/BackgroundFetchService.swift) | `/api/proactive/recent` | iOS-only (correct — web uses tab focus) |

## Section 2 — Voice stack deep-dive

User explicitly called this out. Both clients use Deepgram, but the iOS side is
mid-migration ([apps/ios/docs/notes/deepgram-recon.md](../../apps/ios/docs/notes/deepgram-recon.md)).

| Voice capability | Web | iOS | Gap |
|---|---|---|---|
| STT provider | `webkitSpeechRecognition` (browser-native) | Deepgram Nova-3 over WSS via [SpeechRecognitionService.swift](../../apps/ios/Lumo/Services/SpeechRecognitionService.swift) | Different stacks but functional parity |
| TTS provider | `/api/tts` (server-side) + browser `speechSynthesis` fallback | Deepgram Aura-2 over WSS via [TextToSpeechService.swift](../../apps/ios/Lumo/Services/TextToSpeechService.swift) | Different stacks; iOS migration in flight |
| Token mint | n/a (browser) | [DeepgramTokenService.swift](../../apps/ios/Lumo/Services/DeepgramTokenService.swift) → `POST /api/audio/deepgram-token` | iOS-only need; backend exists |
| Sentence-boundary chunking for streamed TTS | inline in [VoiceMode.tsx](../../apps/web/components/VoiceMode.tsx) | [TTSChunker.swift](../../apps/ios/Lumo/Services/TTSChunker.swift) | Both implemented |
| State machine (idle/listening/thinking/speaking/error) | [VoiceMode.tsx](../../apps/web/components/VoiceMode.tsx) | partial — `VoiceComposerViewModel` wires STT+TTS, but full UI states not surfaced | **iOS gap** |
| Hands-free auto-resume after TTS | [VoiceMode.tsx](../../apps/web/components/VoiceMode.tsx) | gating logic in [SpeechModeGating.swift](../../apps/ios/Lumo/Services/SpeechModeGating.swift), settings in [VoiceSettings.swift](../../apps/ios/Lumo/Services/VoiceSettings.swift) | **iOS gap — UI toggle missing** |
| Barge-in (user speech cancels TTS) | `lib/barge-in.ts` + `startBargeInMonitor()` | TTS is cancelable but auto-trigger on speech-start is not wired | **iOS gap** |
| Wake-word | [apps/web/components/wake-word/](../../apps/web/components/wake-word/), [apps/web/app/settings/wake-word/](../../apps/web/app/settings/wake-word/) | not implemented | **iOS gap — no Deepgram wake-word API at audit time; would need on-device alternative** |
| Live interim transcript display | [VoiceMode.tsx](../../apps/web/components/VoiceMode.tsx) | not surfaced in UI | **iOS gap** |
| Voice ID picker | [VoicePicker.tsx](../../apps/web/components/VoicePicker.tsx) | inline in MemoryView | parity |

## Section 3 — Backend sharing

Web routes are client-side fetched (sampled `/history`, `/profile`,
`/marketplace` — all hydrate then call `/api/*`). That means iOS can hit the
same backends. Here's where the wiring already exists:

| iOS service | Web `/api/*` endpoint | Web consumer |
|---|---|---|
| [ChatService.swift](../../apps/ios/Lumo/Services/ChatService.swift) | `POST /api/chat` (SSE) | chat shell |
| [ProactiveMomentsClient.swift](../../apps/ios/Lumo/Services/ProactiveMomentsClient.swift) | `GET /api/proactive/recent` | chat shell |
| [DeepgramTokenService.swift](../../apps/ios/Lumo/Services/DeepgramTokenService.swift) | `POST /api/audio/deepgram-token` | (iOS-only — web uses browser STT) |
| [DrawerScreensClient.swift](../../apps/ios/Lumo/Services/DrawerScreensClient.swift) | `GET /api/memory/profile`, `GET /api/marketplace`, `GET /api/history` | `/memory`, `/marketplace`, `/history` |
| [NotificationActionHandler.swift](../../apps/ios/Lumo/Services/NotificationActionHandler.swift) | `POST /api/proactive/snooze` | proactive cards |
| [PaymentService.swift](../../apps/ios/Lumo/Services/PaymentService.swift) | `/api/payments` | (web payments UI not yet built) |
| [AuthService.swift](../../apps/ios/Lumo/Services/AuthService.swift) | `/api/auth` | `/login`, `/auth` |

**Implication:** for most web-only features, the backend already exists — the
iOS gap is purely a SwiftUI build. The exceptions are admin/developer/publisher
which are intentionally web-only.

## Section 4 — Recommended priority order (revised after verification)

Tier A = small, contained, visible-side-by-side gaps. Tier B = bigger
features (new view shells). Tier C = niche / intentional.

### Tier A — extend existing iOS screens

1. **Memory facts + patterns** — `IOS-MEMORY-FACTS-1`. Whole sections of
   [/memory](../../apps/web/app/memory/) missing on iOS. Backend exists
   (`/api/memory` for facts, patterns are returned alongside profile). Just
   adds two sections and a "Forget" action to
   [MemoryView.swift](../../apps/ios/Lumo/Views/MemoryView.swift).
   *(Picked as the first task.)*
2. **Marketplace install button → real API** — `IOS-MARKETPLACE-INSTALL-1`.
   Today the iOS install button is a haptic + local state flip; web actually
   calls `POST /api/lumo/mission/install`. Small wiring change.
3. **History trip-row expand-detail** — iOS already calls `/api/history` and
   shows a trip-count badge; web shows leg details inline. Add the expand UI.

### Tier B — replace stubs / new surfaces

4. **Trips view real content** — `MOBILE-TRIP-1`. Currently 27-line stub.
   Needs a TripsScreenViewModel + list/detail.
5. **Connections OAuth status dashboard** — new view, calls
   [`/api/connections`](../../apps/web/app/api/connections/).
6. **Trip cancel/refund** — calls `/api/trip/{id}/cancel`. Could be added
   to the trip-detail row from #3.
7. **Workspace view real content** — currently 28-line stub. Lower priority
   if workspace is operator-leaning.

### Tier C — niche / intentional / by-design

8. **Settings depth** — account / cost leaves not yet ported. Many of
   these are nice-to-have.
9. **Marketplace rich risk-badge cards / OAuth / MCP** — `IOS-MARKETPLACE-RICH-CARDS-1`.
   Cosmetic + connection flows; defer until install (#2) and basic
   marketplace are confirmed solid.
10. **Wake-word on iOS** — no Deepgram wake-word API; would need an
    on-device alternative (Picovoice Porcupine, native trigger phrase).
    Defer until user demand is clear.
11. **Onboarding flow** — iOS goes auth → chat. A formal onboarding is
    nice-to-have.
12. **Hands-free continuous mode** — explicit doctrine call to keep iOS on
    push-to-talk. Do NOT port unless the doctrine is overturned.
13. **Admin / Developer / Publisher / Autonomy / Intents / Ops** — operator
    surfaces. Stay web-only by design.

## Notes on this audit

- Generated 2026-05-03. Will go stale fast — Deepgram migration on iOS will
  flip several voice rows from `partial` to `parity` once
  `codex/deepgram-migration-1` merges.
- One earlier mirroring effort already addressed chat-shell visual parity:
  [docs/notes/ios-mirror-web-1-progress-2026-05-01.md](ios-mirror-web-1-progress-2026-05-01.md).
  This audit is the broader functional parity counterpart.
- Open question worth resolving before Tier 2 starts: which web-only surfaces
  (admin, publisher, autonomy) should explicitly stay web-only? Decide once,
  document, and stop re-asking the question per feature.
