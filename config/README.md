# `config/`

Config files the Lumo **shell** (the orchestrator at `apps/web`) reads on boot.
Each sub-agent lives in its own repo and is referenced here by URL — we never
import sub-agent code into the shell.

## Files

| File | Who reads it | When |
| --- | --- | --- |
| `agents.registry.json` | `apps/web/lib/agent-registry.ts` → `loadRegistry()` | On cold start and on SIGHUP. Default path in dev. |
| `agents.registry.prod.json` | same | In prod when `LUMO_REGISTRY_PATH` points here. |

## Schema

```ts
interface RegistryConfigFile {
  agents: Array<{
    key: string;       // stable short id, used in logs and the registry map
    enabled: boolean;  // false = skip on load (still dispatches 404 if called)
    system?: boolean;  // Lumo-owned auto-install policy; never manifest-owned
    base_url: string;  // agent's public hostname, no trailing slash
    version?: string;  // semver range in dev, exact pin in prod
  }>;
}
```

Each agent at `base_url` **must** expose:

- `GET /.well-known/agent.json` — the `AgentManifest` (see `@lumo/agent-sdk`)
- `GET /openapi.json` (or whatever `manifest.openapi_url` points at) — OpenAPI 3.1
  with `x-lumo-tool: true` on every operation the orchestrator can call
- `GET /api/health` — a `HealthReport` (see `@lumo/agent-sdk/health`)

If any of the three 404s or fails validation, the shell logs and **skips that
agent** — the rest of the platform keeps running. This is the fault-isolation
promise the whole architecture is built around.

`system: true` is reserved for Lumo-owned agents such as `lumo-ml`. A system
agent is auto-eligible for authenticated users in `userScopedBridge()` without a
per-user install row. The bit is only read from this registry config; partner
manifests and marketplace submissions cannot self-declare it.

## Env selection

The shell resolves the path in this order:

1. `configPath` argument to `loadRegistry(path)` — tests only
2. `process.env.LUMO_REGISTRY_PATH` — prod deployment sets this
3. `<repo>/config/agents.registry.json` — default for local dev

## Rollout protocol

1. Dev: flip `enabled: true` in `agents.registry.json`, run the agent locally.
2. Staging: deploy the agent behind `https://<key>.agents.staging.lumo.rentals`,
   add the entry to `agents.registry.prod.json` with `enabled: false`, deploy
   shell, flip to `true` via a small config-only PR when the on-call is ready.
3. Prod: cut a new agent release, pin the exact `version` in this file, deploy.

## What NOT to put here

- Secrets — those go in the agent's own env, never in registry config.
- Feature flags — those belong in LaunchDarkly / Unleash / whatever.
- Per-user config — fetched at request time, not boot time.
