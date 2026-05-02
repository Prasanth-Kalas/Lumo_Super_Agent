# Lumo Super Agent — May 2026 changelog

What shipped in the May 2026 sprint cycle. Written for the team to catch up on context after the cycle. For the per-lane history, see `STATUS.md` push log; for architecture detail, see `docs/architecture/`.

---

## Headlines

1. **Voice infrastructure migrated from ElevenLabs + SFSpeech/SpeechRecognition to Deepgram across web + iOS.** Aura-2 for TTS, Nova-3 for STT. Faster TTFB, cleaner credential surface, cross-platform parity, native diarization headroom.
2. **Voice mode state machine fixed two real production bugs**: multi-sentence audio truncation (chunked-player MediaSource lifecycle) and STT-during-TTS self-interruption (state-machine gating).
3. **Compound multi-agent dispatch is real**: orchestrator now plans real DAGs ("plan a Vegas trip with flights + hotels + dinner") and dispatches to actual sub-agents (Duffel for flights, preview stubs for hotel/restaurant until those tools register). Replaces the prior hardcoded-regex + fake-success flow that broke for any prompt outside `plan ... vegas ... weekend`.
4. **Python ML service foundation (Phase 2A) shipped**: distributed tracing (OpenTelemetry → Honeycomb), `@traced` discipline enforced by CI lint, Secret-by-default PII redaction, BGE-large embedding service on Modal T4, pgvector vector store, agent_cost_records cost telemetry.
5. **`/api/tools/plan` endpoint is now fully Python-authored** on every output field — intent classifier, suggestions, system prompt — under parallel-write telemetry. Three independent cutover thresholds gate production traffic flips per surface.
6. **Approval flow stopped lying.** Migration 060 fixed the silent-failure path where the chat route returned "Approved!" while the underlying RPC failed with `column reference "user_id" is ambiguous`. 33 hits in 7 days affected before the fix; backfill lane filed.

---

## Voice (Deepgram migration + state-machine fixes)

### What changed
- New routes: `POST /api/tts` (web Deepgram REST Speak proxy), `POST /api/audio/deepgram-token` (iOS-facing JWT mint via Deepgram `POST /v1/auth/grant`).
- New env vars: `LUMO_DEEPGRAM_API_KEY`, `LUMO_TTS_PROVIDER`, `LUMO_DEEPGRAM_TTS_SPEED` (default `0.9`), `LUMO_VOICE_TTS_TAIL_GUARD_MS` (default `300`).
- Voice catalog: Aura-2 voices `aura-2-thalia-en` (default), `aura-2-orpheus-en`. Mirrored verbatim across web + iOS for cross-platform consistency.
- iOS: `DeepgramTokenService`, `SpeechRecognitionService` rewritten on Nova-3, `TextToSpeechService` rewritten on Aura-2, `DeepgramTTSSession` keeps one `AVAudioPlayerNode` alive across multi-sentence replies, `SpeechModeGating` mirrors web's gating logic with byte-identical phase enum strings for cross-platform telemetry parity.
- ElevenLabs/SFSpeech code paths kept for 7-day rollback window behind `LUMO_TTS_PROVIDER=elevenlabs`. Cleanup lane `DEEPGRAM-CLEANUP-1` fires after the window.

### Bugs fixed
- **Multi-sentence audio truncation**: chunked-player called `endOfStream()` on MediaSource after chunk 1 finished playing, sealing the buffer before chunk N+1 could append. Fix: defer `endOfStream()` until last-chunk flag set AND queue empty. Same principle on iOS — don't tear down player node between chunks.
- **STT-during-TTS self-interruption**: STT stayed listening while agent was speaking; agent's own audio (or ambient noise) tripped a "user is speaking" event, cancelling remaining TTS. Fix: state machine gates STT input feed during `AGENT_SPEAKING` + `POST_SPEAKING_GUARD` (300ms tail). Manual barge-in via Stop button still works.
- **Trailing button regression**: after STT-gating fix, the right-side action button (Tap-to-talk / Stop) wasn't rendered for the new states. Fix: button always renders, phase determines label/icon/handler. iOS implementation became the reference pattern (red Stop affordance during agent speech).

### What's next on voice
- `VOICE-MODE-WAKE-WORD-1` (in design): "Hey Lumo" wake-word activation. Picovoice Porcupine v1, OpenWakeWord fallback. Design at `docs/designs/voice-mode-wake-word.md`. Implementation lane fires after Phase 2A foundation lands.
- `IOS-DEEPGRAM-DEVICE-SMOKE-1` (pending Kalas): real-device end-to-end validation of multi-sentence + Bluetooth + repeated-session stability. Build script at `apps/ios/scripts/build-and-deploy-iphone.sh`.

---

## Compound multi-agent dispatch

### What was broken
User asks: *"plan a trip from chicago to vegas next entire week including hotels"*

Old behavior: orchestrator returned hardcoded text ("Approved Lumo Flights — let's go") and stopped. No actual sub-agent execution, no real Duffel call, no hotel search. User saw fake confirmations for work that never happened. Three stacked failures named in the recon at `docs/notes/orchestrator-compound-dispatch-recon.md`:

1. Approval RPC silently failing on a SQL ambiguity bug (33 hits in 7 days).
2. Compound trigger was a literal regex match (`plan ... vegas ... weekend`).
3. Mission executor treated `mission.*` steps as no-op acknowledgments.

### What ships now
- **`APPROVAL-CONNECTION-RPC-STRICT-1`** (migration 060): qualified column references in `connect_first_party_session_app_approval`. Removed the silent-failure path — RPC errors now surface as structured `approval_write_failed` 5xx instead of fake-success messages. Backfill lane `BACKFILL-FAILED-APPROVALS-1` filed for the 33 historical hits.
- **`ORCHESTRATOR-COMPOUND-DISPATCH-WIRE-1`** (migration 061): real classifier-driven compound detection (heuristic shortlist + LLM tiebreaker), durable mission DAG persistence in `missions` + `mission_steps` with new fields (`compound_dispatch_id`, `compound_graph_hash`, `compound_domains`, `client_step_id`, `dependency_mode`, `depends_on_step_orders`, `dispatch_tool_name`, `output_summary`), real MCP tool dispatch (`mission.flight_search` → `duffel_search_flights`), honest preview stubs for hotel/restaurant/food when no registered tool exists, progressive disclosure UX via `assistant_compound_step_update` events.
- **Test corpus**: 5 canonical compound prompts (Vegas, NYC, Paris, beach, ski) + single-agent non-regression + graph hash determinism + UI frame wiring.

### What's next on dispatch
- `COMPOUND-MISSION-ROUTING-PYTHON-1` (Phase 2 follow-up): OR-Tools constraint solver layered on top — optimize across timing, budget, traveler preferences. TS layer stays as the working baseline; Python adds smarter optimization.
- `BACKFILL-FAILED-APPROVALS-1`: retroactive completion of writes that should have succeeded during the silent-failure window.
- Calendar conflict detection across compound trips (`COMPOUND-CALENDAR-CHECK-1`, deferred).

---

## Python ML service Phase 2A foundation

The Phase 1 migration of `/api/tools/plan` from TypeScript to Python (intent classifier, suggestions, system prompt — landed earlier in the cycle) gave us telemetry parity. Phase 2A built the **platform layer** every future Python lane composes on top.

### Lanes shipped
- **`PYTHON-OBSERVABILITY-1`**: OpenTelemetry SDK + OTLP HTTP exporter to Honeycomb. `@traced` decorator with sync + async support. `record_cost(...)` for LLM tokens / embedding ops / GPU seconds. Two-layer PII redaction: Pydantic `Annotated[T, Secret]` (Layer A, opt-in) + stdlib logger filter with 6 PII regex classes including Luhn-validated credit cards (Layer B, defensive). Migration 059 added `agent_cost_records`. CONTRIBUTING.md mandates `@traced` + `record_cost` + Secret-by-default on every new public function.
- **`OBSERVABILITY-LINT-COVERAGE-1`**: CI lint (`apps/ml-service/scripts/lint-traced-coverage.py`) breaks PRs that ship public functions without `@traced`. Bare `# noqa: TRC001` is rejected — opt-out requires an inline reason. AST walker recognizes all decorator import shapes.
- **`PYTHON-EMBEDDING-SERVICE-1`**: BGE-large-en-v1.5 (1024-dim, normalized) on Modal T4, mirroring the existing `modal_clip.py` pattern. Async `embed_text` / `embed_batch` API. Two-tier cache (in-memory LRU + Modal Volume persistent). Cost calibration `~$0.117 / 1M tokens`. Lint scope inversion bundled — `lumo_ml/core/` is now in scope, named tracing-infra files (`observability.py`, `otel_setup.py`, `pii_redaction.py`) are exempt.
- **`PYTHON-VECTOR-STORE-1`** (design done, implementation incoming): pgvector primary backend, new `lumo_vectors` table (separate from `unified_embeddings` due to different ownership/lifecycle/deletion semantics), HNSW `m=16/ef_construction=64` mirroring ADR-011. User-scoped RLS (`auth.uid() = user_id`). Three-phase reindex playbook for model rotations.

### Phase 2B planned (capability platforms)
Memory (embeddings + consolidation + persona facts), multimodal context (audio + vision + documents under one `MultiModalContext` object), retrieval platform (BM25 + dense + reranker), reasoning primitives (decomposition, critic loop, reflexion, tree-of-thoughts), safety platform (hallucination detector, audit log, cost guards, PII redaction at scale).

### Phase 2C features (compose on platforms)
Memory with embeddings, compound routing optimization, custom wake-word model training, image understanding, speaker diarization, tone analysis, hybrid retrieval over connectors, hallucination detection, preference learning, recommendations, document ingestion.

---

## Database migrations (this cycle)

| # | Title | Lane |
|---|---|---|
| 056 | `voice_provider_compare` | `DEEPGRAM-MIGRATION-1` |
| 057 | `agent_plan_compare` extension — suggestions columns | `SUGGESTIONS-MIGRATE-PYTHON-1` |
| 058 | `agent_plan_compare` extension — system prompt columns | `SYSTEM-PROMPT-MIGRATE-PYTHON-1` |
| 059 | `agent_cost_records` (cost telemetry) | `PYTHON-OBSERVABILITY-1` |
| 060 | `connect_first_party_session_app_approval` qualified columns | `APPROVAL-CONNECTION-RPC-STRICT-1` |
| 061 | `missions` + `mission_steps` DAG fields, `next_mission_step_for_execution` RPC, `assistant_compound_step_update` event type | `ORCHESTRATOR-COMPOUND-DISPATCH-WIRE-1` |

Both 060 + 061 applied to production Supabase on 2026-05-02 via the SQL editor; verification queries confirmed all expected schema additions present.

---

## New env vars (full inventory)

### Vercel (server-side)
- `LUMO_DEEPGRAM_API_KEY` — sensitive
- `LUMO_TTS_PROVIDER` — `deepgram` (default) | `elevenlabs` (fallback)
- `LUMO_DEEPGRAM_TTS_SPEED` — default `0.9`, range `0.7-1.5`
- `LUMO_VOICE_TTS_TAIL_GUARD_MS` — default `300`

### Modal (`lumo-ml-service` secret)
- `LUMO_HONEYCOMB_API_KEY`
- `LUMO_OTEL_ENDPOINT` — default Honeycomb US
- `HF_TOKEN` (HuggingFace gated model downloads)

### iOS local Mac (`~/.config/lumo/.env`)
- `LUMO_APPLE_TEAM_ID` — for device build code signing
- `LUMO_IPHONE_UDID` — for device install target

Full reference at `docs/operators/env-vars.md`. Sync helper script at `scripts/sync-env-from-vercel.sh` (uses `vercel env pull`).

---

## New scripts

- **`scripts/sync-env-from-vercel.sh`** — pulls Vercel env vars to `apps/web/.env.local` and mirrors to `~/.config/lumo/.env`. Required Vercel CLI + `vercel link` once.
- **`apps/ios/scripts/build-and-deploy-iphone.sh`** — one-shot `xcodegen generate` → `xcodebuild` with signing override → `xcrun devicectl install app`. Defaults baked in for the team's primary test iPhone + Apple Developer team.

---

## Cross-platform discipline patterns established this cycle

Worth knowing for any future agent reading the codebase:

1. **Design-first commits**: every new lane's first commit is a design doc with §11 open questions. Reviewer answers explicitly OR greenlights "Option β" (proceed on recommended defaults, surface deviations in implementation). Pattern proved itself across observability, embedding-service, vector-store, dispatch-wire.
2. **Cross-pinned contracts**: `vector_store.py` imports `ModelVersion / DIMENSIONS / Embedding` from `embeddings.py` — never restates literals. Single source of truth for "bge-large-en-v1.5" / 1024 / normalized=True. Future model rotation = one Literal widening + one ALTER. Pattern should be the template for every cross-module Python contract.
3. **Telemetry-driven cutover**: parallel-write into `agent_plan_compare` for /plan surfaces, `voice_provider_compare` for voice. Production traffic flips per surface only after telemetry shows ≥ threshold agreement (95% for intent classifier, 99% Jaccard for suggestions, 0.99 Levenshtein for system prompt).
4. **Honest preview stubs over fake success**: dispatch-wire returns clearly-labeled "preview only" placeholders for unregistered tools rather than fake confirmations. Trust restoration after the approval-flow lying bug.
5. **Stowaway repairs are flagged + tested**: cross-lane edits (e.g. python's lane fixing a `SPEAKER_NN` zero-pad bug codex introduced) document the repair in the commit message + add a regression test, so the fix doesn't get accidentally reverted later.

---

## Reading order for new contributors

1. This file (top-level narrative)
2. `docs/architecture/voice-stack.md` (Deepgram era specifics)
3. `docs/architecture/orchestration.md` (compound dispatch section)
4. `docs/architecture/observability.md` (Python platform section)
5. `docs/operators/env-vars.md` (everything you need to set)
6. `apps/ml-service/CONTRIBUTING.md` (the discipline rules)
7. `docs/designs/orchestrator-compound-dispatch.md` (DAG architecture)
8. `STATUS.md` (active work + push log)
