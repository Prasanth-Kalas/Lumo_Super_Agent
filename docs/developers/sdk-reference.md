# SDK reference

The authoritative spec for the Lumo Agent SDK. Pairs with the types in `@lumo/agent-sdk` (lives at `../Lumo_Agent_SDK/src/`).

## Versions

SDK version tracks semver. The current version is **0.4**. Breaking changes bump the major; feature additions bump the minor; fixes bump the patch. Manifests declare the SDK version they target via `sdk_version`.

Lumo's registry accepts manifests targeting any SDK version within the same major as the running Super Agent. Minor-version mismatches are soft-warned in logs but not rejected — the registry only reads fields it knows about.

## `AgentManifest` — top-level shape

```ts
interface AgentManifest {
  sdk_version: string;                    // e.g. "0.4.0"
  agent_id: string;                       // unique, kebab-or-snake case, stable across versions
  version: string;                        // your agent's version — semver, bump per release
  display_name: string;                   // what the user sees ("Lumo Flights")
  one_liner: string;                      // single-sentence value prop
  domain: string;                         // loose taxonomy: "travel", "food", "productivity"
  intents: string[];                      // short intent keywords the orchestrator matches on
  example_utterances: string[];           // natural-language examples that should trigger your agent
  connect: AgentConnect;                  // OAuth / Lumo-ID / none
  base_url: string;                       // public URL where tools are served
  openapi_url: string;                    // absolute or relative URL to your OpenAPI doc
  ui?: AgentUI;                           // rendering hints for result cards
  listing?: AgentListing;                 // marketplace metadata
  pii_scope?: string[];                   // personal-data categories your tools may touch
  requires_payment?: boolean;             // true when any capability can spend money
  cost_model?: AgentCostModel;            // max cost ceilings for COST-1 enforcement
  health_url?: string;                    // defaults to "{base_url}/api/health"
  sla?: AgentSla;                         // optional performance expectations
  on_call_escalation?: string;            // ops contact; free-form
}
```

### `AgentConnect` — the auth contract

Discriminated union with three variants:

```ts
type AgentConnect =
  | { model: "none" }
  | { model: "lumo_id" }                            // first-party only
  | {
      model: "oauth2";
      provider: string;                             // "google", "microsoft", "spotify", or custom
      authorize_url: string;                        // provider's authorize endpoint
      token_url: string;                            // provider's token endpoint
      revoke_url?: string;                          // provider's revoke endpoint (optional)
      scopes: Array<{
        name: string;                               // e.g. "https://www.googleapis.com/auth/gmail.readonly"
        description: string;                        // human-readable — shown on the marketplace card
        required: boolean;                          // if false, Lumo can still fetch token without it
      }>;
      client_id_env: string;                        // name of the env var Lumo reads (e.g. "LUMO_GOOGLE_CLIENT_ID")
      client_secret_env: string;                    // same for secret
      pkce: "S256" | "plain" | "none";              // PKCE method; S256 unless the provider insists otherwise
      refresh_model?: "rotating" | "fixed";         // whether refresh tokens rotate on use (Microsoft: rotating; Google/Spotify: fixed)
    };
```

- `"none"` — your agent takes no user auth. The quickstart Weather agent is this flavor.
- `"lumo_id"` — reserved for first-party agents that don't need an external OAuth but want the "connected" chip UX (e.g. Flight, Food, Hotel). The Super Agent dispatches to these via `dispatchInternalTool` — no HTTP hop.
- `"oauth2"` — the general third-party case. See [oauth-integration.md](oauth-integration.md).

### `AgentUI` — card rendering hints

```ts
interface AgentUI {
  components?: string[];                  // which result-card components to load (e.g. ["FlightOffersSelectCard"])
  remote_url?: string;                    // CDN URL if your cards are federated / remote-loaded
  native_package?: string;                // npm package name if distributed there
}
```

The Super Agent ships with a standard component library (`FlightOffersSelectCard`, `FoodMenuSelectCard`, `ItineraryConfirmationCard`, `TimeSlotsSelectCard`, `ReservationConfirmationCard`, `TripConfirmationCard`). If your tool returns data in a shape one of these components expects, name it here and it'll render automatically.

For custom card components, see the `remote_url` / `native_package` options (documented in the SDK readme; not required for MVP).

### `AgentListing` — marketplace metadata

```ts
interface AgentListing {
  category?: string;                      // "Travel", "Productivity", "Personal"
  about_paragraphs?: string[];            // detailed description on /marketplace/[agent_id]
  logo_url?: string;                      // absolute URL or relative to base_url
  pricing_note?: string;                  // "Free — read-only by default" style
  privacy_note?: string;                  // plain-English privacy summary
  policy_urls?: {
    terms?: string;
    privacy?: string;
  };
}
```

### Cost and permission fields

PERM-1 and COST-1 read policy from the manifest before a user installs an
agent. At minimum, production agents should declare what user data they touch
and the maximum cost of one invocation:

```ts
interface AgentCostModel {
  max_cost_usd_per_invocation: number;
  projected_cost_usd?: number;
}

interface AgentManifest {
  pii_scope?: Array<"name" | "email" | "phone" | "payment_method_id" | "traveler_profile" | string>;
  requires_payment?: boolean;
  cost_model?: AgentCostModel;
}
```

The install route turns those declarations into user-facing consent text. If a
scope has a spend cap, the grant constraints use:

```json
{
  "up_to_per_invocation_usd": 5,
  "per_day_usd": 20,
  "specific_to": "optional user-facing bound"
}
```

The runtime enforces the minimum of the manifest ceiling, the user's grant cap,
and the user's remaining budget. A user may lower a cap during install; they may
not raise it above the manifest default.

## OpenAPI conventions

Your OpenAPI document is a standard OpenAPI 3.1 spec with a handful of Lumo-specific extensions under `x-lumo-*`.

### Minimum shape

```jsonc
{
  "openapi": "3.1.0",
  "info": { "title": "...", "version": "..." },
  "paths": {
    "/api/tools/<operation_id>": {
      "post": {
        "operationId": "<operation_id>",
        "summary": "Short, actionable description",
        "description": "Longer description — used in Claude's tool catalog",
        "requestBody": { /* JSON Schema */ },
        "responses": { "200": { ... } },
        "x-lumo-autonomy": "read_only" | "safe_write" | "spend" | "message" | "destructive"
      }
    }
  }
}
```

### `operationId` → tool name

Claude sees your tool as an object with the `operationId` as its name. This is the thing Claude "decides to call". Pick a clear verb-noun: `flight_search`, `gmail_search_messages`, `calendar_create_event`. Not `v1_flights` or `do_thing`.

### `summary` and `description`

Both end up in Claude's tool catalog. `summary` should be one line, verb-led, unambiguous. `description` can be longer and should cover:

- What the tool does.
- When to call it vs. not.
- What the arguments mean (especially the non-obvious ones).

Good tool selection starts with good description writing. This is the single highest-leverage thing you can do for agent UX.

### Request / response schemas

Standard JSON Schema. A few Lumo conventions:

- Prefer **explicit `required`** arrays over implicit optional-everywhere.
- Use **semantic enums** where applicable — `"units": { "enum": ["metric", "imperial"] }` is clearer than accepting any string.
- **Dates are strings** in `YYYY-MM-DD` format for naive dates; ISO-8601 for timestamps. Don't invent your own format.
- **Currency is always `{ amount_cents: number, currency: "USD" }`.** Never floats.

### The `x-lumo-autonomy` extension

One of:

- `read_only` — no side effects. Always auto-approved.
- `safe_write` — side effects exist but are reversible / cheap (save a draft, hold a booking). Auto-approved except in Cautious tier.
- `spend` — costs money. Goes through the spend-cap check.
- `message` — sends a message to a human on the user's behalf. Extra consent bar on Cautious tier.
- `destructive` — irreversible (delete, publish). Always confirms regardless of tier.

The autonomy engine reads this field to decide whether to gate the call.

### The `x-lumo-confirmation-card` extension

If your tool returns a payload that should render a confirmation card instead of an auto-action, include `x-lumo-confirmation-card: true` on the response schema. The card can be one of the built-in components or a custom one.

Example: a "book_flight" tool that returns `{ flight_offer, requires_confirmation: true, card: { kind: "flight_confirm", ... } }`. The Super Agent renders the card; the user taps Confirm; Lumo re-calls the tool with the confirmation token and the booking actually happens.

### Author bundle signatures

TRUST-1 verifies submitted bundles with ECDSA-P256 signatures. The SDK CLI signs
this canonical payload:

```text
lumo-agent-bundle:v1:<agent_id>:<version>:<bundle_sha256>
```

Verified and official submissions require a valid active developer key.
Experimental submissions can run unsigned in v1, but signing every bundle is
recommended so revocation and incident response have a clean fingerprint trail.

## Error shape

Every non-2xx response should include a body like:

```json
{
  "error": {
    "code": "<AgentErrorCode>",
    "message": "Human-readable explanation",
    "retryable": true
  }
}
```

`AgentErrorCode` values (from `@lumo/agent-sdk`):

- `invalid_input` — schema validation failed.
- `connection_required` — user hasn't connected this agent (unusual — the Super Agent wouldn't dispatch in that case).
- `connection_refresh_failed` — OAuth refresh failed; user needs to reconnect.
- `rate_limited` — upstream or agent rate limit.
- `unavailable` — transient upstream error.
- `provider_error` — upstream returned an error we don't have a specific code for.
- `forbidden` — scope missing or autonomy denied.
- `unknown` — everything else.

The orchestrator translates these into user-facing responses via Claude. `retryable: true` hints that a manual retry might work; Claude may propose one.

## Health endpoint

`GET /api/health` (or whatever your `health_url` says). Return 200 with a JSON body:

```json
{
  "ok": true,
  "version": "<your agent version>",
  "timestamp": "<ISO>",
  "upstream": {
    "google_maps": { "ok": true, "latency_ms": 42 }
  }
}
```

The registry reads `ok` only. The `upstream` block is optional and surfaces in Super Agent logs when present. The registry probes the health endpoint every 5 minutes by default and caches the result. A 500 or non-`ok=true` response makes the agent unavailable for orchestration.

## Internal agents — the `internal://` base_url shortcut

Four first-party agents (Flight, Food, Hotel, Restaurant) and three OAuth adapters (Google, Microsoft, Spotify) use a `base_url: "internal://<agent_id>"` convention. When the router sees this protocol, it calls `dispatchInternalTool(agent_id, tool_name, args)` directly in-process — no HTTP. This is faster and simpler for agents that live alongside the Super Agent code.

Unless you're a first-party Lumo team member, you don't use this. External agents always use a real HTTPS URL.

## Versioning your manifest

- Bump `version` on every meaningful change.
- Bump `sdk_version` only when you adopt a newer SDK release.
- Tool behavior changes that Claude needs to know about (new required argument, different response shape) should be reflected in the OpenAPI. The registry re-fetches every probe — Claude's catalog picks up changes within minutes.
- Breaking changes are rare for agents and should be accompanied by a manifest-level note in `listing.about_paragraphs` telling users they may see different behavior.

## Code references

- `Lumo_Agent_SDK/src/manifest.ts` — type definitions.
- `Lumo_Agent_SDK/src/openapi.ts` — shared OpenAPI helpers.
- `Lumo_Agent_SDK/src/errors.ts` — `AgentError` type.
- `Lumo_Agent_SDK/src/health.ts` — health response helpers.
- `Lumo_Agent_SDK/src/confirmation.ts` — confirmation card types.
- `Lumo_Agent_SDK/src/types.ts` — shared utility types (currency, dates).

## Related

- [quickstart.md](quickstart.md) — your first agent.
- [authoring-guide.md](authoring-guide.md) — naming, UX, intent design.
- [oauth-integration.md](oauth-integration.md) — OAuth-specific details.
- [testing-your-agent.md](testing-your-agent.md) — local simulation of the router.
- `docs/architecture/orchestration.md` in the Lumo repo — how the Super Agent dispatches into your agent.
