export const DUFFEL_FLIGHT_AGENT_MANIFEST = {
  agent_id: "lumo-flights",
  display_name: "Lumo Flights",
  version: "0.1.0",
  agent_class: "merchant_of_record",
  trust_tier: "official",
  capabilities: [
    "search_flights",
    "hold_flight",
    "book_flight",
    "cancel_flight",
  ],
  commerce: {
    provider: "duffel",
    confirmation_required: true,
    min_trust_tier: "verified",
  },
  transaction_capabilities: [
    {
      id: "book_flight",
      kind: "book_flight",
      requires_confirmation: true,
      idempotency_key_field: "idempotencyKey",
      compensationAction: "cancel_flight",
      compensation_action_capability_id: "cancel_flight",
      max_single_transaction_amount: { currency: "USD", amount: 5000 },
    },
  ],
} as const;
