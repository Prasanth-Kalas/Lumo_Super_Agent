# Example agents

The Phase 4 SAMPLE-AGENTS sprint adds three local reference agents under
`samples/`. They are the patterns external authors should copy before they
read deeper docs.

Each sample has the same shape:

```text
samples/<agent>/
├── lumo-agent.json
├── README.md
├── package.json
├── tsconfig.json
├── src/index.ts
└── tests/
    ├── unit.test.mts
    └── e2e.test.mts
```

Run all samples from the Super Agent repo:

```bash
node --experimental-strip-types tests/sample-agents-ci.test.mjs
```

## Weather Now

Path: `samples/weather-now/`

**Trust tier:** experimental

**What it demonstrates:** the smallest useful agent: one capability, one Brain
recall call, one connector call, no write scopes, no confirmation card.

`whats_the_weather_now` asks `ctx.brain.lumo_recall_unified` for a recent
location hint, calls the `open-weather` connector, and returns a compact weather
summary with provenance.

Read next:

- `samples/weather-now/lumo-agent.json`
- `samples/weather-now/src/index.ts`
- `samples/weather-now/README.md`

## Daily Email Digest

Path: `samples/summarize-emails-daily/`

**Trust tier:** verified

**What it demonstrates:** scoped personal-data reads, Brain ranking, and
per-user state. The sample reads unread Gmail, ranks messages by sender/action
importance, groups them by sender, and caches the digest for 60 minutes via
`ctx.state`.

Capabilities:

- `summarize_unread_inbox`
- `prepare_morning_digest`

Read next:

- `samples/summarize-emails-daily/lumo-agent.json`
- `samples/summarize-emails-daily/src/index.ts`
- `samples/summarize-emails-daily/README.md`

## Lumo Rentals Trip Planner

Path: `samples/lumo-rentals-trip-planner/`

**Trust tier:** official

**What it demonstrates:** the full money-moving pattern. The agent finds a
rental, returns a confirmation card before any side effect, then after approval
charges Stripe, creates the rental reservation, and writes a calendar event.

Capabilities:

- `find_rental_for_trip`
- `book_rental`
- `confirm_booking`

The `request_id` is used as the idempotency key across Stripe, Lumo Rentals,
and Google Calendar so retries do not double-book. The final response carries a
four-step provenance chain:

1. Stripe charge
2. Lumo Rentals reservation
3. Google Calendar event
4. Idempotency key hash

Read next:

- `samples/lumo-rentals-trip-planner/lumo-agent.json`
- `samples/lumo-rentals-trip-planner/src/index.ts`
- `samples/lumo-rentals-trip-planner/README.md`

## How to choose a starting point

- Building a public, read-only lookup? Start from **Weather Now**.
- Building an OAuth or personal-data workflow? Start from **Daily Email
  Digest**.
- Building anything that spends money or writes to a third-party account? Start
  from **Lumo Rentals Trip Planner** and keep the confirmation-card split.

## Related

- [quickstart.md](quickstart.md) — your own first agent.
- [authoring-guide.md](authoring-guide.md) — patterns beyond the samples.
- [sdk-reference.md](sdk-reference.md) — manifest, OpenAPI, and confirmation
  contracts.
- [testing-your-agent.md](testing-your-agent.md) — local, sandbox, and CI
  testing expectations.
