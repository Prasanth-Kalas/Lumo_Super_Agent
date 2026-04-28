# ADR-014 — Agent Permissions and Capabilities Model

**Status:** Proposed (drafted 2026-04-27, Phase 4). Codex PERM-1 implements against this ADR.
**Authors:** Coworker M (architecture pass), to be reviewed by Kalas (CEO/CTO/CFO).
**Related:** `docs/specs/adr-013-agent-runtime-contract.md` (the runtime that consumes this),
`docs/specs/adr-015-marketplace-distribution-trust-tiers.md`,
`docs/specs/adr-016-agent-cost-metering-budgets.md`,
`docs/specs/adr-012-voice-cloning-biometric-consent.md` (consent-pattern precedent),
`docs/specs/phase-4-outlook.md`, `db/migrations/023_durable_missions.sql`,
`lib/service-jwt.ts`.
**Implements:** the scope taxonomy, the consent UI requirements, the
revocation semantics, the audit substrate, and the eight mandatory
invariants that gate every Phase-4 agent invocation.

---

## 1. Context

ADR-013 defines what an agent IS and the runtime contract it satisfies.
ADR-014 defines what an agent is **allowed** to do — at what
granularity, with what user consent, with what audit, with what
revocation guarantee.

This ADR is security-critical. The platform's life depends on getting
it right. A leaked or over-broad scope grant is a real harm to a real
user; an agent that escapes its declared capabilities is a marketplace
trust collapse; an audit row that is missing or mutable is a
regulatory exposure. Every decision below is conservative on principle
because the cost of getting it right is engineering time, and the cost
of getting it wrong is users.

The substrate borrows directly from ADR-012's `consent_audit_log`
pattern (append-only, service-role writes, evidence payloads). The
goals are the same: prove consent, prove revocation, prove every
side-effecting action.

---

## 2. Mandatory invariants

These invariants are non-negotiable. PERM-1 cannot ship without all
eight. Each maps to a CI gate or a runtime guard.

### 2.1 No default-on

No agent runs without an explicit `agent_installs` row plus a
non-empty `agent_scope_grants` row, both written within the user's
session and bearing a `consent_text_hash`. There is no admin flag, no
feature toggle, no marketing opt-in that can flip an agent on without
the user's deliberate action.

### 2.2 No scope inheritance across versions without re-consent

When an installed agent's `requires.scopes` changes between versions
(any minor or major bump that adds a scope), the platform forces a
re-consent flow before the new version can run. Removed scopes are
auto-revoked. Same-set scope changes (renames, schema-only) are
handled by the SDK's compatibility shim, not by silent re-grant.

### 2.3 No scope inheritance across agents

A scope granted to Agent A is **scoped to Agent A only**. Agent B
asking for the same scope must obtain its own grant, even if A and B
share an author. The audit row `scope_used` carries the agent_id; a
service-JWT for Agent B carrying a scope held by Agent A is rejected.

### 2.4 Audit log is append-only

`agent_action_audit` is append-only. No updates, no deletes except via
the user-deletion cascade. Enforced by RLS plus a `BEFORE
UPDATE/DELETE` trigger that raises an exception. Service-role only
writes; users cannot mutate their own audit rows.

### 2.5 Revocation is instant

When the user clicks Revoke on an agent or a scope, the change is
visible to the next invocation attempt within **5 seconds** (cache TTL
on the `agent_scope_grants` lookup). In-flight invocations may
complete the current step but receive `SCOPE_NOT_GRANTED` on any
subsequent scope check. The user sees the agent's state flip to
`revoked` in the workspace UI immediately on click.

### 2.6 Spending caps enforced by Core, not by agent

A `write.financial.transfer` scope carries a per-invocation cap and a
per-day cap (§4). The cap is enforced by the platform's connector
dispatcher **before** the side-effect is sent. An agent declaring a
cap and then exceeding it cannot reach the connector — the dispatcher
intercepts and returns `BUDGET_EXCEEDED`. The agent is never trusted
to honour its own cap.

### 2.7 Emergency kill-switch

Lumo can disable any agent globally by flipping
`marketplace_agents.killed = true`. The flag is checked at every
invocation. A killed agent's mission steps fail with
`AGENT_KILLED` and the user sees a banner explaining the kill. This
is the platform's last-resort defence against a published agent
turning out to be malicious.

### 2.8 User can export full audit history

Every user can download their full `agent_action_audit` history as
CSV via Workspace → Privacy → Audit Export. The export includes every
row with that user's id, with reversible redaction of any cross-user
fields. This is both a GDPR access-right discharge and a trust
posture: you can see exactly what every agent did with your data.

---

## 3. Scope taxonomy

Scopes are typed strings of the form `verb.domain[.subdomain][.qualifier]`.
The taxonomy below is the **complete v1 set** — agents may not request
scopes outside this set, and the manifest validator rejects unknown
scopes (ADR-013 §3.2).

### 3.1 Read scopes

| Scope | Consent UI text |
|---|---|
| `read.calendar.events` | "View your calendar events (titles, times, attendees, and locations)." |
| `read.email.headers` | "View email subject lines, senders, and timestamps — not message bodies." |
| `read.email.bodies` | "Read the full text of your emails." |
| `read.contacts` | "View your contacts (names, emails, phone numbers)." |
| `read.financial.transactions` | "View your transaction history (date, merchant, amount, category)." |
| `read.financial.balances` | "View your account balances." |
| `read.location.current` | "Use your current location once, when you ask." |
| `read.location.history` | "View your past location history (last 90 days)." |
| `read.documents` | "Read documents you've uploaded to Lumo." |
| `read.recall` | "Search your indexed personal data (text, images, audio transcripts)." |
| `read.knowledge_graph` | "Read your Lumo knowledge graph (people, places, events you've referenced)." |
| `read.profile` | "View your name, email, timezone, and language preference." |

### 3.2 Write scopes

| Scope | Consent UI text |
|---|---|
| `write.calendar.events` | "Create, update, or delete calendar events on your behalf." |
| `write.email.send` | "Send emails from your account." |
| `write.email.draft` | "Save email drafts in your account (drafts are not sent)." |
| `write.contacts` | "Add or update contacts in your address book." |
| `write.financial.transfer` | "Move money between your accounts (within the cap you set)." |
| `write.documents` | "Save documents to your Lumo workspace." |
| `write.knowledge_graph` | "Write derived facts to your Lumo knowledge graph." |
| `write.notification` | "Send notifications to your devices." |
| `write.mission` | "Create or modify multi-step missions on your behalf." |

### 3.3 Side-effect scopes (always behind a confirmation card)

These are the scopes that always go through the existing confirmation
card system (`mission_steps.confirmation_card_id`, migration 024).
Even with the scope granted, the side effect requires per-invocation
user approval:

- `write.email.send`
- `write.financial.transfer`
- `write.calendar.events` (delete only; create/update can be
  configured to skip confirmation per user preference).
- Any scope marked `side_effect: true` on the capability.

The confirmation card is owned by the platform, not the agent. The
agent returns `status: needs_confirmation` and the platform builds the
card from the agent-provided summary plus platform-provided audit
metadata (cost, scope used, reversibility).

---

## 4. Capability granularity

Scopes are coarse-grained (domain-wide). Capabilities are
fine-grained (specific behaviour). The manifest declares both:
`requires.scopes` and `capabilities[].scopes`. The user grants
**scopes**, the platform attributes **capabilities** in audit rows.

### 4.1 Read vs. Write — always distinguished

There is no scope that grants read-and-write. `read.email.bodies` does
not imply `write.email.send`. The two are independent grants on the
consent screen.

### 4.2 Domain-wide vs. record-specific

Where the connector exposes record-specific qualifiers, the scope can
be qualified at install time:

- `write.email.send.specific_to:user@example.com` — sends only to
  the named recipient. The dispatcher rejects sends to other
  recipients with `SCOPE_NOT_GRANTED`.
- `write.email.send.any` — unconstrained.

Specific-to grants are the user's choice on the consent screen. The
agent declares the qualifier in `requires.scopes`; the user can narrow
further but not broaden.

### 4.3 Spending caps

A spending capability carries two caps, both enforced by the connector
dispatcher (invariant 2.6):

```
write.financial.transfer.up_to_per_invocation:50_usd:per_day:200_usd
```

- `up_to_per_invocation:N_usd` — single-call ceiling.
- `per_day:M_usd` — rolling-24h ceiling across all invocations of this
  agent for this user.

The caps are stored normalised in `agent_scope_grants.constraints`
jsonb and are visible to the user on the consent screen as plain
English ("Up to $50 per transaction, $200 per day"). The user can
narrow the caps at install time but not exceed the agent's declared
ask.

### 4.4 Time-bounded scopes

Any scope can be granted with an `expires_at`, set on the consent
screen ("Grant for 24 hours / 7 days / 30 days / forever"). After
expiry, the scope auto-revokes; the user sees a re-consent prompt on
the agent's next attempted use. Time-bounded grants are the
recommended posture for `write.financial.transfer` and any scope on
an `experimental`-tier agent.

---

## 5. Consent UI requirements

The consent screen is platform-owned. Agent authors do not write the
UI; they provide the manifest text that drives it.

### 5.1 What the user sees on install

For every scope in `requires.scopes`, the consent screen renders:

- The scope's plain-English text (table §3.1, §3.2).
- The agent's `capabilities[]` list with `description` text — so the
  user sees what the agent will *do* with each scope.
- For spending caps: the per-invocation and per-day cap, with input
  fields to narrow.
- For specific-to scopes: an input field to fill the qualifier.
- For time-bounded grants: a default expiry suggestion based on tier
  (forever for `official` and `verified`; 30 days for `community`; 7
  days for `experimental`).
- Trust-tier badge (ADR-015) and the agent's `trust_tier_target`.
- Cost-model summary (`max_cost_usd_per_invocation`).
- Links to `homepage`, `privacy_url`, `support_url`,
  `data_retention_policy`.

Scopes are individually listed and individually toggled. There is a
"Grant all" affordance for convenience but the user can grant a
subset; the agent receives only the granted subset and is required to
surface a clear error ("I need scope X to do this") if a non-granted
scope is attempted at runtime (ADR-013 §5.5).

### 5.2 What the user sees on version update (re-consent)

If `requires.scopes` changed, the UI shows:

- A diff: "This update adds the following permissions" and "This
  update removes the following permissions."
- The user must approve added scopes; removed scopes are
  auto-revoked.
- An option to "Stay on the previous version" — the platform pins
  the user to the prior version until they re-consent or the prior
  version is yanked.

### 5.3 What the user sees on settings

Workspace → Settings → Agents shows every installed agent with:

- Per-scope toggle (revoke individual scopes).
- "Revoke and uninstall" CTA.
- 30-day audit history surface (link to full export).
- Cost-month-to-date and budget remaining (ADR-016).

---

## 6. Revocation

### 6.1 Revoke a single scope

User clicks the toggle next to a scope in Settings → Agents → [Agent].
The platform:

1. Writes `agent_lifecycle_events` row of type
   `lifecycle_scope_revoked` with `evidence: { scope, reason? }`.
2. Updates `agent_scope_grants.granted = false` for that scope.
3. Invalidates the scope-cache (TTL 5s).
4. The agent receives `SCOPE_NOT_GRANTED` on its next attempted use.
5. The agent stays installed — only that scope is gone.

### 6.2 Revoke the agent entirely

User clicks Revoke. The platform:

1. Writes `lifecycle_revoked`.
2. Sets `agent_installs.state = 'revoked'`.
3. Marks all in-flight `mission_steps` for this agent
   `status = 'failed'` with `error_text = 'agent_revoked'`.
4. Returns the user to the Agents list with a confirmation toast.
5. Cleanup of `agent_state` rows is deferred 30 days (so the user
   can re-install without losing settings) unless the user clicks
   "Revoke and delete data" — that triggers immediate cleanup.

### 6.3 Soft-fail in-flight calls

In-flight Brain SDK calls and connector calls from the revoked agent
**fail soft**: the call returns `SCOPE_NOT_GRANTED`, the agent
catches the error, and the agent is expected to return its
invocation response with `status: 'failed'` and a clear error message
that the user can see. The platform does not kill the sandbox
mid-invocation in v1 (avoids leaving partial side effects mid-flight);
it lets the current invocation complete or time out.

---

## 7. Audit substrate

### 7.1 `agent_action_audit` schema

```sql
create table public.agent_action_audit (
  id              bigint generated by default as identity primary key,
  user_id         uuid not null references public.profiles(id) on delete cascade,
  agent_id        text not null,
  agent_version   text not null,
  capability_id   text,
  scope_used      text not null,
  action          text not null,                 -- e.g., 'email.send', 'transfer.create'
  target_resource text,                          -- redacted ref or hash
  mission_id      uuid references public.missions(id) on delete cascade,
  mission_step_id uuid,
  request_id      uuid not null,                 -- idempotency tie-in
  evidence_hash   text not null,                 -- sha256 of evidence payload
  evidence        jsonb not null default '{}'::jsonb,
  created_at      timestamptz not null default now()
);

create index agent_action_audit_by_user_agent
  on public.agent_action_audit (user_id, agent_id, created_at desc);

create index agent_action_audit_by_scope
  on public.agent_action_audit (scope_used, created_at desc);

create index agent_action_audit_by_mission
  on public.agent_action_audit (mission_id) where mission_id is not null;
```

### 7.2 What gets audited

Every scope-gated action writes one row:

| Action | Trigger | Required `evidence` keys |
|---|---|---|
| `scope.exercised` | A read scope returned data | `result_count`, `redaction_applied` |
| `email.send` | An outbound email completed | `recipient_hash`, `subject_hash`, `body_hash` |
| `calendar.event_created` | A calendar event was created | `event_id`, `attendee_count` |
| `financial.transfer` | A money movement completed | `amount_usd`, `from_account_hash`, `to_account_hash` |
| `scope.denied` | A scope check failed | `attempted_scope`, `reason` |
| `confirmation.requested` | Agent returned `needs_confirmation` | `card_id` |
| `confirmation.granted` | User approved a confirmation card | `card_id` |
| `confirmation.denied` | User declined a confirmation card | `card_id` |

The audit table is append-only (invariant 2.4). Rows are written by
the connector dispatcher and the orchestrator, never by the agent
directly — agents cannot forge audit rows.

### 7.3 Retention

| Scope class | Retention |
|---|---|
| Financial scopes (`read.financial.*`, `write.financial.*`) | **7 years** (matches Lumo Rentals' financial-records policy) |
| Calendar / email / contacts | 3 years |
| Location | 1 year |
| Recall / knowledge_graph | Lifetime of user account |
| `scope.denied` | 90 days |

Retention exceeds the user's `agent_installs` lifecycle: even after
uninstall, the audit rows persist according to the retention table.
The user-deletion cascade is the only path that removes audit rows
before retention.

### 7.4 Evidence hashing

Every row carries `evidence_hash = sha256(canonical_json(evidence))`.
The hash is the tamper-evidence signal: a periodic CI job
re-canonicalises and re-hashes a sample of recent rows; any mismatch
fires a security alert. The evidence payload itself contains hashes
of sensitive fields (recipient, subject, body) — the raw values are
not in the audit table.

---

## 8. Capability negotiation

### 8.1 Manifest declaration → user grant

The agent declares `requires.scopes` in the manifest. The user grants
a subset on the consent screen (§5). The granted set is stored in
`agent_scope_grants`:

```sql
create table public.agent_scope_grants (
  user_id      uuid not null references public.profiles(id) on delete cascade,
  agent_id     text not null,
  scope        text not null,
  granted      boolean not null default true,
  constraints  jsonb not null default '{}'::jsonb,  -- caps, qualifiers
  expires_at   timestamptz,
  granted_at   timestamptz not null default now(),
  consent_text_hash text not null,
  primary key (user_id, agent_id, scope)
);
```

`consent_text_hash` is the sha256 of the exact consent text the user
saw at grant time. If the platform later changes the consent text for
this scope (rare, e.g., legal review demands rewording), agents whose
grants carry the old hash are forced through a re-consent flow.

### 8.2 Runtime check

At invocation time, the platform builds `granted_scopes[]` from
`agent_scope_grants` and passes it to the agent in the request
envelope (ADR-013 §5.1). At every Brain SDK call and connector call,
the dispatcher re-checks:

```python
def check_scope(agent_id, user_id, requested_scope):
    if not has_grant(user_id, agent_id, requested_scope):
        write_audit('scope.denied', ...)
        return DENIED
    if scope_is_expired(grant): return DENIED
    if scope_has_constraints(grant): enforce_constraints(grant, ...)
    return ALLOWED
```

The dispatcher is the canonical enforcement point. Agents are not
trusted to honour their declared scopes; the dispatcher refuses
non-granted calls regardless of what the agent thinks it has.

### 8.3 No silent degradation

If an agent attempts a non-granted scope, the dispatcher returns
`SCOPE_NOT_GRANTED` and the agent must surface a clear message to the
user: "I need scope X to do this. Open Settings → Agents to grant."
The agent does not silently fall back to a less-capable behaviour
that pretends nothing went wrong. The CI integration test for the SDK
includes a scope-denial case and asserts the agent's response surfaces
the error in `outputs.user_message`.

---

## 9. Acceptance criteria for PERM-1

PERM-1 ships when:

1. Migration adds `agent_installs`, `agent_scope_grants`,
   `agent_action_audit`, `agent_lifecycle_events` (re-used from
   ADR-013) tables with documented indexes and RLS.
2. Append-only trigger on `agent_action_audit` blocks updates and
   deletes (test: service-role UPDATE returns exception).
3. Consent UI live at Workspace → Settings → Agents → [Install
   Flow]; renders all scope text variants from §3.
4. Revocation flow live; revocation visible to the next invocation
   within 5 s (CI: integration test).
5. Audit export CSV download live at Workspace → Privacy → Audit
   Export.
6. Spending-cap enforcement test: a `write.financial.transfer`
   capability with cap $50/inv, $200/day refuses a $51 call and a
   fifth $50 call within the same 24h.
7. Scope-denial integration test: an agent attempting a non-granted
   scope receives `SCOPE_NOT_GRANTED` and the audit row is written.
8. Re-consent flow CI test: a manifest version bump that adds a
   scope forces the user through the re-consent UI.
9. Kill-switch test: setting `marketplace_agents.killed = true`
   blocks the next invocation with `AGENT_KILLED`.

---

## 10. Consequences

### 10.1 Positive

- Every scope is on a CI gate. Adding a scope is a deliberate ADR
  amendment, not a silent code change.
- The connector dispatcher becomes the single enforcement point.
  Auditing the system reduces to auditing one module.
- The audit substrate gives the platform a defensible posture for
  GDPR access-rights and CCPA disclosures.
- Time-bounded grants give the user a free safety net — install an
  experimental agent for a week, watch what it does, decide whether
  to extend.

### 10.2 Negative

- The scope taxonomy is finite. Authors will want scopes outside
  v1's set (e.g., `read.health.records`); they wait for v2. The
  alternative — a free-form scope string — is unsafe.
- Re-consent on minor bumps is friction. Acceptable: it is the
  cost of the permission contract being honest.
- The scope cache TTL of 5 s means a revoked scope can be used by
  one more invocation in the worst case. Acceptable trade-off
  against the throughput cost of zero caching.

### 10.3 Trade-offs accepted

- Connector dispatcher carries the enforcement burden, increasing
  its surface. We accept this in exchange for a single auditable
  point.
- 7-year retention on financial audit is a real storage cost. At
  10k MAU and 10 financial actions/user/month, it is ~12 M rows/year
  at ~500 bytes each = ~6 GB/year. Acceptable.

---

## 11. Alternatives considered

### Option (A) — OAuth-style scopes (Google, Microsoft model)
Pro: familiar to developers. Con: OAuth scopes are connector-level,
not action-level. We need action-level (a `write.calendar.events`
agent should not also have `write.email.send`). Rejected as the
sole model; we borrow the consent UX pattern.

### Option (B) — Capability-based security with unforgeable tokens
Pro: theoretically perfect isolation. Con: incompatible with
service-JWT semantics; introduces a token bookkeeping problem the
user can't reason about. Rejected.

### Option (C) — Coarse-grained "trust this agent" toggle
Pro: simplest UX. Con: defeats the purpose of a permissions model;
no defence against an over-permissioned agent. Rejected.

### Option (D) — Scope strings + capabilities + time-bounded
grants (CHOSEN)
Pro: each scope is a real CI gate; capabilities give per-action
attribution in audit; time-bounding is a free safety net for
experimental-tier agents. Con: most surface to maintain. Acceptable
because the surface is exactly the security promise.

---

## 12. Open questions

1. **Per-record scopes for messaging.** v1 supports
   `write.email.send.specific_to:<address>`; should we also support
   `read.email.specific_thread:<thread_id>`? **Recommended:** defer
   to v2; the user-side complexity (managing thread-id grants) is
   not worth the v1 complexity. Use `read.email.bodies` with
   user-side trust.
2. **Scope for cross-tenant action.** A team-shared agent that
   operates on a colleague's calendar. **Recommended:** out of
   scope for v1 (Phase 5+). Phase 4 is single-user.
3. **Scope freshness on minor bumps that only narrow scopes.** A
   minor bump that removes a scope doesn't need re-consent.
   **Recommended:** auto-revoke removed scopes silently with an
   audit row; no UI prompt.

---

## 13. Decision log

| Date | Decision |
|---|---|
| 2026-04-27 | ADR-014 drafted; eight mandatory invariants sealed. |
| 2026-04-27 | Scope taxonomy v1 set — 12 read, 9 write, 4 always-confirm. |
| 2026-04-27 | Connector dispatcher is the canonical enforcement point. |
| 2026-04-27 | Audit retention: 7 years for financial, 3 years for messaging/calendar/contacts, 1 year for location. |
| 2026-04-27 | Spending-cap is platform-enforced, not agent-enforced. |
| 2026-04-27 | Time-bounded grants default for `experimental` (7 d) and `community` (30 d) tiers. |
