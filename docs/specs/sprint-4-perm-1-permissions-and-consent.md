# Sprint 4 PERM-1 — Permissions UI + Scope Grant + Revocation

**Status:** Design draft, written during Kalas-Cowork session 2026-04-28, pending Kalas seal.
**Author:** Claude coworker (Cowork session), reviewed by Kalas.
**Implements:** Phase 4 W2-W3 deliverable per `docs/specs/phase-4-master.md`
§3 (PERM-1), and the eight mandatory invariants in
`docs/specs/adr-014-agent-permissions-capabilities.md` §2.
**Precondition:** SDK-1 shipped, ADR-014 sealed.

---

## Goal

Make ADR-014 executable. Build the schema, the consent UI, the
scope-grant flow, the revocation flow, the audit substrate, the
spending-cap enforcement, and the kill-switch that gate every Phase 4
agent invocation.

After PERM-1 ships, no agent can run without an explicit
`agent_installs` row plus a non-empty `agent_scope_grants` row, both
written within the user's session and bearing a `consent_text_hash`.
Every scope-gated action emits an `agent_action_audit` row. Revocation
is visible to the next invocation within 5 seconds. The user can
download their full audit history. Lumo can globally kill any agent
within 60 seconds.

PERM-1 is security-critical. It is the load-bearing surface for the
platform's trust posture; without it, agents have no enforced boundary.

---

## What previous sprints already shipped

- **SDK-1** — `packages/lumo-agent-sdk@1.0.0` with the request/response
  envelope (`granted_scopes` field), the `BRAIN_TOOL_NOT_GRANTED` /
  `CONNECTOR_NOT_GRANTED` / `SCOPE_NOT_GRANTED` typed error codes, and
  the manifest validator that enforces `requires.scopes ⊇
  capabilities[].scopes`.
- **Migration 027** (in SDK-1) — added `agent_lifecycle_events` and
  `agent_state`. PERM-1 extends with three more tables in migration 028.
- **Mission state machine** — `mission_steps` already carries
  `agent_id`. PERM-1 makes the dispatcher reject `mission_steps` whose
  `agent_id` lacks the required scope grants.
- **Confirmation card pipeline** (D3) — the existing card system
  PERM-1 reuses for side-effect scopes (`write.email.send`,
  `write.financial.transfer`, `write.calendar.events.delete`).
- **`lib/service-jwt.ts`** — service-JWT signing carries
  `agent_id`; PERM-1 adds scope-set claims to the JWT.

---

## What this sprint adds

Five workstreams. Each is a logical commit.

1. **Migration 028 — permissions schema**
   `agent_installs`, `agent_scope_grants`, `agent_action_audit`. RLS
   policies, append-only triggers on audit, kill-switch column added
   to `marketplace_agents` (table created here as a stub if MARKETPLACE-1
   hasn't yet landed; MARKETPLACE-1 extends with the rest of the
   columns).

2. **Backend — scope-grant + revocation + audit + kill-switch APIs**
   - `POST /api/agents/:id/install` — writes `agent_installs` and
     initial `agent_scope_grants` rows.
   - `POST /api/agents/:id/grants` — updates per-scope toggles.
   - `DELETE /api/agents/:id` — revokes the agent (sets
     `agent_installs.state = 'revoked'`).
   - `GET /api/agents/:id/audit` — paginated audit history for the
     calling user.
   - `GET /api/agents/audit-export` — full CSV download.
   - `POST /api/admin/agents/:id/kill` — admin-only, flips
     `marketplace_agents.killed = true`.
   - All five APIs gated by Supabase Auth; `kill` additionally requires
     admin role.

3. **Connector dispatcher + Brain SDK gateway scope-check**
   Every connector call and every Brain SDK call passes through a new
   `checkScope({ user_id, agent_id, scope, constraints })` helper.
   Returns `ALLOWED` / `DENIED` with reason. On `DENIED`: writes a
   `scope.denied` audit row and returns `SCOPE_NOT_GRANTED` to the
   caller. The dispatcher is the canonical enforcement point per
   ADR-014 invariant 2.6.

4. **UI surfaces** (App Router)
   - `app/agents/[id]/install/page.tsx` — consent screen rendered
     during the install flow. Renders all scope text from ADR-014 §3,
     the agent's `capabilities[].description`, spending-cap inputs,
     time-bounded grant selector, trust-tier badge, cost summary.
   - `app/settings/agents/page.tsx` — list of installed agents with
     per-scope toggles and "Revoke and uninstall" CTA.
   - `app/settings/agents/[id]/page.tsx` — per-agent detail with
     30-day audit summary, version selector (placeholder for
     MARKETPLACE-1's version manager), cost view (placeholder for
     COST-1).
   - `app/privacy/audit-export/page.tsx` — CSV download surface.
   - Re-consent flow modal at `app/agents/[id]/reconsent/page.tsx` —
     fired when an installed agent's `requires.scopes` changed.

5. **Spending-cap enforcement + scope-cache**
   - `agent_scope_grants.constraints` jsonb stores per-invocation
     and per-day caps (parsed from `write.financial.transfer.up_to_per_invocation:N_usd:per_day:M_usd`).
   - In-memory scope cache keyed by `(user_id, agent_id)`, TTL 5
     seconds. Invalidated on grant change. Revocation invalidates
     immediately so the 5-second window applies only to in-flight
     calls — newly arrived calls see fresh state.
   - Rolling-24h spend tracker per `(user_id, agent_id, scope)`
     computed from `agent_action_audit` rows of type
     `financial.transfer` (the only audit type that carries
     `evidence.amount_usd`). Read at scope-check time.

---

## Schema — migration 028

```sql
-- db/migrations/028_agent_permissions.sql

-- Install state per (user, agent)
create table public.agent_installs (
  user_id           uuid not null references public.profiles(id) on delete cascade,
  agent_id          text not null,
  agent_version     text not null,
  state             text not null check (state in ('installed','suspended','revoked')),
  pinned_version    text,
  installed_at      timestamptz not null default now(),
  revoked_at        timestamptz,
  primary key (user_id, agent_id)
);

create index agent_installs_by_state
  on public.agent_installs (state)
  where state <> 'revoked';

-- Per-scope grant
create table public.agent_scope_grants (
  user_id           uuid not null references public.profiles(id) on delete cascade,
  agent_id          text not null,
  scope             text not null,
  granted           boolean not null default true,
  constraints       jsonb not null default '{}'::jsonb,  -- caps, qualifiers
  expires_at        timestamptz,
  granted_at        timestamptz not null default now(),
  consent_text_hash text not null,
  primary key (user_id, agent_id, scope)
);

create index agent_scope_grants_active
  on public.agent_scope_grants (user_id, agent_id)
  where granted = true and (expires_at is null or expires_at > now());

-- Audit substrate (append-only, ADR-014 §7)
create table public.agent_action_audit (
  id              bigint generated by default as identity primary key,
  user_id         uuid not null references public.profiles(id) on delete cascade,
  agent_id        text not null,
  agent_version   text not null,
  capability_id   text,
  scope_used      text not null,
  action          text not null,                 -- e.g., 'email.send', 'transfer.create', 'scope.denied'
  target_resource text,                          -- redacted ref or hash
  mission_id      uuid references public.missions(id) on delete cascade,
  mission_step_id uuid,
  request_id      uuid not null,
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

-- Append-only enforcement (ADR-014 invariant 2.4)
create or replace function public.agent_audit_block_mutation()
returns trigger language plpgsql as $$
begin
  raise exception 'AGENT_AUDIT_APPEND_ONLY'
    using hint = 'agent_action_audit is append-only; use the user-deletion cascade for removal';
end$$;

create trigger agent_audit_no_update
  before update on public.agent_action_audit
  for each row execute function public.agent_audit_block_mutation();

create trigger agent_audit_no_delete
  before delete on public.agent_action_audit
  for each row when (current_setting('app.current_role', true) <> 'cascade')
  execute function public.agent_audit_block_mutation();

-- Marketplace stub if MARKETPLACE-1 hasn't landed yet (PERM-1 ships first)
create table if not exists public.marketplace_agents (
  agent_id      text primary key,
  killed        boolean not null default false,
  manifest      jsonb,
  created_at    timestamptz not null default now()
);

-- RLS — service role only writes; users read their own rows
alter table public.agent_installs enable row level security;
alter table public.agent_scope_grants enable row level security;
alter table public.agent_action_audit enable row level security;

create policy installs_select on public.agent_installs
  for select using (auth.uid() = user_id);
create policy grants_select on public.agent_scope_grants
  for select using (auth.uid() = user_id);
create policy audit_select on public.agent_action_audit
  for select using (auth.uid() = user_id);
-- No insert/update/delete policies — those are service-role-only.
```

---

## API surface

### Install + consent

```
POST /api/agents/:agent_id/install
body: {
  agent_version: string,
  granted_scopes: Array<{
    scope: string,
    constraints?: { up_to_per_invocation_usd?, per_day_usd?, specific_to?, ... },
    expires_at?: ISO8601
  }>,
  consent_text_hash: string  // sha256 of the consent UI rendered text
}
→ 200 { install_id, granted_scopes, lifecycle_event_id }
```

The endpoint:
1. Verifies `consent_text_hash` matches the platform's current text for
   each granted scope (defends against UI-side tampering).
2. Inserts `agent_installs` and N `agent_scope_grants` in a single
   transaction.
3. Writes a `lifecycle_installed` event and a `lifecycle_configured`
   event.
4. Returns the install confirmation.

### Per-scope toggle

```
POST /api/agents/:agent_id/grants
body: { scope, granted, constraints?, expires_at? }
→ 200 { scope, granted, granted_at }
```

Updates the existing grant row. If the user is granting a previously
revoked scope, requires the consent_text_hash for that scope.

### Revoke

```
DELETE /api/agents/:agent_id?delete_data=false
→ 200 { state: 'revoked', cleanup_scheduled_for: ISO8601 }
```

Sets `agent_installs.state = 'revoked'`. Marks all in-flight
`mission_steps` for this agent `status = 'failed'` with `error_text =
'agent_revoked'`. With `delete_data=true`, also cascades cleanup to
`agent_state` immediately; otherwise cleanup is scheduled for 30 days
out.

### Audit history

```
GET /api/agents/:agent_id/audit?from&to&page&limit
→ 200 { rows: [...], next_page_token? }
```

Paginated audit rows for the calling user filtered by `agent_id`.

### Audit export

```
GET /api/agents/audit-export?from&to&format=csv
→ 200 text/csv (streamed)
```

Full CSV download. Reversible-redacts cross-user fields per ADR-014 §2.8.

### Kill-switch (admin)

```
POST /api/admin/agents/:agent_id/kill
body: { reason: string, severity: 'critical'|'high'|'medium' }
→ 200 { killed: true, propagation_eta_seconds: number }
```

Flips `marketplace_agents.killed = true`. Invalidates the kill-status
cache on every running orchestrator instance (Postgres LISTEN/NOTIFY).
Within 60 seconds (cache TTL ceiling), every active orchestrator
refuses dispatch for this agent.

---

## Connector dispatcher integration

Every connector call passes through `checkScope` first:

```ts
// lib/integrations/dispatcher.ts (modified)

export async function dispatchConnectorCall({
  user_id, agent_id, connector_id, method, args, request_id, mission_id,
}: ConnectorCallContext): Promise<ConnectorCallResult> {
  // 1. Scope check
  const scope = inferScopeFromConnectorMethod(connector_id, method, args);
  const grant = await checkScope({ user_id, agent_id, scope });
  if (grant.status !== "ALLOWED") {
    await writeAuditRow({
      user_id, agent_id, scope_used: scope, action: "scope.denied",
      mission_id, request_id,
      evidence: { attempted_scope: scope, reason: grant.reason },
    });
    throw new AgentError("SCOPE_NOT_GRANTED", grant.reason, false);
  }

  // 2. Constraint enforcement (e.g., specific_to qualifier)
  if (grant.constraints?.specific_to && !methodTargetMatches(args, grant.constraints.specific_to)) {
    throw new AgentError("SCOPE_NOT_GRANTED", "specific_to mismatch", false);
  }

  // 3. Per-invocation cap
  if (grant.constraints?.up_to_per_invocation_usd && args.amount_usd > grant.constraints.up_to_per_invocation_usd) {
    throw new AgentError("BUDGET_EXCEEDED", "exceeds per-invocation cap", false);
  }

  // 4. Per-day cap (rolling 24h)
  if (grant.constraints?.per_day_usd) {
    const spent24h = await rollingSpend({ user_id, agent_id, scope, hours: 24 });
    if (spent24h + (args.amount_usd ?? 0) > grant.constraints.per_day_usd) {
      throw new AgentError("BUDGET_EXCEEDED", "exceeds per-day cap", false);
    }
  }

  // 5. Kill-switch check
  if (await isAgentKilled(agent_id)) {
    throw new AgentError("AGENT_KILLED", "agent globally disabled", false);
  }

  // 6. Dispatch
  const result = await innerDispatch(connector_id, method, args);

  // 7. Audit success
  await writeAuditRow({
    user_id, agent_id, scope_used: scope, action: methodToAuditAction(method),
    mission_id, request_id, target_resource: hashTarget(args),
    evidence: buildEvidencePayload(method, args, result),
  });

  return result;
}
```

The Brain SDK gateway has the equivalent flow for Brain tool calls,
keyed off the manifest's `requires.brain_tools` allowlist.

---

## UI surfaces — what each page renders

### Install consent screen (`app/agents/[id]/install/page.tsx`)

Per ADR-014 §5.1. For every scope in `requires.scopes`:
- Plain-English text from the v1 taxonomy.
- The agent's `capabilities[]` showing `description` and which scopes
  each uses.
- For spending-cap scopes: per-invocation and per-day cap inputs
  (defaulted to the agent's declared values; user can narrow but not
  exceed).
- For `specific_to` scopes: an input field to fill the qualifier.
- For time-bounded grants: a default expiry suggestion based on the
  agent's `trust_tier_target`:
  - `official` / `verified`: forever (toggle to time-bound).
  - `community`: 30 days (toggle to forever or other).
  - `experimental`: 7 days (toggle to other; "forever" is disabled per
    invariant 2.5 — experimental never gets forever).
- Trust badge + cost summary + links to homepage / privacy / support.
- Per-scope "include" checkboxes (defaulted on); "Grant all" affordance.
- "Install" CTA submits the consent payload to `POST /api/agents/:id/install`.

### Settings → Agents (`app/settings/agents/page.tsx`)

List of installed agents with state and a "Manage" link.

### Settings → Agents → [Agent] (`app/settings/agents/[id]/page.tsx`)

- Agent header (name, version, trust badge, install date).
- Per-scope toggle list with revoke buttons.
- 30-day audit summary: count of actions per scope.
- Cost view (placeholder for COST-1; renders zero state until COST-1
  ships).
- Version manager (placeholder for MARKETPLACE-1).
- "Revoke and uninstall" + "Revoke and delete data" CTAs.

### Re-consent flow (`app/agents/[id]/reconsent/page.tsx`)

Per ADR-014 §5.2:
- Diff: "This update adds the following permissions" / "removes the
  following permissions."
- The user must approve added scopes; removed scopes are auto-revoked
  silently with an audit row.
- "Stay on the previous version" CTA pins to the prior version (writes
  `agent_installs.pinned_version`). The platform respects the pin
  until either the user re-consents or the version is yanked.

### Privacy → Audit Export (`app/privacy/audit-export/page.tsx`)

- Date-range picker (default last 90 days).
- Format: CSV.
- "Download" CTA streams the export.

---

## Acceptance

Per ADR-014 §9 and `phase-4-master.md` §3:

1. Migration 028 applied; the append-only trigger blocks UPDATE and
   DELETE on `agent_action_audit` (test: a service-role UPDATE returns
   `AGENT_AUDIT_APPEND_ONLY`; a service-role DELETE returns the same
   except when `app.current_role = 'cascade'`).
2. Consent UI live; renders all 12 read scopes, 9 write scopes, and
   the side-effect-confirmation indicator from ADR-014 §3.
3. Revocation visible to the next invocation within 5 seconds (CI
   integration test: revoke → wait 5.5s → invoke → assert
   `SCOPE_NOT_GRANTED`).
4. Audit export downloads CSV correctly for a 30-day window with the
   schema in §"Audit history" above.
5. Spending-cap enforcement test: a `write.financial.transfer`
   capability with cap $50/inv, $200/day refuses a $51 call and
   refuses a fifth $50 call within the same 24h window.
6. Scope-denial integration test: an agent attempting a non-granted
   scope receives `SCOPE_NOT_GRANTED` and a `scope.denied` audit row
   is written with the right `attempted_scope` and `reason`.
7. Re-consent flow CI test: a manifest version bump that adds a scope
   forces the user through the re-consent UI; the user can pin to the
   prior version; the prior version remains active until re-consent
   or yank.
8. Kill-switch test: `POST /api/admin/agents/:id/kill` flips
   `marketplace_agents.killed = true`; the next invocation attempt is
   refused with `AGENT_KILLED` within 60 seconds.
9. Cross-agent scope leak test: Agent B's service-JWT carrying scope
   X (granted only to Agent A) is rejected at the dispatcher.
10. Two commits land on `main`:
    - `feat(db): add migration 028 agent permissions schema`.
    - `feat(perm): add scope-grant + revocation + audit + kill-switch`
      (the bulk; UI + backend + dispatcher integration).

---

## Out of scope

- Per-record scopes for messaging
  (`read.email.specific_thread:<thread_id>`) — v2 per ADR-014 §12.
- Cross-tenant agent installs — Phase 5+.
- Bandit-personalised consent UI ordering — Phase 4.5+.
- Notification settings (which actions email vs. in-app) — handled
  via existing notification preferences, not extended here.

---

## File map

New files (schema):
- `db/migrations/028_agent_permissions.sql`

New files (backend):
- `app/api/agents/[id]/install/route.ts`
- `app/api/agents/[id]/grants/route.ts`
- `app/api/agents/[id]/route.ts` (DELETE handler)
- `app/api/agents/[id]/audit/route.ts`
- `app/api/agents/audit-export/route.ts`
- `app/api/admin/agents/[id]/kill/route.ts`
- `lib/scope-check.ts` — `checkScope()` helper.
- `lib/scope-cache.ts` — TTL-5s in-memory cache + invalidator.
- `lib/scope-taxonomy.ts` — typed scope strings vendored from
  ADR-014 §3 (also used by SDK manifest validator).
- `lib/audit-writer.ts` — service-role `writeAuditRow()` with
  evidence-hash derivation.
- `lib/kill-switch.ts` — `isAgentKilled()` + LISTEN/NOTIFY.

New files (UI):
- `app/agents/[id]/install/page.tsx`
- `app/agents/[id]/reconsent/page.tsx`
- `app/settings/agents/page.tsx`
- `app/settings/agents/[id]/page.tsx`
- `app/privacy/audit-export/page.tsx`
- `components/permissions/ScopeRow.tsx`
- `components/permissions/SpendingCapInput.tsx`
- `components/permissions/SpecificToInput.tsx`
- `components/permissions/TimeBoundedGrantSelector.tsx`
- `components/permissions/TrustTierBadge.tsx`

Modified files:
- `lib/integrations/dispatcher.ts` — add `checkScope` call at top of
  every dispatch.
- `lib/brain-sdk/gateway.ts` — same.
- `lib/orchestrator.ts` — pass `granted_scopes[]` into the agent
  invocation envelope.

New tests:
- `tests/permissions-schema.test.mjs`
- `tests/scope-check.test.mjs`
- `tests/scope-cache.test.mjs`
- `tests/audit-write.test.mjs`
- `tests/kill-switch.test.mjs`
- `tests/permissions-ui.test.mjs`
- `tests/reconsent-flow.test.mjs`
- `tests/spending-cap.test.mjs`
- `tests/cross-agent-scope-leak.test.mjs`
