# Daily Email Digest

`summarize-emails-daily` is the verified-tier SAMPLE-AGENTS reference. It
shows a scoped Gmail read flow, Brain-assisted ranking, and local per-user
state for idempotency.

## 60-second quickstart

```bash
node --experimental-strip-types samples/summarize-emails-daily/tests/unit.test.mts
node --experimental-strip-types samples/summarize-emails-daily/tests/e2e.test.mts
```

When SDK-1's CLI is present, the equivalent author flow is:

```bash
npx lumo-agent validate samples/summarize-emails-daily/lumo-agent.json
npx lumo-agent dev samples/summarize-emails-daily --sandbox
```

## Manifest walkthrough

- `trust_tier_target: verified` — the agent handles personal email bodies, so
  it needs stronger review than an experimental read-only weather lookup.
- `requires.brain_tools` includes recall and personalize-rank. Recall is kept
  available for future context, while the current sample uses rank directly.
- `requires.connectors: ["gmail"]` — the only provider integration.
- `requires.scopes` asks for headers, bodies, and contacts. The agent never
  requests write scopes.
- `max_cost_usd_per_invocation: 0.04` — tests assert the digest stays under
  this cost ceiling.

## Capabilities

### `summarize_unread_inbox`

Reads up to ten unread messages, ranks them by sender/action importance, groups
them by sender, and stores a 60-minute idempotency cache in `ctx.state`.

### `prepare_morning_digest`

Calls the summarize capability and folds in recent agent history so an author
can see how to compose capabilities without another connector read.
