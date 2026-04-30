## Active lanes

| Lane | Worktree | Branch | Started | Sprint |
|---|---|---|---|---|
| Codex | Lumo_Super_Agent_codex | codex/compound-exec-2 | 2026-04-30 | COMPOUND-EXEC-2 compound transaction API + persistence layer |

## Closed lanes

| Lane | Worktree | Branch | Started | Closed | Sprint |
|---|---|---|---|---|---|
| Codex | Lumo_Super_Agent | codex/sample-agents-1 | 2026-04-28 | 2026-04-29 | SAMPLE-AGENTS sprint |
| Codex | Lumo_Super_Agent | codex/adr-017-draft | 2026-04-29 | 2026-04-29 | ADR-017 merchant-of-record agent track |
| Claude Code | Lumo_Super_Agent_claude_code | claude-code/ios-bootstrap | 2026-04-29 | 2026-04-29 | iOS bootstrap (monorepo + hello iOS) |
| Codex | Lumo_Super_Agent_codex | codex/perm-1-permissions-and-consent | 2026-04-29 | 2026-04-29 | PERM-1 permissions and consent |
| Claude Code | Lumo_Super_Agent_claude_code | claude-code/mobile-chat-1 | 2026-04-29 | 2026-04-29 | MOBILE-CHAT-1A foundation (auth/perf deferred to 1B) |
| Codex | Lumo_Super_Agent_codex | codex/marketplace-1-distribution | 2026-04-29 | 2026-04-29 | MARKETPLACE-1 distribution |
| Codex | Lumo_Super_Agent_codex | codex/cost-1-metering-budgets | 2026-04-29 | 2026-04-29 | COST-1 metering and budgets |
| Claude Code | Lumo_Super_Agent_claude_code | claude-code/mobile-chat-1b | 2026-04-29 | 2026-04-29 | MOBILE-CHAT-1B (auth, Settings, tests, perf, screenshots; dark-mode artifact deferred to MOBILE-POLISH-1) |
| Codex | Lumo_Super_Agent_codex | codex/dev-dash | 2026-04-29 | 2026-04-29 | DEV-DASH developer dashboard |
| Codex | Lumo_Super_Agent_codex | codex/trust-1-review-pipeline | 2026-04-29 | 2026-04-29 | TRUST-1 review pipeline |
| Claude Code | Lumo_Super_Agent_claude_code | claude-code/mobile-voice-1 | 2026-04-29 | 2026-04-29 | MOBILE-VOICE-1 native iOS voice path |
| Codex | Lumo_Super_Agent_codex | codex/docs | 2026-04-29 | 2026-04-30 | DOCS developer documentation site |
| Claude Code | Lumo_Super_Agent_claude_code | claude-code/mobile-payments-1 | 2026-04-30 | 2026-04-30 | MOBILE-PAYMENTS-1 iOS payment surface (Stripe SDK + biometric confirmation + receipts; MERCHANT-1 swap path documented) |
| Codex | Lumo_Super_Agent_codex | codex/merchant-1 | 2026-04-30 | 2026-04-30 | MERCHANT-1 merchant-of-record substrate (real Stripe SetupIntent + PaymentIntent + ECDSA device confirmation + webhook reconciliation) |
| Codex | Lumo_Super_Agent_codex | codex/perf-1-plus-2 | 2026-04-30 | 2026-04-30 | PERF-1+2 latency instrumentation, prompt caching, parallel pre-LLM loads, intent classifier (Groq + Cerebras failover), Haiku fast-path + Sonnet reasoning router, /admin/perf dashboard |
| Claude Code | Lumo_Super_Agent_claude_code | claude-code/mobile-notif-1 | 2026-04-30 | 2026-04-30 | MOBILE-NOTIF-1 iOS notifications + proactive moments (APNs + 4 categories + background fetch + in-app cards + Settings section); 3 follow-ups filed (MOBILE-NOTIF-2-INIT, LOCAL-NOTIF-REFINE, MOBILE-API-1-NAV-PLUMB) |
| Codex | Lumo_Super_Agent_codex | codex/mesh-1 | 2026-04-30 | 2026-04-30 | MESH-1 multi-agent orchestration substrate (supervisor + 4 sub-agents + dispatch planner) + Duffel flight agent (search/hold/book/cancel) + LUMO_USE_MESH feature flag |
| Claude Code | Lumo_Super_Agent_claude_code | claude-code/web-screens-1 | 2026-04-30 | 2026-04-30 | WEB-SCREENS-1 6 consumer web surfaces (trips, receipts, account, notif prefs, profile, settings index); 4 follow-ups filed (PAYMENTS-REFUND-1, NOTIF-PREFS-PERSIST-1, TRIPS-DETAIL-FAST-PATH-1, PROFILE-RICH-FIELDS-1) |
| Claude Code | Lumo_Super_Agent_claude_code | claude-code/mobile-chatgpt-ui-1 | 2026-04-30 | 2026-04-30 | MOBILE-CHATGPT-UI-1 iOS nav refactor (drop TabView → NavigationStack + side drawer ChatGPT-style); 2 follow-ups filed (MOBILE-SETTINGS-DEDUP-1, MOBILE-SCREENSHOT-MIGRATE-1) |
| Codex | Lumo_Super_Agent_codex | codex/compound-exec-1 | 2026-04-30 | 2026-04-30 | COMPOUND-EXEC-1 saga hardening + deterministic replay + SSE v2; COMPOUND-EXEC-2 follow-ups filed |

## Last push

- 2026-04-28 — shared harness, three samples, and CI wiring ready for full acceptance pass
- 2026-04-28 — acceptance gates passed; branch ready for reviewer handoff
- 2026-04-29 — SAMPLE-AGENTS reviewer approved; lane marked closed for main fast-forward
- 2026-04-29 — ADR-017 merchant-of-record draft merged to main after reviewer approval
- 2026-04-29 — worktree-aware lane format adopted; Codex moves to PERM-1 in `Lumo_Super_Agent_codex`
- 2026-04-29 — claude-code/ios-bootstrap ready for review: monorepo conversion + apps/ios/ SwiftUI scaffold + chat-stream impl + CI; web build and iOS build+tests both green
- 2026-04-29 — claude-code/ios-bootstrap merged to main; Claude Code moves to MOBILE-CHAT-1
- 2026-04-29 — PERM-1 migration 037 drafted and pushed for early schema review
- 2026-04-29 — PERM-1 merged to main after reviewer approval; Codex moves to MARKETPLACE-1
- 2026-04-29 — claude-code/mobile-chat-1 (1A foundation) merged to main; Claude Code queued for MOBILE-CHAT-1B
- 2026-04-29 — MARKETPLACE-1 backend midpoint pushed: schema, catalog library, submissions, bundle storage, yank endpoint, version-sync cron
- 2026-04-29 — MARKETPLACE-1 second half pushed: DB-backed browse/detail feed, PERM-1 install/uninstall wiring, submission/version tests; gates green
- 2026-04-29 — MARKETPLACE-1 merged to main; Codex queued for COST-1
- 2026-04-29 — claude-code/mobile-chat-1b opened from origin/main; auth + Settings + tests + perf + dark-mode fix + full screenshot pass underway
- 2026-04-29 — COST-1 middle layer drafted: cost library, dispatch budget gate, model-call ledger writes, daily/monthly digest crons
- 2026-04-29 — COST-1 dashboards and cost-core regression tests ready for full review; gates green locally
- 2026-04-29 — COST-1 merged to main; Codex queued for DEV-DASH
- 2026-04-29 — claude-code/mobile-chat-1b ready for review: 5 of 6 deliverable groups done (auth, Settings, 23 new tests bringing total to 34, cold-start 1443 ms / memory 32.9 MB, full light+dark screenshots); dark-mode artifact §5 unresolved with detailed investigation report — recommend MOBILE-POLISH-1 follow-up
- 2026-04-29 — MOBILE-CHAT-1B merged to main; Phase 5 mobile track at substrate-complete
- 2026-04-29 — claude-code/mobile-voice-1 opened from origin/main; Apple Speech STT + ElevenLabs Turbo TTS + push-to-talk composer in flight
- 2026-04-29 — claude-code/mobile-voice-1 ready for review: all 8 deliverable groups done (audio session, STT, TTS w/ ElevenLabs+system fallback, push-to-talk composer, chat voice-mode integration, Settings voice section, 23 new tests bringing total to 57, cold-start 813 ms / memory 35 MB, full light+dark screenshots incl voice-listening + voice-transcript states); ElevenLabs API key not committed to env (permission gate denial — instructions in progress note); end-of-speech-to-first-token latency probe plumbed but not measured E2E pending PERF-1
- 2026-04-29 — DEV-DASH branch opened; migration 040 drafted for early schema review
- 2026-04-29 — DEV-DASH backend checkpoint drafted: developer library, API routes, and metrics rollup cron
- 2026-04-29 — DEV-DASH UI and regression tests drafted for full review
- 2026-04-29 — DEV-DASH merged to main; Codex queued for TRUST-1
- 2026-04-29 — TRUST-1 branch opened; migration 041 drafted for early schema review
- 2026-04-29 — TRUST-1 signing and five-check pipeline drafted for mid-sprint review
- 2026-04-29 — TRUST-1 continuous health monitor drafted: 6h cron, demotion reviews, and P0 auto-kill path
- 2026-04-29 — TRUST-1 final review slice ready: signing verification, five-check pipeline, health monitor, and promotion/identity queue coverage; gates green locally
- 2026-04-29 — TRUST-1 merged to main; auto-publish path live for experimental tier; reviewer queue active for community/verified/official; 6h health monitor cron registered; Codex queued for DOCS
- 2026-04-29 — claude-code/mobile-voice-1 wrap-up cherry-picked onto main; voice lane closed; iOS path complete
- 2026-04-29 — DOCS branch opened; migration 042 drafted for early schema review
- 2026-04-29 — DOCS complete for review: Docusaurus site, Phase 4 developer guides, TypeDoc API reference, publish workflow, feedback digest, and quickstart tests; gates green locally
- 2026-04-30 — DOCS merged to main; Phase 4 SUBSTRATE COMPLETE — third-party agent SDK + marketplace + cost controls + permissions + dev dashboard + trust pipeline + developer documentation all shipped. Codex queued for Phase 4.5 kickoff.
- 2026-04-30 — SDK submit CLI executable-bit fix merged to main; Phase 4 closes with no known engineering bug tail. Codex queued for MERCHANT-1 kickoff.
- 2026-04-30 — claude-code/mobile-payments-1 opened from origin/main; Stripe SDK card-on-file + Apple Pay + biometric-confirmed transactions + local receipt history in flight (Stripe Test mode; MERCHANT-1 owns real-money execution)
- 2026-04-30 — claude-code/mobile-payments-1 ready for review: all 9 deliverable groups done (Stripe SDK + Apple Pay capability, PaymentService HTTP client, 5 backend stubs under /api/payments/*, BiometricConfirmationService w/ HMAC-SHA256 token shape, PaymentConfirmationCard state-machine modal, PaymentMethodsView w/ Test-mode banner + add-card sheet, ReceiptStore + history + detail views, 41 new tests bringing total to 98, 14 light+dark screenshots via PaymentsFixtureRoot); real Stripe PaymentSheet wired but inert in v1 (backend stubs don't issue real client_secrets — flips on with MERCHANT-1); Apple Pay simulator-limited
- 2026-04-30 — MOBILE-PAYMENTS-1 merged to main; iOS payment surface complete with explicit MERCHANT-1 swap path documented; Phase 5 iOS substrate complete.
- 2026-04-30 — claude-code/mobile-notif-1 opened from origin/main; APNs + 4 notification categories + background fetch + proactive-moments cards + Settings notifications section in flight (last iOS sprint independent of Phase 4.5 backend)
- 2026-04-30 — MERCHANT-1 branch opened; migration 043 drafted for early schema review
- 2026-04-30 — MERCHANT-1 full review slice ready: Stripe-backed payments routes, ECDSA confirmation keys, webhook reconciliation, merchant SDK contract, stub merchant sample, and regression tests; gates green locally
- 2026-04-30 — MERCHANT-1 merged to main; real Stripe-backed payment substrate live (SetupIntent + PaymentIntent + ECDSA device confirmation + webhook reconciliation); MOBILE-PAYMENTS-1.1 follow-up needed to swap iOS HMAC → ECDSA before production E2E. Codex queued for PERF-1+2.
- 2026-04-30 — PERF-1+2 branch opened; migration 044 drafted for early schema review
- 2026-04-30 — PERF-1+2 pre-routing checkpoint drafted: orchestrator timing spans, /admin/perf dashboard, Anthropic prompt caching, pre-LLM load parallelization, and first-token SSE streaming
- 2026-04-30 — PERF-1+2 model-routing checkpoint drafted: Groq intent classifier with Cerebras failover, Haiku fast/tool path router, Sonnet fallback, and perf-routing regression suite
- 2026-04-30 — PERF-1+2 merged to main; latency substrate live (per-phase spans + dashboard + prompt caching + parallel preloads + Groq/Cerebras intent classifier + Haiku/Sonnet model router); live p50 verification blocked until migrations 037-044 applied to staging Supabase. Codex queued for COMPOUND-EXEC-1.
- 2026-04-30 — claude-code/mobile-notif-1 ready for review: all 10 deliverable groups done (APNs entitlement + UIBackgroundModes + BGTaskSchedulerPermittedIdentifiers, NotificationService w/ device register+unregister, 5 backend stubs under /api/notifications/* and /api/proactive/*, 4 UNNotificationCategory definitions per Option A — payment-receipt has no dispute action, NotificationActionHandler with category × action routing + tab selection, BGTaskScheduler 4h cadence, ProactiveMomentsCache + ViewModel + in-app cards above chat composer, Settings notifications section w/ master + 4 categories + quiet-hours, 48 new tests bringing total to 146, 6 light+dark screenshots via NotificationsFixtureRoot); E2E APNs push delivery deferred until auth key + push sender ship (Phase 4.5); deep nav for notification taps lands tab selection but full plumb is MOBILE-API-1 work
- 2026-04-30 — MOBILE-NOTIF-1 merged to main; iOS notification surface complete (APNs + 4 categories + background fetch + proactive moments + Settings); 3 follow-ups filed (MOBILE-NOTIF-2-INIT app-delegate install timing, LOCAL-NOTIF-REFINE server-side double-notification flag, MOBILE-API-1-NAV-PLUMB deep-link receipt id + chat prefill). Claude Code queued for MOBILE-PAYMENTS-1.1 (HMAC → ECDSA biometric token swap; ~1 session of work).
- 2026-04-30 — MESH-1 branch opened; migration 045 drafted for sub-agent call ledger early schema review
- 2026-04-30 — MESH-1 ready for review: sub-agent call ledger, supervisor substrate, dispatch planner, Duffel test-mode flight agent, internal merchant-of-record flight tools, LUMO_USE_MESH feature flag, and Vegas-flight demo regression path; gates green locally (live Duffel/Stripe booking E2E blocked until staging migrations + Duffel env are applied).
- 2026-04-30 — COMPOUND-EXEC-1 branch opened; migration 046 drafted for compound transaction graph, dependency edges, and SSE v2 leg status event ledger early schema review.
- 2026-04-30 — COMPOUND-EXEC-1 migration 046 review fixes drafted: FK parity confirmed, missions dependency confirmed, cycle detection doctrine documented, leg_status_events.occurred_at rename applied; staging apply deferred until runner prerequisites land.
- 2026-04-30 — MESH-1 merged to main; multi-agent orchestration substrate live with Duffel flight agent as first proof-of-life. JARVIS demo path now functional in test mode (planner → sub-agent fan-out → Duffel offer projection). Codex queued for next sprint (TRAVEL-AGENT-2 Booking on partnership key, OR COMPOUND-EXEC-1 saga hardening).
- 2026-04-30 — claude-code/web-screens-1 opened from origin/main; audit doc proposed 6 consumer-screen gaps (trips, receipts, account, notif prefs, profile, settings index) with 5 open scope questions resolved by reviewer; build phase in flight.
- 2026-04-30 — claude-code/web-screens-1 ready for review: all 6 audit gaps built (trips + receipts + /settings/account + /settings/notifications + /profile + /settings index), middleware gates added for /trips /receipts /profile /settings + /api/trips /api/receipts, header avatar repointed /memory → /settings/account, MobileNav + LeftRail wired, lib/transactions.ts (real reader against MERCHANT-1 transactions), in-memory STUBs for refund POST + notification prefs (NOTIF-PREFS-PERSIST-1 backlog filed), 36 new tests across 6 web-screens-* suites (total 8 routes, ~2000 LOC). All gates green (typecheck/lint/lint:registry/lint:commits/build/test); credential sweep clean.
- 2026-04-30 — WEB-SCREENS-1 merged to main (rebased onto current origin/main due to MESH divergence; STATUS.md + apps/web/package.json conflicts resolved cleanly, force-with-lease push, FF-merge from canonical worktree). 6 consumer web surfaces live; 4 follow-ups filed (PAYMENTS-REFUND-1, NOTIF-PREFS-PERSIST-1, TRIPS-DETAIL-FAST-PATH-1, PROFILE-RICH-FIELDS-1). Both lanes idle; Codex queued for next sprint (recommend COMPOUND-EXEC-1), Claude Code awaits next sprint kickoff.
- 2026-04-30 — claude-code/mobile-chatgpt-ui-1 opened from origin/main; iOS nav refactor (ChatGPT-style chat + side drawer, drop TabView) in flight.
- 2026-04-30 — claude-code/mobile-chatgpt-ui-1 ready for review: all 10 deliverables shipped (RootView TabView → NavigationStack pivot, SideDrawerView w/ recents + 4 destinations + sign-out, BurgerMenuButton, ProfileView w/ ProfileSettings store, ReceiptDetailLookupView for notification deep-links, NotificationRouteResolver pure mapping, ChatViewModel.reset for "New Chat", chat empty-state polish — sparkles + "How can I help today?", DEBUG launch args for screenshot fixtures, 8 light+dark shots). 38 new tests across 4 LumoTests bundles (SideDrawerView, BurgerMenuToggle, ChatRootView, ProfileSettings) bringing total to 184; xcodebuild test green on iPhone 17 simulator. NotificationActionHandler routing rewritten to push onto chat NavigationStack instead of switching tabs; openAlertsCenter lands on Settings (no dedicated alerts surface today).
- 2026-04-30 — claude-code/mobile-chatgpt-ui-1 → main (FF), MOBILE-CHATGPT-UI-1 closed. 2 follow-ups filed (MOBILE-SETTINGS-DEDUP-1 drop inline Sign Out from SettingsView; MOBILE-SCREENSHOT-MIGRATE-1 migrate legacy capture variants from -LumoStartTab to -LumoStartDestination). scripts/apply-staging-migrations.sh stayed untracked on the feature branch — confirmed not part of any sprint. Both lanes idle.
- 2026-04-30 — COMPOUND-EXEC-1 ready for review: migration 046 compound graph substrate, deterministic saga replay, SDK compensationAction enforcement, SSE v2 leg-status frames, compound graph runner with reverse-topological rollback, stub-3-leg-trip sample, and regression suite covering graph cycles + rollback failure modes. Gates green locally; live staging E2E blocked until migrations 037-046 are applied.
- 2026-04-30 — codex/compound-exec-1 → main (FF), COMPOUND-EXEC-1 closed. COMPOUND-EXEC-2 scope filed: production dependency INSERT must validate via replayCompoundTransaction first; DB snapshot loader must read leg_status_events ordered by occurred_at asc, id asc; stub-3-leg-trip needs a runnable demo entry that drives runCompoundGraph/API end-to-end.
- 2026-04-30 — COMPOUND-EXEC-2 branch opened; migration 046 applied to staging Supabase and zero-row verification passed for compound_transactions, compound_transaction_dependencies, leg_status_events, and compound-linked transactions.
