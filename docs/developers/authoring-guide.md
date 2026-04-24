# Authoring guide

The patterns that separate a mediocre agent from a great one. Nothing here is required by the SDK — they're accumulated lessons from shipping the reference agents.

## 1. Write tool descriptions like you're briefing a smart colleague

Claude uses your `summary` and `description` to decide whether to call your tool. Every other selection mistake downstream starts with a description that didn't tell Claude what the tool actually does or when to use it.

A bad description:

> "Search for flights."

A better one:

> "Search for available flights between two cities on a specific date. Use this when the user wants to browse options before booking. Returns a list of flight offers with prices, times, and airlines. Does NOT book — use `flight_book` for that."

The key additions: when to call, what it returns, and what it's not for. Every one of those cues helps Claude route correctly.

## 2. Prefer explicit arguments over magic

Bad:

```jsonc
{ "query": "string" }
```

Good:

```jsonc
{
  "origin": { "type": "string", "description": "Origin airport IATA or city name" },
  "destination": { "type": "string", "description": "Destination airport IATA or city name" },
  "depart_date": { "type": "string", "format": "date", "description": "YYYY-MM-DD" },
  "return_date": { "type": "string", "format": "date", "description": "YYYY-MM-DD, omit for one-way" },
  "adults": { "type": "integer", "minimum": 1, "default": 1 }
}
```

The second form forces Claude to fill structured fields, which means fewer parse errors and cleaner receipts.

## 3. Intents are for discoverability, not selection

Your `intents` array appears in the user-facing marketplace listing and in the home-page agent rail. It's primarily for humans scanning "what can Lumo do?". Claude mostly selects tools based on the OpenAPI `summary` and `description`.

Good intents (short, verb-led, user-oriented):
- `book flight`, `find flight`, `check fare`

Bad intents:
- `flight_search_v2`, `amadeus_api_call`, `internal_booking_flow`

## 4. Example utterances are a cheat sheet for the orchestrator

The `example_utterances` block is embedded near your agent's tool entries in Claude's system prompt. Examples that explicitly match the phrasing users actually type give Claude a strong prior.

Good:
- "What's the cheapest flight to Austin this Friday?"
- "Book me on AA123 tomorrow"
- "Show me morning flights to JFK next week"

Write 5–10 examples spanning the variety you expect — different phrasings, different levels of specificity, different tones. The orchestrator reads all of them.

## 5. Return shapes should be easy to render

Plain, flat, named fields. Nested structures only when the domain demands it (a flight has segments; a segment has legs). Avoid:

- `results: any[]` — unclear what's in the array.
- `metadata: { [key: string]: any }` — downstream components can't render.
- `raw_response: <provider-specific>` — pushes complexity to whoever reads it.

If you can render your tool result as a card, declare a component in your manifest's `ui.components` list and return the matching shape. The Super Agent's card library handles the rest.

## 6. Errors should always be structured

Every non-2xx comes back with:

```json
{ "error": { "code": "<code>", "message": "<human-readable>", "retryable": <bool> } }
```

Claude reads this and produces sensible user-facing text ("I can't reach Amadeus right now — want me to try again in a minute?"). Unstructured errors (an HTML stacktrace, a plain-text message) cause Claude to either hallucinate a reason or refuse to retry.

The available codes are listed in [sdk-reference.md](sdk-reference.md#error-shape). Use the most specific one that applies.

## 7. Mark autonomy correctly

Every tool should have `x-lumo-autonomy` set. Getting this wrong is the single biggest UX risk.

- Mark it `read_only` only if it literally cannot change state anywhere.
- Mark it `safe_write` if it's reversible and costs nothing (saving a draft, holding a booking that expires).
- Mark it `spend` the moment money is involved — even small amounts count against the user's daily cap.
- Mark it `message` if it sends an email, DM, SMS, etc. on the user's behalf.
- Mark it `destructive` if it's irreversible (delete, publish, irrevocable commitment).

When in doubt, mark it stricter. Over-confirming is annoying; under-confirming is dangerous.

## 8. Respect the confirmation pattern for sensitive actions

For tools that actually spend money or send messages, use the **two-phase call pattern**:

1. First call (no confirmation token) → returns `{ requires_confirmation: true, card: {...}, confirmation_token: "..." }`.
2. Lumo renders a confirmation card with an Approve button.
3. User taps Approve.
4. Second call with `confirmation_token` in the body → tool actually executes.

The SDK's `confirmation.ts` has helper types for this shape. Letting Lumo's autonomy engine gate this for you is fine for simple cases; the two-phase pattern is better when the user needs to see details before approving (exact fare, exact recipient, exact time).

## 9. Keep tool calls idempotent when possible

If a user says "book that flight" and Lumo calls your tool, then the network hiccups and Claude retries, your agent should either:

- Book once and return the same booking id both times (true idempotency, ideally via a client-provided idempotency key).
- Detect the duplicate call and return the existing booking with a clear "already booked" signal.

The OpenAI / OAuth world has robust idempotency-key conventions; use those.

## 10. Handle the "cold cache" case gracefully

The Super Agent may call your health endpoint before any real user has touched your agent. Make sure:

- Your tool handlers work without any state bootstrap.
- Your health endpoint returns quickly even if upstream providers are slow (cache their last-known status, don't synchronously re-check on every probe).

## 11. Document your agent inside your repo, not just in the manifest

- A `README.md` at the root covering what the agent does, how to run it locally, how to test it.
- A `DEPLOYMENT.md` covering env vars and hosting specifics.
- A CHANGELOG describing behavior changes so downstream Lumo deployments know what's moved.

The Super Agent docs can only say so much about third-party agents. Your own docs carry the rest.

## 12. When a provider returns something weird, don't pass it through

If your upstream (say, an airline API) returns a response you can't parse, return a structured `AgentError` with `code: "provider_error"` and a useful `message`, not the raw garbage. Claude + the user can both do something reasonable with the former and nothing with the latter.

## 13. Localize numbers

Don't hardcode `$` or `USD`. Use the user's locale if exposed (ambient context passes the user's preferences into your tool via request headers; see `x-lumo-user-profile` in the quickstart). If you only support one locale today, say so in your manifest's `listing.about_paragraphs`.

## 14. Don't assume conversation continuity

Each call to your tool is semi-stateless from your agent's perspective. If the user books a flight on day 1 and wants to cancel on day 7, your tool should be able to look up the booking from the booking ID alone. Don't require conversation-local context that Lumo doesn't persist.

## 15. Tell Lumo what you don't do

If your agent is "Flight search" and the user asks about hotels, Claude should not route to you. Help it by being explicit:

- Don't pad your `intents` with adjacent domains.
- Your `description` should say what you don't do when there's a real risk of mis-routing.

## 16. Logs are a product interface

Your agent's server logs are what operators reach for when something breaks. Log:

- Every tool call with operation_id, user-id (if available), duration, outcome.
- Errors with enough context to debug without a repro.
- Upstream errors verbatim (so they can grep).

Don't log:

- Tool arguments containing user content (fair use of "user asked us to search for flights" is fine; logging actual email bodies is not).
- OAuth tokens, ever.

## The meta-lesson

The agent patterns above are less about API correctness and more about building something that cooperates well with an LLM orchestrator. The orchestrator is a smart collaborator who can't read your source code. Everything it knows about your agent comes from the manifest and the OpenAPI. Invest in making those tell a clear story.
