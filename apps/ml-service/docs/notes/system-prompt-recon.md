# SYSTEM-PROMPT-MIGRATE-PYTHON-1 — recon report

**Status:** recon-only commit. **Stop for reviewer approval before scope work.**

---

## TL;DR for the reviewer

1. **Single canonical function exists** → `buildSystemPrompt(opts)` at `apps/web/lib/system-prompt.ts:27-118`. ~118 lines, returns one concatenated string. Migration is "port one file" plus the 350-line `VOICE_MODE_PROMPT` constant from `voice-format.ts`.
2. **The brief's eval axes don't match the TS code's actual branch points.** Brief says `planning_step × profile_type × time_of_day`. TS code branches on `mode (text|voice) × memory × ambient × bookingProfile × agents × user_first_name × user_region`. **`planning_step`, `intent_bucket`, and `time_of_day` are not inputs.** Need reviewer to confirm pivot.
3. **PlanRequest doesn't carry the heavy inputs** the prompt needs (`agents`, `memory`, `ambient`, `bookingProfile`). Three migration paths surfaced; Option **A.2** (extend PlanRequest with optional fields) is the recommended one, but each option has a different blast radius and codex coordination burden.
4. **PlanResponse field decision**: Python's `system_prompt_addendum` currently holds *classifier reasoning text* (not real system prompt). **Option B — add a new `full_system_prompt` field** — is cleanest; keeps the existing field for classifier diagnostics.
5. **Mesh supervisor addendum** (`<mesh_context>` injection at `orchestrator.ts:838-865`) lives *outside* `buildSystemPrompt`. Need reviewer to confirm whether to mirror it.
6. **Migration number**: 058 (next available; 057 just landed).

---

## 1 · Canonical function

### Location + signature

```ts
// apps/web/lib/system-prompt.ts:27-118
export function buildSystemPrompt(opts: {
  agents: RegistryEntry[];
  now: Date;
  user_first_name?: string | null;
  user_region: string;
  mode?: "text" | "voice";
  memory?: {
    profile: UserProfile | null;
    facts: UserFact[];
    patterns: BehaviorPattern[];
  };
  ambient?: AmbientContext;
  bookingProfile?: BookingProfileSnapshot | null;
}): string
```

### Output shape

A **single concatenated string**. Joined by literal `\n`. Passed directly to Anthropic's `system` parameter wrapped in a prompt-cache block at `orchestrator.ts:920-926`.

### 13 sections in order
1. Brand voice + role intro (static)
2. `TODAY: <ISO>` (always)
3. `USER REGION: <code>` (always)
4. `USER: <first name>` (optional)
5. `RIGHT NOW:` ambient block (optional)
6. `WHAT YOU KNOW ABOUT THIS USER:` memory block (optional)
7. `BOOKING PROFILE PREFILL:` block (optional)
8. `CAPABILITIES YOU HAVE (via tools):` agent list (always — even if empty)
9. `CURRENTLY UNAVAILABLE:` degraded-agents list (optional, only when health < 0.6)
10. `RULES:` numbered 9-rule block (static)
11. `TONE:` brand voice line (static)
12. `MEMORY HYGIENE:` meta-tools block (static)
13. `VOICE MODE:` block (`if mode === "voice"`) — 350 lines from `voice-format.ts:VOICE_MODE_PROMPT`

### Length envelope

- Baseline (text mode, no memory/ambient/booking, 5–10 agents): ~1150–1300 tokens
- All blocks present + voice mode: ~2000–2350 tokens
- No truncation logic — caller's responsibility

---

## 2 · Branch points the TS code actually has

| Input | Branch effect |
|---|---|
| `mode === "voice"` | Appends 350-line `VOICE_MODE_PROMPT` block |
| `memory` (profile / facts / patterns) | `WHAT YOU KNOW…` block; per-field/per-fact lines via `profileToLines()`; omitted when no data |
| `ambient` | `RIGHT NOW:` block; coords formatted to 3 decimals; omitted when empty |
| `bookingProfile` | `BOOKING PROFILE PREFILL:` block via `bookingProfileSnapshotToPrompt()`; omitted when null |
| `agents` | Bulleted list with display_name + agent_id + one_liner + up to 3 example_utterances joined by " · " |
| `agents[i].health_score < 0.6` | Moved to `CURRENTLY UNAVAILABLE:` block |
| `user_first_name` | One line `USER: <name>`; omitted when null |
| `user_region` | One line `USER REGION: <code>`; always present |
| `now` | `TODAY: <ISO>` always present (uses `toISOString()` UTC) |

**NOT branched on:** `planning_step`, `intent_bucket`, compound trip state, user approvals/installed agents, time-of-day greeting, day-of-week, feature flags (other than the post-build mesh injection).

---

## 3 · Verbatim static content (must reproduce exactly)

### Intro (lines 80–82)
```
You are Lumo, a universal personal concierge.

Your job is to get the user the thing they want — food, flights, hotels, rides, whatever — with the fewest possible turns. You are chat-first and voice-first. Users may speak or type. Be warm, brief, and precise.
```

### RULES (lines 95–107) — 9 numbered rules
Tool selection + clarification phrasing · two-step booking flow · rich card selections (flight_offers, food menu, time slots) · mixed-intent sequencing · never expose agent/tool names · "can't do that yet" for missing capabilities · never invent prices/PNRs · keep responses short by default · tool errors → 1 sentence + next step.

### TONE (line 108)
```
Tone: concise, kind, a little dry. Think: a friend who happens to be great at logistics.
```

### MEMORY HYGIENE (lines 110–116)
3 meta-tools (`memory_save`, `memory_forget`, `profile_update`) + guidance on what to save vs. ephemeral, no announcing memory writes, supersede contradictions, forget on user request.

### VOICE_MODE_PROMPT — `apps/web/lib/voice-format.ts:330-400`
~350 lines covering tone (contractions, emotion, sentence-length variance), NEVER-SAY corporate jargon list, structure (<30 words per turn, no markdown, TTS amount phrasing), and CONFIRMATION GRAMMAR for money-moving tools (affirmative/cancel semantics + summary_hash lifecycle).

**Migration approach:** mirror these as Python module-level constants — module-level f-string with `{ }` interpolation only where the TS uses `${ }`. Keep newlines + indentation byte-for-byte.

---

## 4 · Helper functions referenced

| TS helper | Lines | What it does |
|---|---|---|
| `profileToLines(profile)` | system-prompt.ts:165-187 | 1 line per non-null UserProfile field. 13 fields whitelisted: `display_name`, `timezone`, `language`, `home`, `work`, `dietary`, `allergies`, `cuisines`, `airline_class`, `seat`, `hotel_chains`, `budget`, `payment_hint` |
| `addressToLine(address, label)` | system-prompt.ts (within profileToLines region) | Formats `home`/`work` address objects |
| `formatMemoryBlock(memory)` | system-prompt.ts:125-163 | Header + profile lines + facts (`[category] fact_text`) + patterns (`description (observed N×)`) |
| `formatAmbientBlock(ambient)` | system-prompt.ts:200-214 | `local_time`, `timezone`, `coords` (lat/lng/accuracy), `location_label`, `device_kind` |
| `bookingProfileSnapshotToPrompt(snapshot)` | apps/web/lib/booking-profile-core.ts:228-245 | Per-field present/missing list + missing-fields summary + override-offer line |

---

## 5 · Where the inputs come from at runtime

| Input | Source in orchestrator |
|---|---|
| `agents` | `apps/web/config/agents.registry.json` loaded via `agent-registry.ts` |
| `now` | `new Date()` per turn (orchestrator.ts:725) |
| `user_first_name` | auth metadata, split on whitespace, first word (chat route ≈ line 287-295) |
| `user_region` | chat route input; defaults `"US"` |
| `mode` | `"text"` | `"voice"` per request flag |
| `memory` | DB load: profile + facts + patterns via Supabase per `user_id` |
| `ambient` | request body (browser-sent) |
| `bookingProfile` | DB load via Supabase per `user_id` |

The orchestrator loads memory + bookingProfile **server-side** before calling `buildSystemPrompt`. **Python's `/api/tools/plan` doesn't have these in `PlanRequest` today.**

---

## 6 · Mesh supervisor addendum (post-build, outside the function)

`orchestrator.ts:838-865`:

```ts
if (process.env.LUMO_USE_MESH === "true" && mesh.requestId) {
  system = `${system}\n\n<mesh_context request_id="${mesh.requestId}">\n${mesh.contextSummary}\n</mesh_context>`;
}
```

XML-tagged supervisor context appended after `buildSystemPrompt` returns. Not part of the function. **Out of scope unless reviewer says otherwise** — would require Python to also receive `mesh.contextSummary` input, which the orchestrator builds from internal subagent state.

---

## 7 · Existing Python state — `system_prompt_addendum`

```python
# apps/ml-service/lumo_ml/plan/schemas.py:131
system_prompt_addendum: str | None = Field(default=None, max_length=8000)
```

Currently set in `router.py:125` to `classification.reasoning` — diagnostic text like `"anchor-similarity tool_path (top=0.245, gap=0.081)"`. **Not real prompt content.**

Codex's plan-client and `agent_plan_compare` capture treat this as classifier debug telemetry, not as a prompt fragment. Repurposing the field to carry the full system prompt would change its semantics under codex.

---

## 8 · Test coverage on the TS side

No dedicated test file for `buildSystemPrompt`. Implicitly covered via orchestrator integration tests. **No snapshot tests exist** — I'll author them in the eval harness.

---

## 9 · Migration number

```bash
$ ls db/migrations/ | tail -5
053 user_app_approvals
054 agent_plan_compare
055 compound_rpc_cycle_guard
056 voice_provider_compare
057 agent_plan_compare_suggestions  ← my last lane
```

Next available: **058**. Brief specifies 058 — confirmed clean.

---

## 10 · Brief deviations to call out (recon catches)

### 10a · Eval axes don't match TS branch points

Brief: "25+ canonical scenarios spanning each (`planning_step` × `profile_type` × `time_of_day`) combo".

Reality: **None** of those three are inputs to `buildSystemPrompt`. `planning_step` and `intent_bucket` are post-LLM routing decisions; `time_of_day` doesn't appear anywhere in the prompt code (`now` is rendered as ISO timestamp but no morning/afternoon/evening branching).

Actual axes that exercise distinct branches:

| Axis | Levels | Why it matters |
|---|---|---|
| `mode` | `text`, `voice` | 350-line VOICE_MODE_PROMPT block toggles |
| `memory` presence | none / partial / full / full+patterns | Multiple format paths |
| `ambient` presence | none / partial / full | One-block toggle |
| `bookingProfile` presence | null / present / present-with-missing-fields | One-block toggle + summary line |
| `agents` health | all healthy / mixed (some < 0.6) | CURRENTLY UNAVAILABLE block toggles |
| `user_first_name` | null / present | One line toggle |
| `user_region` | varies | String interpolation only |

That's 2×4×3×3×2×2 = ~280 combos. **30 well-chosen scenarios** covering: 2 modes × 4 memory states × 4 booking states (oversampled vs other axes) × ambient on/off × agent-health-mixed = ample.

### 10b · Field name decision (PlanResponse)

Three options:

- **Option A** — repurpose `system_prompt_addendum`. Field name stays; semantics flip from "classifier reasoning string" to "full system prompt". Breaks codex's existing `agent_plan_compare` capture for classifier reasoning. **Risky.**
- **Option B** — add `full_system_prompt: str | None = None` to PlanResponse. Keep `system_prompt_addendum` for classifier reasoning. Codex's plan-client extends to read both. **Recommended** — clean, additive, codegen drift catches consumer drift.
- **Option C** — don't migrate this. Keep prompt server-side in TS forever. **Contradicts the brief's stated goal** ("entire /api/tools/plan response is Python-authored on every field") so I read this as not on the table.

Recommend **B** unless reviewer prefers A.

### 10c · Heavy inputs

`buildSystemPrompt` needs: `agents`, `memory`, `ambient`, `bookingProfile`, `user_first_name`, `user_region`, `mode`, `now`. PlanRequest currently carries `user_message`, `session_id`, `user_id`, `history`, `approvals`, `planning_step_hint`, `last_assistant_message`. Missing: agents/memory/ambient/bookingProfile/user_first_name/user_region/mode.

Three sub-options:

- **A.1** — Python's brain loads memory + bookingProfile from Supabase server-side (Python already has supabase access for sandbox/recall; would need RLS + service-role wiring). **Plan-client passes very little.** Cleaner separation but adds a DB-dependency on the brain side.
- **A.2** — Extend PlanRequest with `agents: list[AgentManifest]`, `memory: MemorySnapshot | None`, `ambient: AmbientContext | None`, `booking_profile: BookingProfileSnapshot | None`, `user_first_name: str | None`, `user_region: str`, `mode: Literal["text", "voice"]`. **Plan-client serializes everything**. Wire-shape additive. **Recommended** — codex already has these structures TS-side, easy to forward; brain doesn't need DB access.
- **A.3** — Ship a partial prompt. Skip memory/ambient/bookingProfile blocks initially; lower the eval Levenshtein gate to ≥ 0.85 to allow for the missing blocks. Quick start, but the parity comparison becomes apples-to-oranges.

Recommend **A.2** — most parity, additive change, codex already has the shapes.

### 10d · `VOICE_MODE_PROMPT` — 350-line constant

Port verbatim as a Python module-level string. ~10 KB constant, fine for memory. Keep newlines + indentation byte-for-byte; otherwise Levenshtein will dock points on whitespace alone.

### 10e · Mesh supervisor addendum

Out of scope unless reviewer wants parity. The `<mesh_context>` injection is conditional on `LUMO_USE_MESH === "true"` and only fires when the supervisor builds a context summary — orchestrator-internal state that PlanRequest doesn't carry. Recommend: skip. Levenshtein eval scenarios should set `LUMO_USE_MESH=false` (or just exclude mesh-injected outputs).

### 10f · Telemetry approach

Brief says `system_prompt_python text`, `system_prompt_ts text`, `system_prompt_levenshtein_ratio real`. Storing 1500–2500-token strings in a `text` column twice per turn is ~6KB per row. With ~100k turns/day that's ~600MB/day of growing telemetry. **Suggestion to reviewer: either**
- store hashes only (`system_prompt_python_hash text`, `_ts_hash text`, `_levenshtein_ratio real`) and only persist full text on a sampled fraction, OR
- accept the volume but add a 30-day retention policy on the suggestion + system-prompt text columns.

This is a codex/DB concern more than a Python one, but the choice affects what migration 058 looks like. Will go with the brief's exact spec (`text` columns, no hashing) unless reviewer says otherwise.

---

## 11 · Open questions for reviewer

### 11.1 — Field on PlanResponse: A (repurpose), B (add `full_system_prompt`), or C (don't migrate)?
Recommend **B**. Default plan if no answer.

### 11.2 — Heavy inputs path: A.1 (DB load), A.2 (extend PlanRequest), or A.3 (partial prompt)?
Recommend **A.2**. Schema delta is large but additive; codegen drift catches consumer drift; codex's plan-client wire serializes from existing TS structures.

### 11.3 — Eval axes pivot: brief's `(planning_step × profile × time_of_day)` → `(mode × memory × ambient × bookingProfile + agent-health-mix + region)`?
Recommend **pivot**. Brief axes don't exercise the actual code paths.

### 11.4 — Mesh supervisor `<mesh_context>` injection: in scope or out?
Recommend **out**. Adds a non-Pure dependency; the addendum is orchestrator-runtime not prompt-authoring.

### 11.5 — `agents` registry: read from `apps/web/config/agents.registry.json` directly server-side, or have plan-client send the resolved list?
Recommend **plan-client sends**. Brain shouldn't reach into web's config file; that creates a build-time coupling. The wire-shape addition is small (an array of `{display_name, agent_id, one_liner, example_utterances[], health_score}`).

### 11.6 — Migration 058 telemetry: store full prompt text both sides (~6 KB/row, ~600 MB/day at 100k turns) or store hashes + sample full text?
Recommend **brief's spec** (full text both sides) for the first 7 days to bootstrap ground truth, then **switch to hashes after cutover decision**. Codex's logger lane can implement the switch when it's time.

---

## 12 · Migration strategy (subject to reviewer answers)

Assuming **B + A.2 + axes-pivot + mesh-out + plan-client-sends-agents + telemetry-as-spec'd**:

1. **PlanRequest schema** gets six new optional fields:
   ```python
   user_first_name: str | None = None
   user_region: str = Field(default="US", min_length=2, max_length=8)
   mode: Literal["text", "voice"] = "text"
   agents: list[AgentManifestForPrompt] = Field(default_factory=list, max_length=80)
   memory: MemorySnapshot | None = None
   ambient: AmbientContext | None = None
   booking_profile: BookingProfileSnapshot | None = None
   ```
   New nested types: `AgentManifestForPrompt`, `MemorySnapshot { profile, facts[], patterns[] }`, `UserProfile`, `UserFact`, `BehaviorPattern`, `AmbientContext`, `BookingProfileSnapshot` (mirror TS shapes).

2. **PlanResponse** gets `full_system_prompt: str | None = None` (Field max_length=30000 to fit ~2500-token + voice + mesh-future-proof).

3. **`apps/ml-service/lumo_ml/plan/system_prompt.py`** — port `buildSystemPrompt` line-by-line. Mirror helper functions: `_profile_to_lines`, `_format_memory_block`, `_format_ambient_block`, `_booking_profile_snapshot_to_prompt`. `VOICE_MODE_PROMPT` as a module-level constant.

4. **Wire into router.py** — call `build_system_prompt(...)` after the classifier and suggestions; populate `PlanResponse.full_system_prompt`. Headers `X-Lumo-System-Prompt-Source: python` and `X-Lumo-System-Prompt-Length: <chars>`.

5. **Migration 058** — extend `agent_plan_compare`:
   ```sql
   alter table public.agent_plan_compare
     add column if not exists system_prompt_python text,
     add column if not exists system_prompt_ts text,
     add column if not exists system_prompt_levenshtein_ratio real
       check (system_prompt_levenshtein_ratio is null or
              (system_prompt_levenshtein_ratio >= 0 and system_prompt_levenshtein_ratio <= 1));
   ```

6. **Eval harness** — `tests/data/system_prompt_eval.jsonl` with 30 scenarios spanning `mode × memory_state × ambient × booking × agent-health-mix`. Levenshtein ratio computed via `difflib.SequenceMatcher(None, py, ts).ratio()` (stdlib; no external dep needed). Gate: mean ≥ 0.95, floor ≥ 0.90.

7. **Unit tests** — each helper function tested in isolation; full builder tested against 5–8 small fixed cases pinning each section.

8. **Modal redeploy** + smoke test: `curl ${URL}/api/tools/plan` with a populated `last_assistant_message` + new fields, confirm `full_system_prompt` returns and headers populate.

---

## 13 · Coordination

- Codex's queue: AUDIO-HOTFIX in flight, then `PLAN-CLIENT-EMPTY-SUGGESTIONS-1` + `PLAN-CLIENT-SUGGESTIONS-LOGGER-1`. Once AUDIO-HOTFIX merges, codex's plan-client lane will need a small extension to:
  - serialize the new PlanRequest fields (agents, memory, ambient, bookingProfile) from existing TS structures
  - read `full_system_prompt` from the response and the new headers
  - write into `agent_plan_compare.system_prompt_*` columns
- I won't touch `apps/web/`. Codex's follow-up logged in the post-merge review report.

---

## 14 · What I'm waiting on before scope work

1. **Field decision** (11.1) — recommend **B** add `full_system_prompt`.
2. **Inputs path** (11.2) — recommend **A.2** extend PlanRequest.
3. **Eval axes pivot** (11.3) — recommend pivot to actual TS branch points.
4. **Mesh** (11.4) — recommend **out**.
5. **Agents registry source** (11.5) — recommend plan-client sends.
6. **Telemetry storage** (11.6) — recommend brief's spec (full text) for first 7 days.

Once those are answered, scope work proceeds in a single push: `system_prompt.py` + helpers + PlanRequest extension + PlanResponse `full_system_prompt` + headers + migration 058 + eval harness + unit tests + Modal redeploy → ready-for-FF-merge review.
