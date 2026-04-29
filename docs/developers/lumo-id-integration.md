# Lumo-ID integration — internal / first-party agents

Most third-party agents use `connect.model: "oauth2"` — users connect their own accounts. A small set of **first-party agents** use `"lumo_id"` instead: they don't need external auth because they live in the same trust boundary as the Super Agent.

## When to use `lumo_id`

Only when:

- The agent ships alongside the Super Agent deployment (same operator, same trust boundary).
- The agent doesn't need to act on behalf of the user at a third party.
- You want the "Connected" chip UX on `/marketplace` without an OAuth flow.

Today this is the four reference agents (Flight, Food, Hotel, Restaurant) and the three OAuth *adapters* (google, microsoft, spotify — which internally use `oauth2` but are registered under the same internal-dispatch pattern for routing efficiency).

If you're building a **third-party** agent, do not use `lumo_id`. Use `"none"` (no user auth) or `"oauth2"` (user auth).

## What `lumo_id` does differently

### No HTTP hop

When `base_url: "internal://<agent_id>"`, the router calls `dispatchInternalTool(agent_id, tool_name, args)` directly in the Super Agent's process. Same JavaScript VM, no network round-trip.

This requires the agent's handlers to be importable by the Super Agent. Concretely: internal agents live as files under `lib/integrations/<agent_id>*.ts` and register their tools through `lib/integrations/registry.ts`.

### No token storage

There's no `agent_connections` row for lumo_id agents. The connection is implied by "the user has an account on this Lumo deployment". The marketplace card shows CONNECTED the moment the user is signed in.

### Same OpenAPI + manifest contract

Even though there's no HTTP hop, the manifest + OpenAPI still exist. They're served from the Super Agent itself (synthesized in `lib/integrations/registry.ts`) and look identical to what an external agent would serve. Claude's tool catalog has no idea whether dispatch is in-process or over HTTP.

## Registering an internal agent

### 1. Write the handlers in `lib/integrations/<agent_id>.ts`

```ts
// lib/integrations/my-internal-agent.ts

export const MY_AGENT_ID = "my_internal";

export async function myToolSearch(
  args: { query: string },
  userId: string,
): Promise<MySearchResult> {
  // Do the work. Access lib/db.ts, lib/memory.ts, whatever.
  return { results: [...] };
}

// ... more handler functions ...
```

### 2. Register in `lib/integrations/registry.ts`

Add the agent's synthesized manifest + dispatch table to the internal-agents registry:

```ts
// lib/integrations/registry.ts

export function getInternalAgentEntries(): InternalAgent[] {
  return [
    // ... existing agents ...
    {
      manifest: {
        sdk_version: "0.4.0",
        agent_id: "my_internal",
        display_name: "My Internal Agent",
        // ... all the usual manifest fields ...
        connect: { model: "lumo_id" },
        base_url: "internal://my_internal",
        openapi_url: "/api/internal/my_internal/openapi",
      },
      openapi: {
        // synthesized inline, or imported from a constant
      },
      dispatch: {
        my_tool_search: myToolSearch,
      },
    },
  ];
}
```

### 3. Wire the dispatch table

`dispatchInternalTool` in the same file looks up the agent by ID and calls the handler by tool name:

```ts
export async function dispatchInternalTool(
  agentId: string,
  toolName: string,
  args: unknown,
  userId: string,
): Promise<unknown> {
  const entry = internalAgents.find((a) => a.manifest.agent_id === agentId);
  if (!entry) throw new AgentError("unknown", `No internal agent: ${agentId}`);
  const handler = entry.dispatch[toolName];
  if (!handler) throw new AgentError("unknown", `No tool: ${toolName}`);
  return handler(args, userId);
}
```

### 4. Registry wiring

Finally, `lib/agent-registry.ts` merges internal agents into the main registry via `mergeInternalIntoBridge()`. This is automatic — adding an entry in step 2 is enough; you don't have to touch the registry module.

## Health

Internal agents don't have a real health endpoint (there's no HTTP). `lib/agent-registry.ts` treats them as always healthy unless you override. If you want a soft health signal (e.g. "Google credentials missing → Google adapter is unhealthy"), return the status from a `getInternalHealth(agentId)` function registered with the agent.

## OAuth adapters as `internal`

The Google/Microsoft/Spotify integrations are interesting — they're `connect.model: "oauth2"` (users do connect their own provider accounts), but their manifests have `base_url: "internal://<agent_id>"` and their dispatch is in-process. The `connect` block still drives the OAuth flow through the Super Agent's standard `/api/connections/start` + `/callback` plumbing; the actual tool calls happen in-process with the decrypted token.

This hybrid pattern keeps the provider-specific code (Gmail search, Calendar create, Spotify play) inside the Super Agent binary rather than splitting it into separate HTTP services. Good for first-party adapters; don't try to do this with a third-party agent (you'd need them to share process with the Super Agent, which isn't realistic).

## When NOT to use lumo_id

- You're building a third-party agent.
- You want your agent to be runnable independently of the Super Agent.
- You want independent deploy cadence.

In all those cases, host your own HTTP service and use `"none"` or `"oauth2"` as your connect model.

## Related

- [sdk-reference.md](sdk-reference.md) — full manifest spec.
- `docs/architecture/orchestration.md` in the Lumo repo — the router's dispatch logic.
- `lib/integrations/registry.ts` — where internal agents register.
