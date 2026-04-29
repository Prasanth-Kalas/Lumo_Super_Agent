# Stub Merchant 1

`stub-merchant-1` is the MERCHANT-1 reference agent. It proves the
merchant-of-record contract with a tiny, deterministic $1 reservation flow:
confirmation card first, Stripe PaymentIntent second, synthetic reservation
last.

## 60-second quickstart

```bash
node --experimental-strip-types samples/stub-merchant-1/tests/unit.test.mts
node --experimental-strip-types samples/stub-merchant-1/tests/e2e.test.mts
```

When SDK-1's CLI is present, the equivalent author flow is:

```bash
npx lumo-agent validate samples/stub-merchant-1/lumo-agent.json
npx lumo-agent dev samples/stub-merchant-1 --sandbox
```

## Manifest walkthrough

- `agent_class: merchant_of_record` — opts into ADR-017's transaction
  contract instead of the OAuth-as-user execution model.
- `merchant_provider: stripe_payments` — this sample uses Stripe Test mode
  through Lumo's merchant-of-record backend.
- `transaction_capabilities` — `book_test_reservation` is confirmation-gated
  and declares `refund_test_reservation` as its compensation action.
- `max_single_transaction_amount: 1 USD` — MERCHANT-1's smoke test must never
  charge more than $1.
- `requires_confirmation: true` — v1 merchant capabilities always require an
  explicit confirmation card.

## Capability

`book_test_reservation(inputs, ctx)`:

1. Returns a payment confirmation card when `confirmed` is not true.
2. Uses `idempotency_key` or `ctx.request_id` for retry safety.
3. Calls `ctx.connectors["stripe-payments"].createPaymentIntent`.
4. Calls `ctx.connectors["mock-merchant"].reserve`.
5. Returns reservation, PaymentIntent, transaction provenance, and local-dev
   cost actuals.

The E2E test uses deterministic connector fixtures. A staging E2E can swap
`stripe-payments` for the real MERCHANT-1 `/api/payments/confirm-transaction`
path and Stripe Test card `4242 4242 4242 4242`.
