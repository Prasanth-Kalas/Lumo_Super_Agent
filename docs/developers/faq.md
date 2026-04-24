# Developer FAQ

The questions we keep answering. Read before you bring them to the issue tracker — maybe they're here.

## "Claude never picks my tool."

Most common cause: your `description` field doesn't tell Claude when to use the tool.

- Does your `summary` include a verb? ("Search for..." not "Tool for search")
- Does your `description` cover WHEN to call it (user intent) not just WHAT it does?
- Are your `example_utterances` phrased like what a user would actually type?
- Is another agent's tool semantically closer to the user's query? (Overlapping descriptions cause Claude to pick one tool over another — if yours loses consistently, sharpen it.)

## "Claude keeps picking my tool for wrong queries."

Reverse of the above. Your description is too broad.

- Add negative guidance: "Use this for X. Do NOT use for Y — use the <other> tool for that."
- Tighten your `intents` list. Remove any that match adjacent domains.
- Remove example_utterances that don't strictly belong to your agent.

## "My tool returns but the result looks wrong in chat."

Two likely causes:

1. **Response doesn't match your OpenAPI.** The Super Agent validates responses; mismatches get silently coerced or cause Claude to get confused.
2. **Your response is right but doesn't render as a card.** If you want a card (flight offers, menu items, etc.), add the component name to `ui.components` in your manifest AND return data in the shape that component expects.

## "What's the request body format when the router calls my tool?"

```http
POST {base_url}/api/tools/{operationId}
Authorization: Bearer {provider-access-token}        (if OAuth)
Content-Type: application/json
X-Lumo-User-Id: <uuid>
X-Lumo-Session-Id: <uuid>
X-Lumo-User-Profile: <base64-encoded JSON>

{ ...args from the OpenAPI requestBody schema... }
```

Your handler reads args from body, token from Authorization header.

## "Does my tool get the user's memory / facts?"

Not automatically — that stays on the Super Agent's side and informs Claude's planning. What your tool gets:

- Structured profile fields (preferred airline, seat, budget tier) via the `X-Lumo-User-Profile` header.
- Anything Claude decided to include in your tool's arguments (Claude may include relevant facts as context: "The user prefers aisle seats").

If you need richer memory access, that's a feature gap; open an issue. The current expectation is that agents operate mostly on the args they're passed.

## "Can I call back into Lumo from my tool?"

No. Tools are HTTP endpoints called by the router; they don't have API access back into Lumo. If you need:

- **User profile data** → it's in the `X-Lumo-User-Profile` header.
- **To write a notification** → currently not exposed to third parties. Platform roadmap.
- **To trigger another tool** → not supported; design your tools to be single-purpose.

## "My tool needs a long time to respond (30+ seconds)."

The Super Agent's HTTP client has a default 30s timeout per tool call. Options:

1. **Return a placeholder result with a polling URL.** Your first response is `{ status: "processing", poll_url: "..." }`; Claude can poll.
2. **Use server-sent events from your agent.** Not currently supported by the router — but streaming tool responses are on the roadmap.
3. **Break the work into shorter tools.** If your agent takes 40s because it does three separate things, consider exposing each as its own tool and let Claude chain them.

Most tools should be under 5 seconds.

## "Can my agent use WebSockets?"

Not for the tool dispatch path. The Super Agent is HTTP/SSE-based.

For your own UI layer — if you render custom card components that connect back to your agent — you can do whatever you want. That's between your component and your agent; Lumo doesn't touch it.

## "How do I handle a provider rate limit?"

Return a structured error:

```json
{ "error": { "code": "rate_limited", "message": "Provider rate-limited us. Retry in 30s.", "retryable": true } }
```

Claude will typically apologize and offer to wait. If you know the retry window, include it in the message so Claude can be specific.

## "My agent's behavior depends on the time of day. Does Lumo send the user's timezone?"

Yes — `X-Lumo-User-Profile` includes `timezone` as an IANA identifier. Use it as the source of truth for "today" and "tonight".

## "What if I want a tool that takes no arguments?"

`requestBody: { ... }` with an empty schema is fine. A bodyless POST with `Content-Length: 0` also works.

## "Do all my tools have to be POST?"

Lumo expects POST for all tool calls. Consistent method simplifies the router. GET for "read-only" feels tempting but doesn't add enough value to be worth the complexity of supporting both.

## "Can I specify a webhook that Lumo calls when X happens?"

No outbound webhooks from Lumo to your agent in the current SDK. Proactive delivery is handled by Lumo's own notification system + standing intents. Your agent is called on-demand, not proactively.

## "How do I debug a failed tool call without access to the Super Agent's logs?"

Your agent should log its own requests + responses. If Lumo called you and something went wrong, your logs tell the story.

If you need the Super Agent's side (which is what saw the failure), either:

- Reproduce locally against your own Super Agent dev instance.
- Ask the operator of the Super Agent to look up the event for you — `lib/events.ts` records every tool call by session_id; your user + timestamp pins it down.

## "What language is the SDK in?"

TypeScript types, published as an npm package. You can import types into any JS/TS agent. Agents in other languages (Python, Go, Rust) can implement the HTTP contract directly — the SDK types are a convenience, not a requirement.

## "Is there a test harness I can run locally?"

See [testing-your-agent.md](testing-your-agent.md#mocking-the-super-agent-for-router-only-tests). The `simulateRouterCall` helper runs the router path without the full Super Agent.

## "How often does the registry re-probe my agent?"

Every 5 minutes by default. Manifest + OpenAPI + health all get fetched fresh on each probe, so changes you deploy appear in Lumo within that window.

## "Can I version my tools independently of my manifest?"

Yes — your OpenAPI can hold multiple operations with different semver-shaped paths if you want (`/api/tools/v2/flight_search`). Claude reads whatever's in the OpenAPI on a given probe. Breaking changes should be accompanied by manifest version bumps so operators know.

## "What about internationalization?"

Your tool receives the user's language in `X-Lumo-User-Profile.language` (BCP 47). Return content in that language if possible. Error messages can be in English for Claude to consume; user-facing strings (in card payloads) should be localized.

## "Where's the roadmap?"

Public roadmap isn't currently maintained. Feature gaps that come up in docs should go to issues on the Super Agent repo — they're triaged and folded into planning.

## Still stuck?

File an issue on `Lumo_Super_Agent` (for SDK/router questions) or on the relevant `Lumo_*_Agent_Web` repo (for example-agent specifics). Include:

- What you expected.
- What happened.
- The relevant manifest + OpenAPI (or a trimmed repro).
- Any error output.

We read them all.
