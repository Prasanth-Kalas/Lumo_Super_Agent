## Active lanes

| Lane | Worktree | Branch | Started | Sprint |
|---|---|---|---|---|
| Claude Code | Lumo_Super_Agent_claude_code | claude-code/mobile-notif-1 | 2026-04-30 | MOBILE-NOTIF-1 iOS notifications + proactive moments (APNs + 4 categories + background fetch + in-app cards) |
| Codex | Lumo_Super_Agent_codex | codex/merchant-1 | 2026-04-30 | MERCHANT-1 merchant-of-record substrate |

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
