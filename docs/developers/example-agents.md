# Example agents

The SAMPLE-AGENTS sprint ships three reference agents under `samples/`. They
are deliberately tiered: start with the low-risk read-only path, then move to
personal-data reads, then study the full confirmation-gated money flow.

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

Run the whole sample suite from the repo root:

```bash
node --experimental-strip-types tests/sample-agents-ci.test.mjs
```

## Weather Now

Path: `samples/weather-now/`

Target tier: `experimental`

What it demonstrates: the smallest useful agent. One read-only capability, one
Brain recall call, one connector call, no write scopes, no payment, no
confirmation card.

Manifest highlights:

```json
{
  "agent_id": "weather-now",
  "connect": { "model": "none" },
  "x_lumo_sample": {
    "trust_tier_target": "experimental",
    "requires": {
      "brain_tools": ["lumo_recall_unified"],
      "connectors": ["open-weather"],
      "scopes": ["read.recall", "read.location.current"]
    },
    "cost_model": {
      "max_cost_usd_per_invocation": 0.005
    }
  }
}
```

Line-by-line:

- `connect.model: "none"` means there is no account connection step.
- `read.recall` lets the sample ask Lumo memory for a recent location hint.
- `read.location.current` keeps the capability read-only but location-aware.
- The cost ceiling is tiny because the output is deterministic and does not
  need a large model call.

Capability sketch:

```ts
export async function whats_the_weather_now(inputs, ctx) {
  const recall = await ctx.brain.lumo_recall_unified({
    query: "recent user location weather preference",
  });
  const location = recall.location ?? inputs.fallback_location ?? "current location";
  const weather = await ctx.connectors["open-weather"].current({ location });
  return {
    location,
    summary: weather.summary,
    temperature_f: weather.temperature_f,
    provenance: ["lumo_recall_unified", "open-weather.current"],
  };
}
```

Copy this when your agent only reads public or low-sensitivity data.

## Daily Email Digest

Path: `samples/summarize-emails-daily/`

Target tier: `verified`

What it demonstrates: scoped personal-data reads, Brain ranking, and per-user
state. The sample reads unread Gmail, ranks messages by sender/action
importance, groups them, and caches the digest for 60 minutes with `ctx.state`.

Manifest highlights:

```json
{
  "agent_id": "email-digest-daily",
  "connect": { "model": "lumo_id", "audience": "email-digest-daily" },
  "x_lumo_sample": {
    "trust_tier_target": "verified",
    "requires": {
      "brain_tools": ["lumo_recall_unified", "lumo_personalize_rank"],
      "connectors": ["gmail"],
      "scopes": ["read.email.headers", "read.email.bodies", "read.contacts"]
    },
    "cost_model": {
      "max_cost_usd_per_invocation": 0.04
    }
  }
}
```

Line-by-line:

- `verified` is appropriate because email bodies and contacts are sensitive.
- The sample has no write scopes; it cannot send, archive, or delete email.
- `lumo_personalize_rank` demonstrates Brain-assisted ordering without asking
  the agent to store user preference state itself.
- The cost ceiling is higher than Weather Now because summarization consumes
  model tokens.

Capability sketch:

```ts
export async function summarize_unread_inbox(inputs, ctx) {
  const cached = await ctx.state.get(`digest:${ctx.user.id}`);
  if (cached && cached.expires_at > Date.now()) return cached.value;

  const unread = await ctx.connectors.gmail.listUnread({ max_results: 10 });
  const ranked = await ctx.brain.lumo_personalize_rank({
    items: unread.map((message) => ({
      id: message.id,
      sender: message.sender,
      subject: message.subject,
      preview: message.preview,
    })),
  });

  const digest = groupAndSummarize(ranked.items);
  await ctx.state.set(`digest:${ctx.user.id}`, digest, { ttl_seconds: 3600 });
  return digest;
}
```

Copy this when your agent reads user-owned provider data but does not create
side effects.

## Lumo Rentals Trip Planner

Path: `samples/lumo-rentals-trip-planner/`

Target tier: `official`

What it demonstrates: the full sensitive-action pattern. The agent finds a
rental, returns a confirmation card before any side effect, then after approval
charges Stripe, creates a reservation, and writes a calendar event.

Manifest highlights:

```json
{
  "agent_id": "lumo-rentals-trip-planner",
  "requires_payment": true,
  "ui": { "components": ["TripConfirmationCard"] },
  "x_lumo_sample": {
    "trust_tier_target": "official",
    "requires": {
      "brain_tools": [
        "lumo_recall_unified",
        "lumo_personalize_rank",
        "lumo_optimize_trip"
      ],
      "connectors": ["lumo-rentals", "stripe", "google-calendar"],
      "scopes": [
        "read.calendar.events",
        "write.calendar.events",
        "write.financial.transfer.up_to_per_invocation:500_usd:per_day:1500_usd"
      ]
    },
    "cost_model": {
      "max_cost_usd_per_invocation": 0.25
    }
  }
}
```

Line-by-line:

- `requires_payment: true` makes cost and confirmation behavior explicit.
- `TripConfirmationCard` tells Lumo which card renderer should summarize the
  booking before execution.
- The financial scope encodes both per-invocation and daily ceilings.
- `implements_cancellation: true` in the manifest capabilities tells reviewers
  the agent has a compensation path.

Two-phase capability sketch:

```ts
export async function book_rental(inputs, ctx) {
  const option = await ctx.connectors["lumo-rentals"].quote(inputs);
  return {
    status: "needs_confirmation",
    confirmation_token: ctx.confirm.createToken({
      capability: "confirm_booking",
      request_id: inputs.request_id,
    }),
    card: {
      kind: "trip_confirmation",
      title: option.vehicle_name,
      total_cents: option.total_cents,
      refund_policy: option.refund_policy,
    },
  };
}

export async function confirm_booking(inputs, ctx) {
  const idempotencyKey = inputs.request_id;
  const charge = await ctx.connectors.stripe.charge({
    amount_cents: inputs.total_cents,
    idempotency_key: idempotencyKey,
  });
  const reservation = await ctx.connectors["lumo-rentals"].reserve({
    quote_id: inputs.quote_id,
    idempotency_key: idempotencyKey,
  });
  const calendar = await ctx.connectors["google-calendar"].createEvent({
    reservation_id: reservation.id,
    idempotency_key: idempotencyKey,
  });
  return { charge, reservation, calendar, idempotency_key: idempotencyKey };
}
```

Copy this when your agent spends money, writes to a third-party account, or
needs a rollback story.

## Choosing a starting point

| You are building... | Start from |
| --- | --- |
| Read-only lookup or public data | Weather Now |
| OAuth or personal-data read workflow | Daily Email Digest |
| Money, booking, write, or confirmation flow | Lumo Rentals Trip Planner |

## Local commands

```bash
node --experimental-strip-types samples/weather-now/tests/unit.test.mts
node --experimental-strip-types samples/summarize-emails-daily/tests/unit.test.mts
node --experimental-strip-types samples/lumo-rentals-trip-planner/tests/unit.test.mts
node --experimental-strip-types tests/sample-agents-ci.test.mjs
```

When the SDK CLI is installed:

```bash
npx lumo-agent validate samples/weather-now/lumo-agent.json
npx lumo-agent dev samples/weather-now --sandbox
npx lumo-agent sign samples/weather-now/lumo-agent.json ./weather-now.tar.gz
```

## Related

- [Quickstart](quickstart.md) - build a small agent from scratch.
- [Authoring guide](authoring-guide.md) - how to make tools route well.
- [Publishing](publishing.md) - signing, automated checks, and review.
- [Testing your agent](testing-your-agent.md) - local, sandbox, and CI expectations.
