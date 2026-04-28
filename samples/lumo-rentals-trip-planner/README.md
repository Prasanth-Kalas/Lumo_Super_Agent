# Lumo Rentals Trip Planner

`lumo-rentals-trip-planner` is the official-tier SAMPLE-AGENTS reference. It
shows the full runtime contract: Brain optimization, connector orchestration,
confirmation cards, idempotency, local state, and provenance for a
money-moving action.

## 60-second quickstart

```bash
node --experimental-strip-types samples/lumo-rentals-trip-planner/tests/unit.test.mts
node --experimental-strip-types samples/lumo-rentals-trip-planner/tests/e2e.test.mts
```

When SDK-1's CLI is present, the equivalent author flow is:

```bash
npx lumo-agent validate samples/lumo-rentals-trip-planner/lumo-agent.json
npx lumo-agent dev samples/lumo-rentals-trip-planner --sandbox
```

## Manifest walkthrough

- `trust_tier_target: official` — this is a first-party sample that may run
  in-process after review.
- `runtime: node18` — mirrors ADR-013's official-tier carve-out.
- `requires.brain_tools` includes recall, personalization, and trip
  optimization because this agent is the "everything-feature-shown" reference.
- `requires.connectors` includes Lumo Rentals, Stripe, and Google Calendar.
- `requires.scopes` includes read/write calendar plus the per-invocation spend
  cap. The booking path always returns a confirmation card before side effects.
- `max_cost_usd_per_invocation: 0.25` — unit and E2E tests assert each
  invocation stays below this ceiling.

## Capabilities

### `find_rental_for_trip`

Runs trip optimization, then asks the Lumo Rentals connector for a recommended
rental. Returns a deterministic fixture when the connector is absent.

### `book_rental`

Returns `status: needs_confirmation` with a card summarizing the vehicle,
dates, total charge, and reversibility. No payment or reservation is made in
this step.

### `confirm_booking`

Runs only after approval. It charges Stripe, creates the rental reservation,
adds a calendar event, and records provenance for all three connector calls.
The `request_id` is used as the idempotency key so retries do not double-book.

## Confirmation-card contract

This sample follows the confirmation-card guidance from
`docs/developers/sdk-reference.md`: money-moving side effects are split into a
planning call (`book_rental`) and a post-approval call (`confirm_booking`).
