# Orchestration

The "pick the right tool and call it" layer. This is where Claude, the tool router, and the agent registry meet.

## What it does (one paragraph)

Every user turn goes through an orchestration loop: Claude gets the thread + a compiled system prompt + the set of currently-available tools, picks a tool (or answers directly), the router dispatches the tool call to the right agent, the result comes back to Claude, and the loop continues until Claude has a final answer. The whole thing streams to the client as SSE so the user sees progress in real time.

## Where it lives

- **`lib/orchestrator.ts`** — The Claude loop. Composes the system prompt, drives Anthropic's messages API with tool use, emits SSE events.
- **`lib/router.ts`** — Tool-to-agent dispatch. Resolves an agent from `lib/agent-registry.ts`, attaches OAuth tokens if needed, calls the agent's HTTP endpoint (or dispatches internally), translates errors into `AgentError`.
- **`lib/agent-registry.ts`** — Loads agent manifests, runs health probes, caches results, exposes a "what tools are available?" view to the orchestrator.
- **`lib/system-prompt.ts`** — The persona + composition rules. Combines base prompt, user memory, ambient context, and active-agent tool metadata into a final string.
- **`lib/meta-tools.ts`** — Tools that act on Lumo itself rather than an external agent (`memory_save`, `memory_forget`, `profile_update`, `intent_create`, etc.).
- **`app/api/chat/route.ts`** — The HTTP entry point. Resolves the user, calls the orchestrator, streams SSE back.

## Data flow

```
[client POST /api/chat]
      │
      ▼
  resolveUser()   ──────────────┐
      │                         │
      ▼                         │
  buildSystemPrompt():          │
    - base persona              │
    - user profile              │◄── lib/memory.ts (getProfile)
    - relevant facts    ◄───────┤     lib/memory.ts (retrieveRelevantFacts)
    - ambient context           │
    - tool catalog      ◄───────┤     lib/agent-registry.ts
      │                         │
      ▼                         │
  orchestrator.run():           │
    loop:                       │
      ├─ anthropic.messages.create(tools=[...])
      ├─ on content_block_delta → SSE
      ├─ on tool_use:
      │    ├─ router.dispatch(tool, args)  ◄─── lib/router.ts
      │    │     ├─ meta-tools (memory_save, etc.)
      │    │     ├─ internal agents (Flight, Food, etc.)
      │    │     └─ external HTTP agents (OAuth'd)
      │    └─ result back to Claude as tool_result
      └─ if no tool_use → answer is final
      │
      ▼
  [SSE event stream to client]
```

## The system prompt

Composed per turn (not cached) because it includes user-specific context that changes. Structure (from `lib/system-prompt.ts`):

```
{base Lumo persona}

You're talking to {user.first_name}.
Their timezone: {profile.timezone}. Preferences: ...
Time now: {ambient.local_time}.  Location (if shared): {ambient.city}.

Things the user has told you that matter right now:
- {fact_1}
- {fact_2}
...

Patterns noticed about this user:
- {pattern_1}
- {pattern_2}
...

Available tools (call by name):
{tool_catalog}
```

The fact + pattern blocks are the output of `retrieveRelevantFacts(userId, query, topK=5)` — cosine-similarity against the user's embeddings filtered by a minimum similarity threshold.

The tool catalog is filtered to tools whose agent is healthy AND (for OAuth'd agents) the user has an active connection. This means if you haven't connected Google, Gmail-related tools don't even appear to Claude — it can't hallucinate "I'll check your email" when it literally has no such tool exposed.

## Model and configuration

- **Model**: `claude-sonnet-4-6` (was `claude-sonnet-4-0`; bumped after quality testing).
- **Temperature**: 0.3 — high enough for natural phrasing, low enough for consistent tool-calling.
- **Max tokens**: 4096 per turn. Long conversations handled by the thread history, not per-turn output.
- **Streaming**: `stream=true`, events forwarded through Next.js Response body as SSE `text/event-stream`.

The model ID is a constant at the top of `lib/orchestrator.ts` — one-line change to swap models.

## Tool execution path

When Claude emits a `tool_use` block:

1. The orchestrator captures `(tool_name, input)`.
2. `router.dispatch(tool_name, input, userId, sessionId)` is called.
3. Router consults `agent-registry.getToolOwner(tool_name)` to find the agent.
4. If the agent's `connect.model === "oauth2"`:
   - `connections.getActiveConnection(userId, agentId)` fetches the sealed tokens.
   - If no active connection: returns `{ error: "connection_required", agent_id }` — the orchestrator folds this into a user-facing "I'll need you to connect Google first" reply.
   - If the connection is expired, the router attempts a silent refresh using the refresh token; on failure returns `{ error: "connection_refresh_failed" }`.
5. If the agent is an **internal agent** (`base_url === "internal://<agent_id>"`), the router calls `dispatchInternalTool` directly — no HTTP hop. This is what the four first-party agents (Flight, Food, Hotel, Restaurant) plus the Google/Microsoft/Spotify adapters use.
6. If the agent is an **external HTTP agent**, the router makes an HTTP POST to the agent's endpoint with the OAuth token as a Bearer header.
7. The response is validated against the tool's OpenAPI schema and returned to Claude as a `tool_result` block.
8. An event row is written via `lib/events.ts` — tool name, agent, duration, outcome.

## Meta-tools

A few tools don't dispatch to external agents — they act on Lumo's own state. Defined in `lib/meta-tools.ts`:

- `memory_save(content, importance?)` — writes to `user_facts`.
- `memory_forget(fact_id)` — deletes a specific fact.
- `profile_update(field, value)` — updates one field of `user_profile`.
- `intent_create(title, description, cron, action_mode, guardrails)` — creates a standing intent.
- `intent_update(id, ...)` / `intent_delete(id)` — edit/remove an intent.

These are advertised to Claude just like external tools, so "remember that I prefer aisle seats" naturally triggers `memory_save`. The advantage: the model is making explicit calls, which show up in the event log and can be audited.

## Error handling

All tool errors come back as a structured `AgentError` shape:

```ts
interface AgentError {
  code:
    | "unavailable"            // agent health is bad
    | "connection_required"    // user must connect
    | "connection_refresh_failed"
    | "rate_limited"
    | "provider_error"
    | "invalid_input"
    | "forbidden"              // autonomy gate blocked
    | "unknown";
  message: string;
  agent_id?: string;
  retryable?: boolean;
}
```

The orchestrator folds these into Claude's context as tool_result content (not as raised exceptions), so Claude can produce a graceful user-facing response like "I can't reach your calendar right now — want me to try again in a minute, or queue this?".

## Autonomy gating

Before any tool that spends money or sends a message executes, `lib/autonomy.ts` runs `evaluateAutonomy(userId, tool, args)`:

1. Check kill-switch — if `kill_switch_until > now()`, return `requires_confirmation`.
2. Check tier — look up the user's `user_autonomy.tier` and the tool's `x-lumo-autonomy` hint (from the manifest: "spend", "message", "read_only", etc.).
3. Check spend cap — sum today's `autonomous_actions.cost_cents` plus the pending action's cost; if over `daily_cap_cents`, return `requires_confirmation`.
4. Return `{ decision: "approve" | "requires_confirmation", reasoning }`.

If the decision is `requires_confirmation`, the router short-circuits and returns a confirmation card payload to the client. The user taps Approve, and the same tool call is re-issued with a confirmation token that bypasses the gate.

Every approved autonomous action is logged to `autonomous_actions` — that's what populates `/autonomy`'s action log.

## Streaming format

Events emitted on the SSE channel (each is a `data: {...}\n\n` frame):

| Event type | Payload | Purpose |
|---|---|---|
| `content_block_start` | block metadata | A new text/tool block is starting. |
| `content_block_delta` | incremental text | Token-by-token stream; client appends to the growing response. |
| `content_block_stop` | none | Block done. |
| `tool_use` | `{ name, input }` | Claude is calling a tool. Client may show a "Checking Gmail…" indicator. |
| `tool_result` | `{ output, duration_ms }` | The tool returned. |
| `confirmation` | card payload | Autonomy gate needs user approval. |
| `error` | `{ code, message }` | Fatal for this turn. |
| `done` | none | Turn complete. |

## Failure modes

- **Model unavailable (Anthropic 5xx / timeout).** Orchestrator emits an `error` event with `code: "model_unavailable"` and the UI renders a "try again in a moment" banner.
- **Tool throws unexpectedly.** Caught by the router, converted to `AgentError` with `code: "unknown"`, returned to Claude. Claude typically apologizes and offers an alternative.
- **Infinite loop** (Claude keeps calling the same tool). Orchestrator enforces a max of 10 tool-use rounds per turn; on the 11th, it emits an `error` and lets the user know. Rare in practice.
- **SSE connection drops.** Client retries once on network error; on the second failure, the turn is considered failed and the partial response is shown with a "Reply incomplete" note.

## Extension points

**Adding a new tool to an existing agent.** Update the agent's OpenAPI to include the new operation. The next registry probe picks it up. No Super Agent code changes.

**Adding a new meta-tool.** Add the definition to `lib/meta-tools.ts` with a handler. It auto-registers into the catalog.

**Swapping the model.** Change `MODEL` in `lib/orchestrator.ts`. The tool-use API shape is stable across Anthropic model versions; a swap to Opus for complex tasks would be one-line.

**Changing how facts are retrieved.** `retrieveRelevantFacts` in `lib/memory.ts` has a pluggable scoring function (cosine + recency + importance, weighted). Tune weights or add terms there without touching the orchestrator.

## Related

- [Memory system](memory-system.md) — how facts get into the prompt.
- [OAuth + tokens](oauth-and-tokens.md) — how the router gets the token in step 4.
- [developers/sdk-reference.md](../developers/sdk-reference.md) — what an agent needs to implement to be dispatched.
