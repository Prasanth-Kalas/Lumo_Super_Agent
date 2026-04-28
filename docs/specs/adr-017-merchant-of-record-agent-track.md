# ADR-017 - Merchant-of-Record Agent Track

**Status:** Proposed (drafted 2026-04-29, Phase 4.5).
**Authors:** Codex (ADR draft), to be reviewed by Kalas and Cowork-Claude.
**Related:** `docs/specs/lumo-jarvis-master-roadmap.md`,
`docs/specs/phase-4-master.md`,
`docs/specs/adr-013-agent-runtime-contract.md`,
`docs/specs/adr-014-agent-permissions-capabilities.md`,
`docs/specs/adr-015-marketplace-distribution-trust-tiers.md`,
`docs/specs/adr-016-agent-cost-metering-budgets.md`,
`lib/saga.ts`.
**Implements:** the second Phase-4.5 agent track for consumer
commerce workflows where Lumo, not the end user, holds the provider
relationship and executes transactions on the user's behalf.

---

## 1. Context

ADR-013 through ADR-016 define the Phase-4 agent marketplace around
an **OAuth-as-user** model. In that model, an agent acts through a
connector that represents the user's own account: Gmail, Calendar,
Slack, Microsoft 365, and similar services. Permission is primarily
about whether the agent may read or write the user's account data.

The long-horizon product thesis in
`docs/specs/lumo-jarvis-master-roadmap.md` is broader. Section 1
frames the Vegas-trip promise: a user asks Lumo to plan and book the
trip, and Lumo executes flight, hotel, ground transport, and
confirmation handling without asking the user to install or evaluate
each underlying consumer service. Section 3 places that in the product
architecture: the cloud orchestrator owns agent dispatch, durable
state, marketplace permissions, and merchant-of-record execution.
Section 5 names Phase 4.5 as the bridge between the current agent
runtime and true consumer service orchestration.

That requires a second agent track. A flight agent built on Duffel, a
hotel agent built on Expedia Partner Solutions, or a ground transport
agent built on Uber for Business cannot be modeled as "use the user's
existing account" in the general case. The user may not have an
account. The provider may expect Lumo to hold credentials and settle
money. Lumo may need to own receipts, refunds, disputes, and provider
webhook reconciliation.

ADR-017 defines that second track: **Merchant-of-Record agents**.
They share the same SDK base and marketplace controls as the Phase-4
agents, but add a stricter transaction contract, a provider credential
vault, a transaction ledger, and a saga-compatible rollback posture.

This ADR is a contract only. It does not implement Duffel, Booking,
Stripe Issuing, or any specific provider. Those land in follow-up
Phase-4.5 and Phase-5 sprints.

---

## 2. Decision

Lumo will support two first-class agent classes:

1. **OAuth-as-user agents** (`agent_class: "oauth_as_user"`). These
   are the current Phase-4 default. They call user-granted connectors
   and operate inside the user's external accounts.
2. **Merchant-of-Record agents** (`agent_class: "merchant_of_record"`).
   These execute provider-backed commerce workflows where Lumo holds
   the provider credential, Lumo charges or authorizes the user, and
   Lumo owns the transaction ledger.

Both classes share:

- The ADR-013 manifest envelope, SDK base class, lifecycle hooks, and
  sandbox rules.
- The ADR-014 permission and audit substrate.
- The ADR-015 marketplace distribution and trust-tier substrate.
- The ADR-016 cost logging and per-user budget enforcement substrate.
- Durable mission integration through `missions`, `mission_steps`,
  `mission_execution_events`, and confirmation cards.

They differ in four ways:

| Area | OAuth-as-user | Merchant-of-record |
|---|---|---|
| Credential owner | User | Lumo |
| Runtime credential | User-scoped connector token | Short-lived provider token minted by Lumo |
| Money movement | Usually outside Lumo, or connector-mediated | Lumo charges/authorizes/refunds through Stripe and provider APIs |
| Audit primitive | `agent_action_audit` + mission events | `agent_action_audit` + mission events + transaction ledger |

The v1 default remains OAuth-as-user. Merchant-of-record is opt-in,
requires higher trust-tier floors, and always requires per-transaction
confirmation for any action that can create a charge, reservation,
hold, cancellation fee, or irreversible provider commitment.

---

## 3. Merchant-of-record contract

Merchant agents extend the ADR-013 manifest with a `commerce` block.
The platform validator rejects `agent_class: "merchant_of_record"`
unless this block is present and well-formed.

```ts
export type AgentClass = "oauth_as_user" | "merchant_of_record";

export type MerchantProvider =
  | "duffel"
  | "booking"
  | "expedia_partner_solutions"
  | "uber_for_business"
  | "stripe_issuing"
  | "stripe_payments"
  | "mock_merchant";

export type TransactionCapabilityKind =
  | "book_flight"
  | "hold_flight"
  | "change_flight"
  | "cancel_flight"
  | "refund_flight"
  | "book_hotel"
  | "modify_hotel"
  | "cancel_hotel"
  | "book_ground_transport"
  | "cancel_ground_transport"
  | "place_food_order"
  | "cancel_food_order"
  | "create_payment_authorization"
  | "capture_payment"
  | "refund_payment";

export interface MerchantTransactionCapability {
  /** Stable id surfaced in consent, audit, and transaction_legs. */
  id: string;
  /** Provider-specific category, still normalized by Lumo. */
  kind: TransactionCapabilityKind;
  /** Input field that supplies the idempotency key. */
  idempotency_key_field: string;
  /** Maximum single transaction amount this capability can create. */
  max_single_transaction_amount: {
    amount: number;
    currency: "USD";
  };
  /** User-visible refund/change window. */
  refund_eligibility_window_hours: number;
  /**
   * Capability id that compensates this capability. Required for any
   * capability that can commit a provider-side booking or charge.
   */
  compensation_action_capability_id?: string;
  /**
   * Whether Lumo must ask for a per-invocation confirmation card.
   * v1 requires true for every merchant capability with amount > 0.
   */
  requires_confirmation: true;
}

export interface MerchantOfRecordManifestExtension {
  agent_class: "merchant_of_record";
  merchant_provider: MerchantProvider;
  transaction_capabilities: MerchantTransactionCapability[];
  settlement: {
    merchant_name: string;       // e.g. "Lumo Rentals, Inc."
    receipt_email_from: string;  // e.g. "receipts@lumo.rentals"
    support_url: string;
  };
}
```

### 3.1 Validation rules

The manifest validator adds these merchant-specific checks:

1. `agent_class` defaults to `"oauth_as_user"` if absent. A merchant
   agent must opt in explicitly.
2. Every `transaction_capabilities[].id` is unique inside the
   manifest.
3. Every forward capability that can create a booking, charge, hold,
   or cancellation fee declares `compensation_action_capability_id`.
4. The compensation capability must exist in the same manifest unless
   the forward capability is explicitly marked `manual_only`.
5. `max_single_transaction_amount.amount` must be greater than zero
   and must not exceed the trust-tier ceiling in ADR-015 and ADR-016.
6. `requires_confirmation` must be `true` for every merchant
   capability in v1.
7. `merchant_provider` must be allowlisted by the platform. Unknown
   providers are rejected server-side even if the local SDK accepts a
   newer enum.

### 3.2 Runtime request envelope

At invocation time, the platform sends the normal ADR-013 JSON-RPC
envelope plus a commerce context:

```json
{
  "jsonrpc": "2.0",
  "id": "request-uuid",
  "method": "invoke",
  "params": {
    "agent_id": "lumo-flights",
    "capability_id": "book_flight",
    "mission_id": "mission-uuid",
    "mission_step_id": "step-uuid",
    "input": {},
    "commerce": {
      "transaction_id": "txn-uuid",
      "transaction_leg_id": "leg-uuid",
      "provider_token_ref": "signed-short-lived-token",
      "idempotency_key": "mission-uuid:step-uuid:book_flight",
      "max_amount": { "amount": 420, "currency": "USD" }
    }
  }
}
```

The agent never receives raw provider master credentials. It receives
a short-lived provider token reference that can only be redeemed by
the platform-side provider proxy for the declared capability.

---

## 4. Credential model

Merchant-of-record credentials belong to Lumo, not to the user. They
are stored per provider and per environment, encrypted at rest, and
exposed to agents only through scoped runtime tokens.

### 4.1 Storage

The provider credential vault is represented by a service-role-only
table:

```sql
create table public.merchant_provider_credentials (
  id uuid primary key default gen_random_uuid(),
  provider text not null,
  environment text not null check (environment in ('test','production')),
  credential_kind text not null check (
    credential_kind in ('api_key','oauth_client','webhook_secret','stripe_account')
  ),
  encrypted_secret_ref text not null,
  scopes text[] not null default '{}',
  active boolean not null default true,
  rotated_at timestamptz,
  expires_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (provider, environment, credential_kind)
);
```

`encrypted_secret_ref` points to the secret vault entry. The table
does not store plaintext secrets. Phase 4.5 can start with the current
environment-backed secret storage but the contract assumes a provider
vault abstraction so Secret Manager migration does not change the
agent contract.

### 4.2 Runtime access

When a merchant step is ready to execute:

1. The dispatcher verifies the mission step, install, trust tier,
   scope grant, budget, and confirmation card.
2. The dispatcher creates a `transactions` row and one or more
   `transaction_legs` rows if they do not already exist for the same
   idempotency key.
3. The dispatcher mints a signed, short-lived provider token reference
   containing provider, capability id, transaction leg id, max amount,
   and expiry.
4. The agent calls the platform provider proxy with that reference.
5. The provider proxy reads the real provider credential, calls the
   provider, stores the provider response, and updates the ledger.

Agents do not log, persist, or receive Lumo's master provider
credentials. If an agent is compromised, the blast radius is the
single scoped token and its TTL.

### 4.3 Rotation policy

- Production merchant provider credentials rotate at least every 90
  days.
- Webhook secrets rotate immediately after any suspected exposure.
- Rotation writes `agent_action_audit` or a dedicated ops audit row
  with provider, credential_kind, actor, and timestamp.
- Old credentials remain accepted only for the provider's documented
  overlap window, then are disabled.

---

## 5. Transaction ledger

Merchant execution is ledger-first. Provider calls are not trusted to
be the only source of truth because webhooks can arrive late, retries
can happen, and compound transactions need deterministic replay.

### 5.1 `transactions`

```sql
create table public.transactions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  mission_id uuid references public.missions(id) on delete set null,
  agent_id text not null,
  agent_version text not null,
  provider text not null,
  idempotency_key text not null,
  status text not null check (
    status in (
      'draft',
      'awaiting_confirmation',
      'authorized',
      'executing',
      'partially_committed',
      'committed',
      'rolling_back',
      'rolled_back',
      'refund_pending',
      'refunded',
      'failed',
      'manual_review'
    )
  ),
  currency text not null default 'USD',
  authorized_amount_cents integer not null default 0,
  captured_amount_cents integer not null default 0,
  refunded_amount_cents integer not null default 0,
  confirmation_card_id text,
  receipt_url text,
  evidence jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, agent_id, idempotency_key)
);
```

### 5.2 `transaction_legs`

```sql
create table public.transaction_legs (
  id uuid primary key default gen_random_uuid(),
  transaction_id uuid not null references public.transactions(id) on delete cascade,
  mission_step_id uuid references public.mission_steps(id) on delete set null,
  step_order integer not null,
  provider text not null,
  capability_id text not null,
  compensation_capability_id text,
  idempotency_key text not null,
  status text not null check (
    status in (
      'pending',
      'awaiting_confirmation',
      'authorized',
      'in_flight',
      'committed',
      'failed',
      'rollback_pending',
      'rollback_in_flight',
      'rolled_back',
      'rollback_failed',
      'manual_review'
    )
  ),
  depends_on integer[] not null default '{}',
  amount_cents integer not null default 0,
  provider_reference text,
  provider_status text,
  refund_window_ends_at timestamptz,
  request_payload_hash text,
  response_payload_hash text,
  evidence jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (transaction_id, step_order),
  unique (provider, idempotency_key)
);
```

### 5.3 Idempotency handling

The platform constructs the idempotency key from stable mission data:

```
merchant:<mission_id>:<mission_step_id>:<capability_id>:<attempt_group>
```

The key is passed to the provider when the provider supports
idempotency. When a provider does not support idempotency, Lumo's
ledger still enforces "do not send the same leg twice" unless an
operator explicitly starts a manual retry with a new attempt group.

Duplicate requests with the same key return the existing transaction
or leg result. They do not call the provider again.

There are two idempotency keys in play. The platform-constructed key
above is the **ledger key** and is the only key used for Lumo-side
transaction and leg uniqueness. The manifest's
`idempotency_key_field` names the provider-facing input field the
platform copies into the provider request when the provider supports
idempotency. Provider call uniqueness uses that provider-facing key;
ledger uniqueness uses the platform key. The two should usually share
the same stable source values, but they do not have to be byte-for-byte
identical.

### 5.4 State machine

The transaction-level state is derived from leg state:

- All legs `pending` -> `draft` or `awaiting_confirmation`.
- Payment authorized, at least one leg pending -> `authorized`.
- Any leg `in_flight` -> `executing`.
- At least one leg committed and at least one not terminal ->
  `partially_committed`.
- All forward legs committed -> `committed`.
- Any committed leg requires compensation -> `rolling_back`.
- All compensatable legs rolled back and manual escalations resolved
  or acknowledged -> `rolled_back`.
- Provider refund is open -> `refund_pending`.
- Full refund confirmed -> `refunded`.
- Non-recoverable provider error -> `failed` or `manual_review`.

The ledger is the source of truth for receipts, refunds, and support
diagnostics. `mission_execution_events` remains the source of truth
for mission timeline rendering.

---

## 6. User consent semantics

ADR-014 continues to govern install-time permission. Merchant-of-record
adds a stricter per-transaction consent layer.

### 6.1 Install-time consent

Merchant agents require all normal ADR-014 consent rows plus
merchant-specific disclosure:

- Provider class and example providers ("Lumo Flights may book with
  Duffel-backed airline inventory").
- Maximum per-transaction amount from the manifest.
- Refund/change window disclosure.
- Whether the agent can create provider holds that may later expire or
  incur fees.
- Support and receipt handling details.

The user may narrow max amount, time window, and allowed transaction
capabilities at install time. The user may not broaden beyond the
agent manifest or trust-tier ceiling.

### 6.2 Per-transaction confirmation

Every merchant transaction that can move money, create a booking,
create a paid hold, or expose the user to a cancellation fee requires
a platform-owned confirmation card.

The confirmation card must display:

- Agent name, trust tier, and provider.
- Exact action and capability id.
- Itemized price, taxes, fees, estimated refundability, and currency.
- Per-transaction cap and the user's remaining daily/monthly budget.
- Cancellation/refund window.
- Idempotency key or human-readable confirmation reference.
- "Approve" and "Cancel" actions.

On mobile, approval of a non-zero merchant transaction requires
biometric or device-passcode confirmation before the platform marks
the mission step `ready`.

### 6.3 Audit

Every merchant flow writes:

- `agent_action_audit` row for the scope/capability use.
- `mission_execution_events` row for mission timeline.
- `transactions` row for the merchant-level state.
- `transaction_legs` row per provider leg.
- `agent_cost_log` row for platform cost and provider API cost.

The user can export the merchant audit rows with the ADR-014 audit
export. Receipts link back to the relevant transaction id and mission
id.

---

## 7. Compound transactions

Merchant workflows are often compound: flight + hotel + ground
transport + restaurant. One successful leg can increase the urgency of
another leg, and one failed leg may require compensating prior legs.

The existing pure rollback planner in `lib/saga.ts` is the v1 shape:
it reads per-leg execution snapshots, orders committed legs
reverse-topologically, classifies compensation as `perfect`,
`best-effort`, or `manual`, and returns a deterministic rollback plan.

Merchant-of-record extends that concept with ledger-backed saga state:

- `transactions` represents the user-facing commercial unit.
- `transaction_legs` represent each provider-side leg.
- Each leg declares dependencies via `depends_on`.
- Each forward capability declares a compensation capability in the
  manifest.
- The saga executor dispatches compensation in reverse-topological
  order, using the same determinism guarantee as `lib/saga.ts`.

The follow-up COMPOUND-EXEC-1 sprint hardens this into a production
engine. ADR-017 only defines the contract that sprint must implement.

### 7.1 Saga rules

1. A leg cannot execute until all dependencies are committed or
   explicitly skipped by user choice.
2. A leg cannot be auto-rolled-back before every dependent committed
   leg has been rolled back or escalated.
3. A `manual` compensation kind never auto-dispatches. It creates a
   manual escalation and user-visible status.
4. A `best-effort` compensation kind dispatches, but residual exposure
   remains visible until provider confirmation arrives.
5. Re-running the saga over the same ledger snapshot must produce the
   same next action.

---

## 8. Failure modes and rollback

### 8.1 Leg succeeds, later leg fails

Example: hotel commits, then flight booking fails. The transaction
enters `rolling_back`. The saga planner identifies committed legs,
orders them reverse-topologically, and dispatches each compensation
capability. The user sees the failed leg, each rollback attempt, and
any residual provider exposure.

### 8.2 Refund window expires before user notices

If the provider's refund window closes before rollback is attempted or
completed, the affected leg enters `manual_review`. The user sees a
support escalation and the receipt center shows residual exposure. The
platform may still attempt a best-effort provider refund, but it is no
longer represented as guaranteed.

### 8.3 Provider webhook delivery fails

Provider webhooks are idempotent and replayable. The webhook handler
deduplicates by provider event id and writes a dead-letter row after
the retry policy is exhausted. The transaction remains in a non-final
state until reconciliation succeeds or an operator resolves the
dead-letter event.

### 8.4 Provider goes down mid-transaction

If the provider request times out before a definitive response, the
ledger marks the leg `in_flight` with `provider_status = 'unknown'`.
The executor retries with the same idempotency key. If the provider
cannot confirm after the retry window, the leg moves to
`manual_review` rather than sending a second non-idempotent booking
request.

### 8.5 Payment authorization succeeds, provider booking fails

The payment leg moves to `authorized`; the provider leg moves to
`failed`. The payment authorization is cancelled or refunded through
the payment compensation capability. If the authorization cannot be
voided immediately, the transaction shows `refund_pending`.

### 8.6 Compensation fails

A failed compensation capability marks the leg `rollback_failed` and
keeps the transaction in `rolling_back` or `manual_review` depending
on whether an automated retry is still safe. A repeated retry must use
the same idempotency key unless an operator starts a new attempt group.

---

## 9. PCI-DSS posture

Lumo does not store or process raw card numbers. Stripe hosts the
payment method collection flow through Stripe Elements, SetupIntents,
and PaymentMethods. Lumo stores Stripe customer ids, payment method
ids, payment intent ids, and charge/refund ids - never PANs or CVV.

Merchant-of-record agents that take payment must route through the
platform payment proxy. Agents cannot ask users for raw card data, and
the manifest validator rejects any merchant agent that declares an
input schema containing fields such as `card_number`, `cvv`, or
`pan`.

With this design, Lumo targets PCI SAQ A for v1. Any future flow that
causes Lumo-hosted code to touch raw card data requires a separate
security review and an ADR amendment.

---

## 10. Trust tier implications

Merchant-of-record agents carry more risk than OAuth-as-user agents
because they can create charges, holds, reservations, refunds, and
provider obligations. ADR-015 trust tiers therefore get stricter
floors:

| Merchant capability | Minimum tier |
|---|---|
| Test-mode or mock merchant with no real money | `community` |
| Any transaction touching > $0 | `verified` |
| Travel, healthcare, financial, insurance, or regulated category | `official` |
| Any agent requesting an exemption from the provider-proxy boundary | `official` plus escalated security review |

Community merchant agents may exist only against mock providers or
test-mode payment rails. They cannot touch production provider
credentials or real user money.

Verified merchant agents require human review of manifest,
capabilities, provider contract, refund path, and test evidence.

Official merchant agents are Lumo-operated or partner-operated under a
direct commercial agreement and a stronger incident response SLA.

The kill-switch from ADR-014 applies to merchant agents exactly as it
does to OAuth-as-user agents, but the incident playbook additionally
checks open transactions, refund exposure, and provider webhooks before
declaring the incident closed.

---

## 11. Out of scope

ADR-017 does not implement:

- Duffel, Booking.com, Expedia, Uber for Business, or Stripe Issuing
  integrations.
- The payment-method management UI.
- The receipt center UI.
- The COMPOUND-EXEC-1 saga hardening sprint.
- Mobile biometric confirmation implementation.
- Provider webhook infrastructure details beyond the required
  idempotent and dead-letter semantics.
- Accounting, tax, chargeback operations, or legal merchant-of-record
  registration work.
- Marketplace revenue share or developer payouts.

Those items require follow-up sprint specs once the contract is
approved.

---

## 12. Open questions

1. **Provider vault implementation.** Should Phase 4.5 begin with
   environment-backed secrets plus encrypted database refs, or move
   provider credentials to Secret Manager before the first merchant
   sprint? Recommendation: Secret Manager before production merchant
   traffic, env-backed acceptable for mock/test-mode only.
2. **Stripe product surface.** Do we start with PaymentIntents +
   SetupIntents only, or include Stripe Issuing in the first merchant
   substrate? Recommendation: PaymentIntents first; Issuing only when
   a provider requires card-network-like behavior.
3. **Receipt ownership.** Should Lumo issue one consolidated receipt
   per compound transaction or one receipt per provider leg plus a
   Lumo summary? Recommendation: consolidated Lumo receipt with
   provider confirmations attached.
4. **Manual escalation SLA.** What user-facing SLA does Lumo promise
   when a merchant leg enters `manual_review`? Recommendation: define
   a visible "ops reviewing" state now and set hard SLA after support
   staffing is known.
5. **Trust-tier exception process.** Can a third-party partner become
   `official` for one regulated category while remaining `verified`
   elsewhere? Recommendation: allow per-agent official status, not
   author-wide official status.
6. **International expansion.** ADR-017 assumes USD and US/EU-first
   compliance. Non-US currency, tax, and travel regulations require a
   separate amendment.

---

## 13. Consequences

### 13.1 Positive

- The Vegas-trip vision gets a concrete execution substrate rather
  than pretending every consumer service is OAuth-as-user.
- Transaction state becomes observable, replayable, and auditable.
- Provider credentials are held by Lumo and never exposed to untrusted
  agent code.
- The existing mission and saga work remains useful; merchant legs are
  an extension of the durable mission model, not a parallel workflow
  engine.

### 13.2 Negative

- Merchant-of-record moves Lumo into a higher operational and legal
  responsibility tier.
- The trust pipeline must be stricter for merchant agents, slowing
  third-party commerce-agent launches.
- Transaction ledger and webhook reconciliation add persistent
  operational load.
- Users may blame Lumo for provider failures, refund windows, and
  manual-review delays, even when the provider caused the issue.

### 13.3 Trade-offs accepted

- We accept a two-track agent model rather than forcing every
  consumer service into OAuth-as-user.
- We accept higher review floors for merchant agents because user
  trust and financial safety matter more than marketplace velocity.
- We accept platform-owned confirmation cards and payment proxies,
  limiting agent flexibility in exchange for auditability and PCI
  boundary control.

---

## 14. Decision log

| Date | Decision |
|---|---|
| 2026-04-29 | ADR-017 drafted as the Phase-4.5 contract for merchant-of-record agents. |
| 2026-04-29 | Two-track model chosen: `oauth_as_user` plus `merchant_of_record`. |
| 2026-04-29 | Merchant agents share ADR-013 SDK base but require a commerce manifest extension. |
| 2026-04-29 | Merchant capabilities require per-transaction confirmation in v1. |
| 2026-04-29 | Trust-tier floor set to `verified` for real-money merchant agents and `official` for regulated categories. |
