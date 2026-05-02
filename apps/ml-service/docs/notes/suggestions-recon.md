# SUGGESTIONS-MIGRATE-PYTHON-1 — recon report

**Status:** recon-only commit. **Stop for reviewer approval before scope work** per the brief's two-phase doctrine.

---

## TL;DR for the reviewer

1. **Single canonical function exists** → `buildAssistantSuggestions()` in `apps/web/lib/chat-suggestions.ts:28-57`. No ad-hoc chip-generation elsewhere. Migration is "port one file", not "consolidate-then-port".
2. **The brief's described inputs differ from the actual TS surface** in three ways. Flagged below; need reviewer answers before scope work begins.
3. **Migration number conflict.** Brief says 057; next available is 056. Need reviewer confirm whether 056 is reserved for codex (DEEPGRAM-MIGRATION-1?) or I should use 056.
4. **Header names are safe to add.** `plan-client.ts` only reads `x-lumo-plan-stub` today; no `X-Lumo-Suggestions-*` collision.

---

## 1 · Canonical function

### Location + signature

```ts
// apps/web/lib/chat-suggestions.ts:28-57
export function buildAssistantSuggestions(
  input: BuildAssistantSuggestionsInput,
): AssistantSuggestionsFrameValue | null
```

### Inputs (lines 19-26)

```ts
interface BuildAssistantSuggestionsInput {
  turnId: string;
  assistantText: string;          // the assistant's response text for THIS turn
  planningStep?: PlanningStep;     // defaults to "clarification"
  latestUserMessage?: string;
  now?: Date;                      // defaults to new Date()
  userRegion?: string;
}
```

### Output

```ts
interface AssistantSuggestionsFrameValue {
  kind: "assistant_suggestions";
  turn_id: string;
  suggestions: AssistantSuggestion[];   // capped at 4 (line 45 .slice(0, 4))
}

interface AssistantSuggestion {
  id: string;     // "s1", "s2", "s3", "s4"  (line 52)
  label: string;  // human-readable chip face
  value: string;  // string the user effectively "submits" if they tap
}
```

### Null returns

- `needsUserDecision(text, planningStep) === false` (line 33)
- After dedupe, `suggestions.length < 2` (line 46)

---

## 2 · Routing — `planningStep`, NOT `intent_bucket`

The brief says "per-bucket logic" but the TS code routes on `planningStep` only. `intent_bucket` doesn't appear anywhere in chip generation. Treat **planning step as the primary axis**.

```ts
// suggestionsForPlanningStep dispatch (lines 59-84)
clarification → cascade through 6 helper fns (first match wins)
selection     → selectionSuggestions(text)
confirmation  → confirmationSuggestions(text)
post_booking  → postBookingSuggestions(text)
```

`needsUserDecision()` gate (lines 86-97) is per-step:
- clarification → assistantText must end with `?` AND match `\b(pick|choose|tell me|what|which|when|how many|would you|should i|do you want|works)\b`
- selection → match `\b(pick|choose|select|option|offer|offers|which|nonstop|cheapest|fastest)\b`
- confirmation → match `\b(confirm|book|booking|final price|ready|tap|traveler|payment|change|cancel)\b`
- post_booking → match `\b(booked|confirmed|confirmation|next|hotel|ground|transport|calendar|receipt)\b`

---

## 3 · Per-step helpers — verbatim regex + chip text

These are the ground truth for behaviour parity. The Python port must reproduce regex triggers + chip strings exactly.

### Path A · `clarification` cascade (clarification only, first non-null wins)

**A0 · `asksForFreeTextIdentity` early-return → `null`** (line 67)
- regex: `\b(full name|legal name|traveler names?|passenger names?|passport|date of birth|dob)\b`
- emits zero chips — free-text identity input is a hard exit.

**A1 · `dateSuggestions(text, now)`** (lines 108-138)
- trigger: `\b(date|dates|when|return date|weekend|travel window)\b`
- 3 templated chips — `Next weekend`, `In 2 weeks`, plus either `Memorial Day weekend` (if before Memorial Day this UTC year) or `Mid-June (...)` fallback. Date math uses UTC (`utcDateOnly`, `nextWeekend(now, 1|2)`).

**A2 · `airportSuggestions(text, latestUser, userRegion)`** (lines 140-171)
- trigger: `\b(airport|origin|departure|depart|from where|which city|city should i use)\b` on the text
- haystack = `text + latestUser + userRegion` (lowercased)
- region branches:
  - `\b(chicago|chi)\b` → `Chicago O'Hare (ORD)` / `Chicago Midway (MDW)` / `Use either Chicago airport`
  - `\b(new york|nyc|manhattan|brooklyn)\b` → `JFK` / `LaGuardia (LGA)` / `Newark (EWR)`
  - `\b(sf|sfo|san francisco|bay area)\b` → `San Francisco (SFO)` / `Oakland (OAK)` / `San Jose (SJC)`
- no region match → `null` (cascade falls through)

**A3 · `tripShapeSuggestions(text)`** (lines 182-189)
- trigger: `\b(round ?trip|one-way|trip type|return flight)\b`
- 3 chips: `Roundtrip, 1 passenger` / `One-way, 1 passenger` / `Roundtrip, 2 passengers`

**A4 · `travelerSuggestions(text)`** (lines 173-180)
- trigger: `\b(how many|passengers?|travelers?|people|party size)\b`
- 3 chips: `Just me` / `Two travelers` / `Family of four`

**A5 · `budgetSuggestions(text)`** (lines 191-198)
- trigger: `\b(budget|price|spend|cap|limit|cheap|comfortable)\b`
- 3 chips: `Keep it lean` / `Mid-range` / `No hard limit`

**A6 · `comfortSuggestions(text)`** (lines 200-207)
- trigger: `\b(cheapest|fastest|comfortable|optimi[sz]e|priority|prefer)\b`
- 3 chips: `Cheapest` / `Fastest` / `Most comfortable`

### Path B · `selection` (lines 209-218)
- trigger: same regex as `needsUserDecision[selection]`
- 3 chips: `Cheapest` / `Fastest` / `Nonstop only`

### Path C · `confirmation` (lines 220-230)
- trigger: same regex as `needsUserDecision[confirmation]`
- 4 chips: `Confirm booking` / `Different traveler` / `Change dates` / `Cancel`

### Path D · `post_booking` (lines 232-241)
- trigger: same regex as `needsUserDecision[post_booking]`
- 3 chips: `Book hotel` / `Add ground transport` / `Send to calendar`

### Dedupe (lines 248-260)
- key = `${label.toLowerCase()}::${value.toLowerCase()}` (trimmed)
- empty label or value → drop
- preserves order on first occurrence
- final `.slice(0, 4)` after dedupe

---

## 4 · Discrepancies between brief's description and TS reality

The brief instructs "Mirror TS function signature in Python — same inputs". Three places where the brief's prose differs from the TS code; flagging because "mirror TS" is the directive and "mirror brief" would diverge:

| Brief says | TS actually | What I'll do (subject to reviewer) |
|---|---|---|
| inputs `last_user_message, last_assistant_message, intent_bucket, tool_calls_in_turn, history` | inputs `turnId, assistantText, planningStep?, latestUserMessage?, now?, userRegion?` | Mirror TS exactly. **`intent_bucket`, tool calls, history are NOT used.** |
| returns `list[str]` of 3-5 chips | returns `AssistantSuggestionsFrameValue \| null`; `suggestions: AssistantSuggestion[]` (0–4 items, returns `null` if <2) | Match TS — populate `PlanResponse.suggestions: list[Suggestion]` (already `{id,label,value}` per `lumo_ml/plan/schemas.py`). Empty list rather than null at the wire level since `PlanResponse.suggestions` is `list[Suggestion]` (not optional). |
| "≥ 80% mean Jaccard, ≥ 0.6 per-turn floor, no turn returning empty array" | TS returns null/empty for many turns by design — a chat-style "ok, let me look that up" with no `?` is supposed to emit zero chips | Eval expected-output rows must allow `[]` for non-decision turns; otherwise we'd score against an unreachable parity target. Will design eval to mark each canonical turn as either "expected chips" or "expected empty" and only Jaccard-score the "expected chips" turns. |

---

## 5 · Plan-client integration check (`apps/web/lib/lumo-ml/plan-client.ts`)

```bash
$ grep "x-lumo-\|x-Lumo" apps/web/lib/lumo-ml/plan-client.ts
plan-client.ts:84:  was_stub: response.headers.get("x-lumo-plan-stub") === "1",
```

- **Only `x-lumo-plan-stub` is read.** Headers I added in
  `INTENT-CLASSIFIER-MIGRATE-PYTHON-1` (`X-Lumo-Plan-Top-Score` / `X-Lumo-Plan-Gap` / `X-Lumo-Plan-Confidence`) aren't consumed by this client yet — codex would need to extend the client to pick them up. Same applies to whatever `X-Lumo-Suggestions-*` headers I add here.
- `normalizeSuggestions()` already handles `suggestions: AssistantSuggestion[]` from the response body (lines 152-172): caps `id` 80 chars, `label` 120, `value` 240, max 4 suggestions. **My Python output must satisfy these caps** — `Suggestion` Pydantic field bounds already do (id 80, label 200, value 2000) but value is wider than plan-client expects. Plan-client truncates silently; not a wire break, just dropped chars at the consumer.
- **No `X-Lumo-Suggestions-*` collision.** Names are free.

---

## 6 · Migration number — 056 vs 057

```bash
$ ls db/migrations/ | tail -3
053_user_app_approvals.sql
054_agent_plan_compare.sql
055_compound_rpc_cycle_guard.sql
```

- Brief specifies migration **057**.
- Next available is **056**.
- No 056 is in flight on `main` (just verified).
- Possible interpretations:
  1. Reviewer reserved 056 for codex's `DEEPGRAM-MIGRATION-1` — I take 057.
  2. Brief had a stale assumption about migration count — I take 056.
- **Question for reviewer:** which? Will use 056 by default unless told otherwise (per CLAUDE.md doctrine: "Numbering continues the global sequence").

---

## 7 · `agent_plan_compare` schema today (migration 054)

```sql
-- db/migrations/054_agent_plan_compare.sql, columns 15-50
id                 bigint identity primary key
session_id         text not null
turn_id            text not null
user_id            uuid references public.profiles(id)
ts_intent_bucket   text  -- fast_path|tool_path|reasoning_path|null
py_intent_bucket   text
ts_planning_step   text  -- clarification|selection|confirmation|post_booking|null
py_planning_step   text
agreement_bucket   boolean  -- null when either side is null
agreement_step     boolean
ts_latency_ms      integer
py_latency_ms      integer
py_was_stub        boolean
py_error           text
created_at         timestamptz default now()
```

Migration 056/057 would add (per the brief):

```sql
suggestions_python  text[] not null default '{}'
suggestions_ts      text[] not null default '{}'
suggestions_jaccard real
```

Append-only constraint and RLS on the existing table apply automatically. Reverse migration drops the three columns.

---

## 8 · Header naming proposal (per brief)

Goes onto `POST /api/tools/plan` response on every classified turn. Will be skipped only if no suggestions logic ran (e.g., guard short-circuit could omit them — TBD whether the flight-search guard implies a planning step at all).

```
X-Lumo-Suggestions-Source: python              # always "python" for this lane
X-Lumo-Suggestions-Count:  N                   # 0..4 (TS caps at 4)
```

**Question for reviewer:** the brief says `python|ts|both` for `Source`. Since this endpoint is entirely Python-side, `Source: python` is always true here. Suggesting `Source` field stays for forward-compat (if Phase 2 ever splices TS-fallback chips in) but `both` won't apply in this lane. Confirm `python` is correct for now?

For the existing classifier headers I added in the prior lane, they use the pattern `X-Lumo-Plan-<Field>` — these new ones use `X-Lumo-Suggestions-<Field>`. Distinct prefix is intentional; codex's `agent_plan_compare` row capture can switch on prefix.

---

## 9 · Eval-harness design proposal

Per brief: **30+ canonical conversation turns covering each `intent_bucket` (≥10 per bucket).** This conflicts with the TS routing (which uses `planningStep`, not `intent_bucket`). Two ways to resolve:

**Option α — `planningStep`-keyed corpus (what the TS code actually does):**
- ≥ 8 turns per `planningStep` (4 steps × 8 = 32 turns)
- Each row: `assistantText, planningStep, latestUserMessage?, userRegion?, expected_chips_or_empty`
- Score: per-turn Jaccard on label set (or `expected="empty"` → no Jaccard, just assert empty)

**Option β — `intent_bucket`-keyed corpus per the brief letter:**
- 10 turns per bucket × 3 = 30 turns. But intent_bucket has no causal effect on chip output — would just measure the joint distribution of `planning_step | intent_bucket` in the test corpus. Score wouldn't tell us anything specific to the chip code.

I recommend **α** as the closest analog to "covers every chip-generation path". 32 turns get every helper (A0–A6, B, C, D) at least 2× plus boundary cases (wrong-step text, no `?`, free-text identity, region-less airport ask). Will produce the same kind of calibration table format as `test_intent_classifier_eval.py`.

**Question for reviewer:** OK to switch the corpus key from `intent_bucket` to `planning_step`?

---

## 10 · Migration strategy proposal

**Port one file, line-by-line.**

1. Create `apps/ml-service/lumo_ml/plan/suggestions.py` with `build_assistant_suggestions(...)` mirroring `buildAssistantSuggestions()` 1:1. Helpers as private module-level functions; regex constants module-level so they're compiled once.
2. Date helpers (`next_weekend`, `memorial_day_weekend`, `format_range`, `format_date_value`, `month_name`) — mirror via `datetime.timezone.utc`. Match `Intl.DateTimeFormat("en-US", { month: "long" })` output by hardcoding English month names (avoids Python-locale dependency).
3. Wire into `lumo_ml/plan/router.py`:
   - Pull `assistantText` from where? Current `PlanRequest` doesn't have an assistant-text field — see open question 11.4 below.
   - Set `X-Lumo-Suggestions-Source` / `X-Lumo-Suggestions-Count` headers.
4. `PlanRequest` may need a new field `last_assistant_message: str | None` to feed the suggestion builder. Pydantic + codegen + drift-check will catch the schema delta cleanly. **This is a wire-shape addition for the request, not the response — backwards-compatible (defaults to None on TS callers that don't supply it).**

---

## 11 · Open questions for reviewer

### 11.1 — Migration number 056 vs 057?
Default plan: 056 (next available). Override?

### 11.2 — `planning_step`-keyed eval corpus instead of `intent_bucket`-keyed?
Option α (planning_step) is what the TS code actually routes on; option β (intent_bucket) per brief letter scores noise. Recommend α.

### 11.3 — `X-Lumo-Suggestions-Source: python` for now?
Brief lists `python|ts|both`. `both` requires an integration point that doesn't exist yet. OK to ship `python` only and reserve other values for a later lane?

### 11.4 — `PlanRequest` needs an `assistantText` input field
The TS `buildAssistantSuggestions()` reads the assistant's response text — that's *the assistant's CURRENT-turn output*, not the user's message. The current `PlanRequest` schema has `user_message: str` and `history: list[ChatTurn]` but no field for the assistant text under generation. Three options:

- **(a)** Add `last_assistant_message: str | None = None` to `PlanRequest`. Codex updates plan-client to pass it. Wire-shape additive.
- **(b)** Look up the most recent `role="assistant"` entry in `history` server-side. Brittle: history may not contain it yet during clarification turns.
- **(c)** Skip suggestion generation when no assistant text is available — return `[]` and let TS fall back. Practical for shadow-write but limits parity numbers.

Recommend **(a)** — clean schema delta, codegen catches consumer drift, codex updates plan-client to pass it (small change). **Need reviewer to OK the `PlanRequest` extension before scope work.**

### 11.5 — Empty-array semantics
TS returns `null` (no frame emitted) when fewer than 2 dedupe'd suggestions or `needsUserDecision === false`. Python `PlanResponse.suggestions` is `list[Suggestion]` (not optional). I'll emit `[]` in those cases. Codex's plan-client treats both null-frame and empty-array as "no suggestions" — verifying that's safe.

---

## 12 · Coordination

- **codex** owns plan-client + `agent_plan_compare` capture. After this lane lands, codex needs a small follow-up to:
  - read the new headers (`X-Lumo-Suggestions-Source`, `X-Lumo-Suggestions-Count`)
  - read `response.suggestions` (already does — line 107 of plan-client)
  - write `suggestions_python text[]` into `agent_plan_compare`
  - parallel-write the TS `buildAssistantSuggestions()` output into `suggestions_ts text[]`
  - compute `suggestions_jaccard` server-side
- I won't touch `apps/web/`. Codex's follow-up is logged in the post-merge review report.
- Brief mentions DEEPGRAM-MIGRATION-1 doesn't collide; verified — DEEPGRAM is voice STT, not /plan.

---

## 13 · What I'm waiting on before scope work

1. Migration number confirmation (056 default, or 057 reserved).
2. `planning_step` vs `intent_bucket` eval corpus (recommending `planning_step`).
3. `X-Lumo-Suggestions-Source: python` only (or expect `both` plumbing in this lane).
4. `PlanRequest.last_assistant_message` field addition approved.
5. Empty-array null-semantics for "no suggestions" turns confirmed.

Once those are answered, scope work proceeds in a single push: `suggestions.py` + router wiring + `PlanRequest` extension + migration 056 + eval harness + tests + Modal redeploy + push for FF-merge review.
