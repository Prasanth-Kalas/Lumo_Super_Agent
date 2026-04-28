# Lumo JARVIS — Master Product Spec & Build Plan

**Status:** Roadmap draft, written during Kalas-Cowork session 2026-04-29, pending Kalas seal.
**Author:** Claude (Cowork session), reviewed by Kalas.
**Audience:** Codex (primary backend / runtime / agent engineer), Claude Code (primary frontend / mobile / UX engineer), Kalas (CEO + reviewer of strategic decisions), Cowork-Claude (reviewer of every direct-to-main push).
**Supersedes:** Nothing. Sits alongside `phase-4-master.md` and the seven Sprint 4 specs as the long-horizon plan they ladder into.

---

## 1. Vision

Lumo is a **conversational composition layer for consumer services**. Today, accomplishing a multi-step real-world goal — booking a Vegas trip, ordering dinner for a dinner party, planning a weekend — requires the user to install multiple apps, create multiple accounts, hold the orchestration in their own head, and tap through dozens of screens. Lumo collapses that to a single voice-or-chat conversation with one app and one account.

Concretely:

> **User:** "Plan me a Vegas trip, May 5–12, solo, around $2k all-in."
>
> **Lumo:** *(checks calendar, knows user lives in NYC, knows preference for aisle seats)* "JFK→LAS Mon morning, aisle, $340 round-trip. Cosmopolitan for $215/night × 7 = $1,505. Uber to/from for ~$80. Total $1,925. Want me to book it?"
>
> **User:** "Yes, but make Tuesday morning instead of Monday."
>
> **Lumo:** "Done. Tue morning JFK→LAS, $355. New total $1,940. Booking now." *(executes flight + hotel + ground; surfaces confirmations; drops tickets in Apple/Google Wallet)*

The user installed one app (Lumo). The user has one account (Lumo). The agents that booked the flight, hotel, and ground transport are inside Lumo, dispatched dynamically based on the request. The user never had to know Skyscanner, Booking.com, or Uber existed.

That is the JARVIS-level consumer unlock. It's a defensible product because:
- **Time compression.** A 30-minute, three-app workflow becomes a two-minute conversation.
- **Trust transfer.** The user trusts Lumo once instead of evaluating every new service.
- **Cross-domain intelligence.** Lumo knows the user across categories — flight preferences inform hotel suggestions inform restaurant picks.
- **Mobile-first form factor.** Most consumer flows happen on phones. Lumo lives where the user is.

---

## 2. The architectural thesis in one paragraph

A native mobile app provides the conversational surface and ambient context. A cloud orchestrator runs the agents and holds the state. Some operations run on-device for sub-second latency (wake word, STT, intent classification, semantic cache). Most operations run in the cloud (reasoning, agent dispatch, payment execution). Agents come in two flavors: **OAuth-as-user** agents (for enterprise tools like Slack/Gmail where the user has their own account) and **Merchant-of-Record** agents (for consumer services like flights/hotels/food where Lumo holds the B2B relationship and books on the user's behalf). Money-moving actions go through a typed confirmation gate with budget caps, biometric confirmation on mobile, and a saga/rollback layer for compound transactions.

---

## 3. Product architecture overview

### Surfaces

- **Mobile app (iOS + Android)** — primary consumer surface. Voice + chat UI, push notifications, wallet integration, biometric confirmation. Phase 5 deliverable.
- **Web app (existing)** — Lumo Super Agent at lumo.rentals (current). Stays alive for desktop usage and developer/admin surfaces. Web stays cloud-rendered (Next.js on Vercel).
- **Voice-only mode** — eventual: CarPlay, AirPods-only, smart speakers. Phase 7+.

### Backend

- **Orchestrator** (existing, `lib/orchestrator.ts`) — dispatches user turns through intent classification → memory retrieval → agent selection → tool-use loop → response streaming.
- **Agent runtime** (Phase 4 SDK) — third-party developers build agents; agents run in sandboxed environments (E2B for untrusted, in-process for trusted).
- **Marketplace** (Phase 4) — user-facing agent discovery + install + permissions.
- **Trust + permissions** (Phase 4) — PERM-1 consent UI, TRUST-1 review pipeline, COST-1 budget enforcement.
- **Merchant-of-record substrate** (Phase 4.5, new) — Lumo as transactional intermediary; Stripe Issuing for card-on-file; transaction ledger.
- **Compound transaction engine** (Phase 4.5 + 5) — saga/rollback for multi-leg bookings, compound confirmation cards.

### Data

- **Supabase Postgres** — primary store. RLS for tenancy. Existing.
- **Redis (Upstash)** — hot-path cache (memory, semantic cache, rate limits). Phase 5 add.
- **Vector store** — embeddings for semantic cache + memory retrieval. Phase 5 add.
- **Object storage** — agent bundles, user uploads, transaction artifacts (receipts, confirmations).

### Inference

- **Sonnet 4.6 (Anthropic)** — primary reasoning model.
- **Haiku 4.5 (Anthropic)** — fast-path turns, sub-agent tasks.
- **Groq Llama 3.3 8B or similar** — sub-100ms intent classification + small-task sub-agents (Phase 5 add).
- **OpenAI GPT-5 / o-series** — failover, second-opinion, multi-provider resilience.
- **On-device small models** (mobile, Phase 5+) — wake word, STT, intent triage when network is unavailable or cost-sensitive.

---

## 4. Working agreement — Codex × Claude Code × Cowork-Claude

### Lane assignment

**Codex (Lane A)** owns **backend, runtime, agents, infrastructure**:
- Orchestrator changes
- Agent SDK and runtime
- Marketplace backend + admin surfaces
- Database migrations
- Third-party provider integrations (Duffel, Stripe, etc.)
- Permissions, trust, cost enforcement
- Performance instrumentation + optimization
- Voice backend (STT pipelines, TTS pipelines)
- Cron jobs, background workers

**Claude Code (Lane B)** owns **frontend, mobile app, UX, design implementation**:
- React Native mobile app (iOS + Android), all sprints
- Web frontend components and pages (when not in lane A)
- Voice frontend UX (push-to-talk, ambient, response rendering)
- Payment confirmation UX
- Notification UX
- Wallet pass generation UI
- Animations, haptics, accessibility, internationalization
- Design system + component library

**Cowork-Claude (reviewer)**:
- Reviews every direct-to-main push from both lanes
- Validates against spec, security, correctness, test coverage, docs
- Owns architectural decisions and ADRs
- Coordinates cross-lane API contracts
- Owns this roadmap and updates it as reality shifts

### Branch + push protocol

Per `phase-4-master.md` and the Phase 4 sprint specs — restated for both lanes:

- All work on feature branches: `codex/<sprint-id>` and `claude-code/<sprint-id>`. Never commit on `main`.
- `STATUS.md` at repo root tracks active lanes; both lanes update on every push.
- Pre-flight on every session: `git status --porcelain` clean, current branch matches the active sprint.
- Acceptance gates self-pass before requesting review.
- Reviewer ping: branch name, commit list, diff summary, gate-checklist.
- On reviewer approval: fast-forward main locally, push.
- No GitHub PR ceremony. The branch + acceptance gates ARE the gate.

### Cross-lane integration

When a sprint touches both lanes (most Phase 5+ sprints do):
- Lane A defines the API contract first (TypeScript types + OpenAPI / handler signatures), pushes the contract spec to a shared `docs/contracts/` folder, pings lane B.
- Lane B codes against the contract spec immediately; doesn't wait for the impl.
- Lane A ships the impl in parallel.
- Both lanes write integration tests against the contract.
- Lanes converge on a shared integration-test pass before either requests final review.

### Conflict resolution

If lanes disagree on a contract or scope: Cowork-Claude arbitrates. If Cowork-Claude can't decide because it's a strategic call, Kalas decides.

---

## 5. The phase plan

### Phase 4 — Third-party agent substrate (in flight, ~3-4 weeks remaining)

**Goal:** developers can build, submit, get reviewed, and publish agents to the Lumo marketplace; users can discover, install, consent, and run them with cost caps and trust tiers.

**Status:** Specs landed on main (commit `02733e1` and earlier). Codex executing SAMPLE-AGENTS as Lane 1. Following sprints sequenced per `phase-4-master.md`.

**Lane assignment for the remainder of Phase 4:** Codex only. Don't fragment in-flight work. Claude Code joins for Phase 4.5.

**Phase 4 exit criteria:**
- All seven sprints (SAMPLE-AGENTS, PERM-1, MARKETPLACE-1, COST-1, DEV-DASH, TRUST-1, DOCS) shipped to main.
- A non-Lumo developer can follow the docs at `docs.lumo.rentals/agents`, build a sample agent, submit it, get it reviewed, and have it install in a real user's workspace.
- The three SAMPLE-AGENTS reference agents work end-to-end as smoke tests.

---

### Phase 4.5 — Merchant-of-Record bridge (3-4 weeks)

**Goal:** Lumo can be the merchant-of-record for transactions executed by agents on the user's behalf. The substrate that turns Lumo from a tool-orchestrator into a service-orchestrator.

**Why this phase exists:** the Phase 4 SDK assumes OAuth-as-user (the user has accounts on the underlying services). The consumer JARVIS vision requires merchant-of-record (Lumo holds B2B relationships, books on user's behalf). This phase adds the parallel substrate.

**Lane A (Codex) sprints:**

- **ADR-017 — Merchant-of-Record Agent Track.** Architectural decision record. Defines the second agent class, the credential model, the transaction ledger, the chargeback/refund flow, the audit semantics. Mirrors ADR-013/015 for the new track.
- **Sprint MERCHANT-1 — Substrate.**
  - `merchant_credentials` table (provider, credential type, scope, owner=Lumo).
  - `transactions` table with idempotency keys, status state machine, refund linkage.
  - Stripe integration: payment-method-on-file via Stripe Payment Methods + SetupIntents; charges via PaymentIntents; refunds; webhooks for async events.
  - Provider-credential vault (encrypted at rest, accessed via signed scoped tokens).
  - Merchant-of-record agent base class in the SDK (extends the Phase 4 agent class with `executeTransaction()`, `refund()`, `getTransactionStatus()` methods).
  - Webhook handler routing for Stripe events.
  - Stub merchant agent: `stub-merchant-1` that books a fake reservation and charges $1 for E2E testing.
- **Sprint COMPOUND-EXEC-1 (backend) — Saga hardening.**
  - Hardens the existing `lib/saga.js` with deterministic-replay semantics.
  - Adds compensation-action registration to the agent SDK (every transactional capability declares its rollback).
  - Adds `compound_transactions` table tracking the graph state (legs, dependencies, status, rollback decisions).
  - SSE protocol v2 for `leg_status` frames with structured payloads (replaces current ad-hoc shape).
  - Failure-mode tests: leg 2 fails after leg 1 commits → rollback triggers correctly; leg 3 timeout → user sees options (retry / skip / abort).

**Lane B (Claude Code) sprints:**

- **Sprint COMPOUND-UX-1 (frontend) — Trip confirmation card production hardening.**
  - Web: harden the existing `TripConfirmationCard` component with the new SSE v2 protocol.
  - Live execution view: show legs as they progress (pending → in-flight → confirmed / failed → rolled-back).
  - Error recovery UX: when a leg fails mid-flight, present user with structured choices (retry / skip / abort whole trip).
  - Animations + state transitions polished.
- **Sprint PAYMENTS-UX-1 — Payment-method management (web).**
  - User adds a card via Stripe Elements.
  - Card-on-file management page (list, set default, remove, expiration warnings).
  - Receipt center: every transaction with line-item breakdown, downloadable PDF receipts.
  - Refund/dispute initiation flow (calls into Lane A's MERCHANT-1 backend).
- **Sprint AGENT-DETAIL-V2 — Rich agent profile pages (web).**
  - Per-agent detail page showing capabilities, cost model, trust tier, install count, reviews.
  - The "what can this agent actually do for me" surface that consumers will need to evaluate agents in Phase 5+.

**Cross-lane integration:**
- Lane A defines the SSE v2 leg_status protocol in `docs/contracts/leg-status-v2.md` by end of Week 1.
- Lane A defines the transaction API contract in `docs/contracts/transactions-api.md` by end of Week 1.
- Lane B codes against both from Week 2.

**Phase 4.5 exit criteria:**
- A merchant-of-record agent can be built using the SDK extension, register a Stripe-backed payment flow, execute a real transaction in test mode, get charged via Lumo's Stripe account, and produce a receipt the user can see.
- Compound transaction (3-leg saga) can be defined, executed, partially-failed, and correctly rolled back, with the user seeing the right status throughout.
- All web payment flows are PCI-DSS-aware (Stripe Elements handles the card data; Lumo never touches raw card numbers).

---

### Phase 5 — Consumer JARVIS launch, iOS-first (10-14 weeks)

**Goal:** a consumer downloads Lumo on their **iPhone**, signs up, and within their first session can plan and book a real Vegas trip end-to-end via voice or chat.

**This is the marquee phase.** It ships the iOS app (Swift + SwiftUI, native — not React Native, not Flutter), the first three flagship consumer agents (flights, hotels, ground transport), the performance work that makes the app feel JARVIS-level, and the proactive intelligence layer.

**Native-iOS-first decision (confirmed Kalas, 2026-04-29):** Phase 5 ships iOS native only. Android native lands in Phase 5.5 (~6 weeks after Phase 5 exit). Reasoning in the roadmap revision log: AI coding agents make the two-codebase cost of native much cheaper than for human teams, and native gives best-in-class polish + first access to Apple Intelligence, Wallet, voice, and ambient APIs that JARVIS-level positioning depends on. iOS-first because US/EU iOS share + LTV justifies the sequencing, and TestFlight is the best closed-beta tool in the industry for Phase 5 validation.

#### Lane A (Codex) — Backend / Agents

- **Sprint TRAVEL-AGENT-1 — Flight agent (Duffel).**
  - Implementation against Duffel's API (assumes Kalas has the partnership in place per the BD track).
  - Capabilities: search, hold, book, change, cancel, refund.
  - Cost-model declaration per the Phase 4 SDK conventions.
  - Trust tier: `official` (Lumo-built, signed with Lumo's key).
  - Eval suite: 50 synthetic flight searches with known-good responses; tests for edge cases (no inventory, multi-stop, international).
- **Sprint TRAVEL-AGENT-2 — Hotel agent.**
  - Implementation against Booking.com Affiliate Partner API or Expedia Partner Solutions (whichever Kalas closes first).
  - Capabilities: search, hold, book, modify, cancel.
  - Eval suite: 50 hotel searches with location + date + guest variations.
- **Sprint TRAVEL-AGENT-3 — Ground transport agent.**
  - Implementation against Uber for Business API (partnership-dependent) plus Lyft Business as fallback.
  - Capabilities: estimate, schedule, modify, cancel.
  - Bonus: handle airport pickup specifically (terminal selection, flight tracking integration).
- **Sprint COMPOUND-EXEC-2 — Cross-agent trip orchestration.**
  - The "graph mode" of compound execution: a trip is a DAG of leg-bookings with dependencies (hotel needs destination from flight; cab needs arrival time from flight).
  - Trip-level optimization: alternative routings if one leg unavailable (different airport → different hotel area).
  - User-level personalization: load user travel preferences (aisle, hotel chain loyalty, ride-share preference) and bias selections.
- **Sprint MOBILE-API-1 — Mobile-optimized API surface.**
  - Push notifications via APNs (iOS) and FCM (Android).
  - Wallet pass generation: Apple Wallet `.pkpass` and Google Wallet equivalents for flight tickets, hotel confirmations, restaurant reservations.
  - Biometric-backed confirmation tokens (mobile sends a Face-ID / Touch-ID signed token; backend verifies via attestation).
  - Background-fetch endpoints (lightweight status check + delta sync).
  - Mobile-specific session management (long-lived refresh tokens, device fingerprinting).
- **Sprint PERF-1 — Performance baseline + first wins.**
  - Timing instrumentation across the orchestrator (per-phase spans → `agent_request_timings` table).
  - `/admin/perf` p50/p95/p99 dashboard.
  - Wire prompt caching on the stable system-prompt prefix.
  - Parallelize pre-LLM data loads (`Promise.all` the Supabase queries).
  - Confirm UI streaming reaches client from first token.
  - Target: cut p50 latency from 6-8s to 2-3s for cloud turns.
- **Sprint PERF-2 — Intent classifier + model routing.**
  - Add a Groq Llama 3.3 8B (or Cerebras equivalent) intent classifier as the first step of every turn.
  - Route ~30-40% of turns to a Haiku-only fast path (no tools, no orchestration).
  - Target: <800ms p50 on the fast-path bucket.
- **Sprint PERF-3 — Lazy registry + semantic cache.**
  - Lazy-load capability schemas (only inject when Claude requests the tool).
  - Semantic cache for repeated queries: embed user turn, look up by cosine similarity, replay with paraphrase via Haiku.
  - Target: <300ms responses on the 10-15% of repeat traffic; 30-50% input-token reduction overall.
- **Sprint PROACTIVE-V2 — JARVIS-grade anticipation.**
  - Builds on existing `phase3-bandit-arms` and `proactive-moments` work.
  - Concrete proactive triggers for travel: "It's been 4 months since your last trip — want to plan something?", "Flight Saturday — want me to suggest packing list?", "Long weekend coming up — explore options?".
  - Per-user proactive frequency calibration (don't be annoying).

#### Lane B (Claude Code) — iOS App + UX (native, Swift + SwiftUI)

- **Sprint MOBILE-CHAT-1 — App skeleton + chat UI.**
  - Swift + SwiftUI, iOS 17+ deployment target, Xcode 15+.
  - `xcodegen` for declarative project generation (so the .xcodeproj is regenerable from `project.yml` and AI agents can manage it without UI drift).
  - Auth flow: email + Apple / Google sign-in, biometric unlock for return sessions.
  - Chat UI: message list, streaming response rendering, typing indicators, error states.
  - Bottom tab nav: Chat / Trips / Settings.
  - Theme + design tokens shared with web (single source of truth).
  - Cold-start budget: <1.5s to interactive on iPhone 13 / Pixel 7.
- **Sprint MOBILE-VOICE-1 — Voice path.**
  - Push-to-talk button (large, thumbable, in chat composer).
  - Long-press for hold-to-talk; tap for dictate-and-send.
  - On-device STT via Apple Speech / Google Speech (system APIs first; consider Whisper.cpp for cross-platform consistency in a follow-up).
  - Streaming TTS for responses (Cartesia, ElevenLabs Turbo, or OpenAI Realtime — provider TBD; pick one with sub-200ms TTFT).
  - Wake word ("Hey Lumo") deferred to Phase 7; v1 is push-to-talk.
  - Latency budget: <500ms from end-of-speech to first response token rendered.
- **Sprint MOBILE-PAYMENTS-1 — Payment onboarding + biometric confirmation.**
  - Card-on-file via Stripe SDK (uses Apple/Google Pay where available — fastest path to first transaction).
  - Per-transaction confirmation: shows trip plan + total → user does Face-ID / Touch-ID → backend gets signed confirmation token → executes.
  - Receipt rendering and history.
  - Refund initiation UX.
- **Sprint MOBILE-NOTIF-1 — Push + background fetch + proactive surface.**
  - APNs / FCM setup + token registration.
  - Notification categories: trip-update, proactive-suggestion, payment-receipt, alert.
  - Notification action support (confirm/cancel directly from notification without opening app).
  - Background fetch for proactive suggestions on session boundaries.
  - In-app proactive moments surface (the dismissable cards that suggest "you have a 3-day weekend coming up").
- **Sprint MOBILE-TRIP-1 — Compound trip flow on mobile.**
  - Native rendering of `TripConfirmationCard` (the v2 from Phase 4.5).
  - Live execution view: animated leg progress.
  - Wallet integration: tap to add ticket / hotel confirmation to Apple/Google Wallet.
  - Trip detail page: itinerary view, modifications flow, cancellation, day-of-travel mode.
- **Sprint MOBILE-POLISH-1 — Animations, haptics, accessibility, tablet.**
  - Haptic feedback on confirmations, errors, completions (calibrated, not noisy).
  - Reduced-motion mode.
  - VoiceOver / TalkBack labels on every interactive element.
  - Dynamic type / accessibility text scaling.
  - iPad / Android tablet layouts (landscape, multi-column where it makes sense).
  - Empty states, error states, offline mode, loading skeletons.

#### Cross-lane integration in Phase 5

Each Lane A sprint with a mobile counterpart in Lane B has a contract spec landed in `docs/contracts/` first. Integration tests pass before either lane requests review. The biggest cross-lane sprint is **MOBILE-TRIP-1 ↔ COMPOUND-EXEC-2 ↔ TRAVEL-AGENT-{1,2,3}** — these need to converge on a single E2E demo: "user says Vegas trip in voice → mobile app shows compound card → user Face-IDs → all three agents execute → receipts in wallet → push notifications confirm." That E2E demo is the Phase 5 ship gate.

#### Phase 5 exit criteria

- iOS app in TestFlight, Android app in internal testing track. Both pass internal QA.
- A Lumo employee can, on a clean phone with no accounts, install the app, sign up, say "Plan a Vegas trip for me May 5-12, around $2k all-in," and complete a full booking with one Face-ID confirmation. All three legs (flight, hotel, ground) book via the merchant-of-record path. Receipts arrive in app + email + wallet. Push notifications fire on each booking confirmation.
- p50 latency for fast-path turns under 800ms; p50 for orchestration turns under 3s.
- Crash-free session rate > 99.5%.
- App store readiness (screenshots, privacy policy, app store listings) complete.

---

### Phase 5.5 — Android port (~6 weeks)

**Goal:** ship the Android equivalent of the iOS Phase 5 app, native (Kotlin + Jetpack Compose), feature-parity with the Phase 5 iOS surface. Both platforms reach the public app stores together at end of 5.5.

**Lane A (Codex):** mobile-API-1 surface already supports Android — minimal backend additions (FCM specifics, Google Wallet pass formats).

**Lane B (Claude Code):** ports each Phase 5 mobile sprint (CHAT, VOICE, PAYMENTS, NOTIF, TRIP, POLISH) to Android native. Same product surface, different platform implementation. Sprints become ANDROID-CHAT-1, ANDROID-VOICE-1, etc.

**Phase 5.5 exit criteria:** Android app in Google Play internal testing with parity to iOS Phase 5 features. Both apps approved for public release. Cross-platform feature flag system in place so future sprints can ship to one platform first.

---

### Phase 6 — Catalog expansion (rolling, 12+ weeks)

**Goal:** expand from "Vegas trip" to "any consumer service Lumo's user might want." Each new agent category is a separate sprint pair; categories are added in priority order based on user demand and partnership availability.

**Lane A (Codex) — New agents per category, one sprint each:**

- **FOOD-AGENT-1** — DoorDash / UberEats integration for food delivery.
- **DINING-AGENT-1** — OpenTable / Resy for reservations.
- **GROCERY-AGENT-1** — Instacart for grocery delivery.
- **SHOPPING-AGENT-1** — Amazon affiliate for general shopping.
- **ENTERTAINMENT-AGENT-1** — Ticketmaster / StubHub for events.
- **MOVIES-AGENT-1** — Fandango / AMC for movie tickets.
- **RIDESHARE-AGENT-2** — broaden ground transport beyond Uber For Business (consumer Uber + Lyft).
- **HEALTH-AGENT-1** — Zocdoc for appointment booking.
- **HOME-SERVICES-AGENT-1** — Thumbtack / TaskRabbit for handyman / cleaning.
- **AGENT-DISCOVERY-V2** — semantic intent → agent matching (Lumo automatically picks the right agent for a request without the user specifying).

**Lane B (Claude Code) — Mobile UX per category:**

- Category-specific browse/select UX where conversation isn't enough (food menu rendering, event seat selection, restaurant time picker).
- Personalization surfaces (favorites, quick-reorders, dietary preferences).
- Cross-agent compound flows: "plan my Saturday: brunch reservation + matinee movie + grocery delivery for tonight" → single conversation, three agents, one confirmation card.
- Reviews / ratings / history per category.

**Phase 6 cadence:** add a category every 2-3 weeks. Pace is gated by partnerships (Kalas's track) more than engineering. After 4-6 categories, the agent-discovery improvements (AGENT-DISCOVERY-V2) become the unlock that makes the catalog feel coherent rather than a list.

**Phase 6 exit criteria:** open-ended. Phase 6 transitions into business-as-usual product iteration around month 6 of Phase 6.

---

### Phase 7 — JARVIS-level qualities (ongoing, starts in parallel with Phase 6)

**Goal:** the qualitative differentiation that makes Lumo *feel* like JARVIS, not "fast chatbot with agents."

**Lane A (Codex):**

- **ANTICIPATE-1** — predictive pre-fetch: kick off agent calls speculatively based on intent classifier, so by the time user says "yes," results are already warm.
- **MEMORY-CONTINUITY-1** — long-horizon memory hardening. Goal: 80%+ recall of relevant facts surfaced 14 days later. Observability + manual eval suite.
- **MULTI-AGENT-MESH-1** — the architectural shift from "single Sonnet orchestrator with tools" to "JARVIS supervisor + parallel sub-agents with model routing." Each pre-LLM step (intent, memory, ranking, tool-plan) becomes a parallel sub-agent on its own model. Net: JARVIS-tier latency profile.
- **OBSERVABILITY-1** — full agent-execution tracing (Langfuse / Helicone-class). Per-turn cost, latency, sub-agent breakdown. Prerequisite for serious perf optimization at scale.
- **CROSS-DEVICE-HANDOFF-1** — start a conversation on phone, continue on desktop. Real-time session sync via WebSockets / Supabase Realtime.

**Lane B (Claude Code):**

- **PROACTIVE-MOBILE-V2** — morning briefing surface, evening summary, trip-day mode (the day you fly, the chat opens to your itinerary).
- **VOICE-ONLY-MODE** — CarPlay support, AirPods-only mode, lock-screen voice activation.
- **WALLET-DEEP-1** — deep Apple Wallet / Google Wallet integration. Boarding pass live updates. Hotel digital key where supported.
- **AMBIENT-CONTEXT-1 (mobile)** — calendar awareness, location awareness (with consent), photo-library awareness for travel inspiration.
- **WEARABLE-1** — Apple Watch app for quick voice + status; Android Wear equivalent.

**Phase 7 cadence:** continuous. Each sprint is independent and can be slotted in as bandwidth allows. Don't try to ship all of Phase 7 in a quarter; pick the 2-3 highest-leverage items per quarter based on user feedback.

---

## 6. Cross-cutting concerns

### Performance budgets (per phase)

| Phase | p50 fast-path turn | p50 orchestration turn | p99 |
|---|---|---|---|
| 4 (current) | 6-8s (broken) | 6-8s (broken) | 12s |
| 4.5 (target) | 5s | 7s | 10s |
| 5 (target after PERF-1/2/3) | <800ms | <3s | <6s |
| 7 (target after MULTI-AGENT-MESH-1) | <400ms | <2s | <4s |

Performance work is woven into Phase 5 (PERF-1, PERF-2, PERF-3) and Phase 7 (MULTI-AGENT-MESH-1). It is not a separate phase. It is a budget tracked sprint-by-sprint.

### Security + compliance

- **PCI-DSS:** Stripe handles raw card data. Lumo is PCI-DSS SAQ A (the simplest tier) provided we never touch card data outside Stripe Elements / Apple-Pay / Google-Pay. Do not deviate from this.
- **GDPR + CCPA:** existing surface. Phase 5 adds mobile-specific concerns (location data, voice recordings if cached for any reason). Voice should default to no-server-side-storage; transcripts only.
- **App store compliance:** Phase 5 mobile work needs Apple App Store + Google Play review readiness. Allocate a week of buffer per platform for review iterations.
- **Travel agent licensing:** ARC/IATA accreditation is on Kalas's BD track; engineering surface is to make sure the merchant-of-record substrate captures the data needed (booking source, ticket number, IATA tour code if applicable).
- **Money transmission:** if Lumo ever holds user funds (escrow, gift cards, refund credits), money transmitter licensing becomes a real concern in many US states. Avoid this in Phase 5/6; everything routes through Stripe synchronously.

### Observability

- **Sentry** — error tracking, web + mobile.
- **Langfuse or Helicone** — LLM call tracing, cost, latency, prompt diffing.
- **Datadog or Better Stack** — infra metrics, logs.
- **Mixpanel or PostHog** — product analytics, funnel analysis.
- **Custom `agent_request_timings` table** — per-phase orchestrator span timing (Phase 5 PERF-1 deliverable).

Set up the observability stack BEFORE Phase 5 mobile launch. Measuring after the fact is too late.

### Internationalization

- Phase 5: en-US only. Hardcode where you can, but use `i18next` patterns for strings so future i18n is mechanical, not architectural.
- Phase 6+: add languages where the agent partnerships support them.

---

## 7. Risk register

| Risk | Severity | Mitigation |
|---|---|---|
| Travel partnership slips (Duffel / Booking / Uber not closed in time for Phase 5) | High | Phase 5 sequencing — agents block on partnerships. Have a stub-agent fallback that uses search-only mode (no booking) to keep the demo path alive. |
| App store review rejects the merchant-of-record model | Medium | Engage Apple/Google early. The model is similar to what Booking.com / Expedia apps already do; precedent exists. Privacy nutrition labels need careful writing. |
| Phase 4.5 saga hardening discovers latent bugs in existing `lib/saga.js` | Medium | Allocate buffer in Phase 4.5 for refactor. The existing saga code is functional; tests will tell us how production-ready. |
| Voice latency (sub-500ms) not achievable with cloud STT round trip | Medium | Plan B: on-device STT via system APIs (Apple Speech / Google Speech). Plan C: hybrid (on-device for short utterances, cloud for long). |
| Multi-provider model routing introduces failure modes (Groq down → fallback to Anthropic adds latency) | Medium | Treat Groq as latency optimization only; never as critical path. Anthropic is always reachable. |
| Cost explosion as catalog expands (more agents = more parallel inference per turn) | Medium | Sprint COST-1 (Phase 4) gives us per-user budget enforcement. Add per-org cost dashboards in Phase 6. |
| Mobile app crashes leak into production (inevitable in v1) | High | Crashlytics + Sentry mobile from Day 1 of Phase 5. Staged rollout (5% → 25% → 100%). |
| Lane coordination breaks down (Codex and Claude Code stepping on each other) | Medium | The contract-first protocol in §4 and the STATUS.md discipline. Cowork-Claude actively monitors STATUS.md and arbitrates conflicts. |

---

## 8. The first week — what each lane starts on Monday

### Codex (Lane A) — Monday of Week 1

- Confirm SAMPLE-AGENTS sprint completion status. If still in flight, finish first.
- If SAMPLE-AGENTS shipped: open Sprint PERM-1 per `sprint-4-perm-1-permissions-and-consent.md`. Branch `codex/perm-1`. STATUS.md update.
- In parallel, start drafting ADR-017 (Merchant-of-Record Agent Track) on a separate branch `codex/adr-017-draft`. Time-box to 2 days; ping reviewer when ready.

### Claude Code (Lane B) — Monday of Week 1

- Read this entire document.
- Read `phase-4-master.md` and the seven Sprint 4 specs.
- Read `lib/orchestrator.ts` and `lib/saga.js` to internalize the existing backend shape.
- Set up local dev environment for the existing Lumo Super Agent web app (verify can run dev server, run tests, hit the local chat UI).
- Set up React Native dev environment for Phase 5 (Xcode for iOS, Android Studio for Android, Expo CLI as appropriate).
- Build a "hello mobile" — a barebones React Native app that hits the existing `/api/chat` endpoint and renders a streaming response. This is throwaway code; the goal is to validate the full mobile-to-backend round trip works in your dev environment before Phase 5 starts in earnest.
- Branch `claude-code/mobile-bootstrap`. STATUS.md update. Throwaway code, do not push to main; document learnings in `docs/notes/mobile-bootstrap-2026-04-29.md` and push that.

### Cowork-Claude (reviewer) — Monday of Week 1

- Confirm both lanes have read this document.
- Confirm STATUS.md format is in use by both lanes.
- Stand up the `docs/contracts/` folder with a README explaining the contract-first protocol.
- Schedule a Wednesday checkpoint (async, in chat) to review both lanes' first-week progress and unblock anything before Friday.

### Kalas — Monday of Week 1

- Open partnership conversations with Duffel (flight inventory). Ask for: pricing, supported airlines, AI-agent volume tolerance, sandbox access.
- Open partnership conversation with Booking.com Affiliate Partner team or Expedia Partner Solutions. Same questions.
- Open partnership conversation with Uber for Business and Lyft Business.
- Open partnership conversation with Stripe Issuing (for the merchant-of-record substrate) — they have a special program for AI agent platforms.
- Engineering can start MERCHANT-1 with Stripe stub mode regardless; getting the production keys signed off is the gating step before Phase 5 ships.

---

## 9. Open questions to resolve before Phase 5 starts

1. **React Native vs native (Swift + Kotlin) vs Flutter for the mobile app.** Recommendation: React Native (bare, not Expo) — fastest team velocity, native-module access for biometric / wallet / voice integrations, single codebase. Counter-argument: native gives the best polish and platform-feel. Decision needed by end of Phase 4.5.
2. **Voice provider for TTS.** Cartesia (fastest), ElevenLabs Turbo (most natural), OpenAI Realtime (tightest LLM integration). Pick before MOBILE-VOICE-1.
3. **Second LLM provider for fast-path inference.** Groq vs Cerebras vs SambaNova. Pick before PERF-2. Recommendation: Groq for consistency, Cerebras as backup.
4. **Observability stack final choice.** Sentry + Langfuse + PostHog is the recommended stack; confirm before PERF-1.
5. **Mobile-app monetization model.** Freemium with free tier capped on agent invocations? Flat $X/month? Per-transaction service fee on merchant-of-record bookings? Multiple? Decision needed by end of Phase 5; revenue model affects mobile UX (paywalls, upgrade prompts, etc.).
6. **App store distribution timing.** Ship to TestFlight / internal Android first (Phase 5 exit), or push to public app stores? Recommendation: 4-week TestFlight + internal Android beta after Phase 5 exit, then public after critical bugs ironed out.

---

## 10. How to read this document

- This is the **canonical roadmap.** When reality diverges from this document, update this document — don't let it rot.
- Each phase has a corresponding master spec (Phase 4 has `phase-4-master.md`; Phase 4.5+ will get their own `phase-X-master.md` documents written at the start of each phase). This roadmap is the index; the per-phase master specs are the details.
- Sprint-level specs live in `docs/specs/sprint-N-<id>-<name>.md` per the convention established in Phase 4.
- ADRs live in `docs/specs/adr-NNN-<title>.md` and are the durable architectural decisions that span phases.
- Contracts (cross-lane API specs) live in `docs/contracts/<contract-name>.md`.

---

## 11. Living-document protocol

This roadmap is a living document. Updates happen via PR-equivalent direct-to-main commits:

- **Cowork-Claude updates** when scope changes, when phases reshuffle, when risks materialize, when new ADRs land.
- **Codex and Claude Code propose updates** via a `docs(roadmap):` commit on a feature branch when their work reveals the roadmap is wrong about something. Cowork-Claude reviews and merges.
- **Kalas updates** when business reality shifts (partnership closes / fails, pricing decision lands, fundraising changes runway).

Every update bumps a `Changelog` section appended to the bottom of this file (to be added on first revision).

---

**End of roadmap v1.**
