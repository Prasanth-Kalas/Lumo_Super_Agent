# Sprint 4 DEV-DASH — Developer Dashboard

**Status:** Design draft, written during Kalas-Cowork session 2026-04-28, pending Kalas seal.
**Author:** Claude coworker (Cowork session), reviewed by Kalas.
**Implements:** Phase 4 W5 deliverable per `docs/specs/phase-4-master.md`
§5 (DEV-DASH).
**Precondition:** MARKETPLACE-1 shipped, COST-1 shipped, PERM-1 shipped.
TRUST-1 ships in parallel; DEV-DASH consumes review state from TRUST-1.

---

## Goal

Give external authors a backstage they can use. Without DEV-DASH, the
authoring experience ends at `lumo-agent submit` and the platform
looks like a black box. With DEV-DASH, an author can see analytics,
errors, ratings, manage versions, request promotion to verified, and
verify their own identity.

After DEV-DASH ships, time-from-submission-to-author-seeing-first-
analytics is < 1 hour. That's the proof point — a non-Lumo developer
can submit, see their automated checks pass, see their first invocation
in the dashboard, and decide what to ship next.

---

## What previous sprints already shipped

- **MARKETPLACE-1** — submission API, `marketplace_agents` and
  `marketplace_agent_versions` tables, version yank.
- **COST-1** — `agent_cost_log` rows that DEV-DASH aggregates for
  per-agent analytics.
- **PERM-1** — `agent_action_audit` rows that DEV-DASH summarises
  (per-scope action counts, redacted user_id).
- **TRUST-1** — review queue state surfaces here as the "submission
  status" panel.
- **Phase 3 RUNTIME-1** — per-call latency telemetry the dashboard
  reads for p95 latency display.

---

## What this sprint adds

Five workstreams.

1. **Author identity verification**
   - Email-verified track: standard Supabase Auth email confirmation.
     Sufficient for `community` tier.
   - Legal-entity-verified track: the author submits company name,
     registration number, and a verification document. Lumo team
     reviews via TRUST-1. Sufficient for `verified` tier promotion.

2. **Author-side data scope**
   - New `developer_profiles` table — keys author rows by Lumo user_id
     plus the public author info (display name, homepage, avatar).
   - View `developer_agents_view` — per-author rollup over
     `marketplace_agents` filtered to that author.

3. **Dashboard surfaces**
   - `app/developer/dashboard/page.tsx` — top-level overview with
     "Your agents" list + submission queue status + identity badge.
   - `app/developer/dashboard/agents/[id]/page.tsx` — per-agent
     analytics (install count, invocation count, error rate, p95
     latency, cost per invocation distribution, ratings).
   - `app/developer/dashboard/agents/[id]/versions/page.tsx` —
     version manager (publish new version, yank a version, see review
     state for each version).
   - `app/developer/dashboard/agents/[id]/errors/page.tsx` —
     per-invocation error log with redacted user_id, stack trace, error
     code, mission_step_id.
   - `app/developer/dashboard/agents/[id]/promote/page.tsx` —
     promote-to-verified flow: submits a promotion request to TRUST-1's
     queue.
   - `app/developer/identity/page.tsx` — identity verification flow.

4. **Analytics aggregation**
   - Hourly cron rolls per-agent metrics into a materialised view
     `developer_agent_metrics_hourly` so the dashboard reads aggregated
     numbers instead of scanning raw cost / audit / lifecycle tables.
   - Aggregations: install count, invocation count, error rate (last
     1d / 7d / 30d), p95/p99 latency, total + median + p95 cost per
     invocation, top capabilities by invocation count.

5. **Privacy guardrails**
   - All author-visible analytics aggregate metrics only. No per-user
     details ever surfaced to authors (per master spec §5 risk).
   - Error log redacts user_id with a stable per-author hash (so the
     author can correlate "this user keeps hitting the same bug"
     without ever seeing the user's real id).
   - Per-agent error log limited to last 30 days; older errors
     retained server-side for the platform's own incident response
     but not exposed to the author.

---

## Schema — migration 031

```sql
-- db/migrations/031_developer_dashboard.sql

create table public.developer_profiles (
  user_id            uuid primary key references public.profiles(id) on delete cascade,
  display_name       text not null,
  email_verified_at  timestamptz,
  legal_entity_name  text,
  legal_entity_doc_path text,                     -- supabase storage path
  legal_entity_verified_at timestamptz,
  homepage           text,
  avatar_url         text,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

create table public.developer_agent_metrics_hourly (
  agent_id            text not null,
  agent_version       text not null,
  hour                timestamptz not null,         -- truncated to hour
  install_delta       integer not null default 0,
  invocation_count    integer not null default 0,
  error_count         integer not null default 0,
  p95_latency_ms      integer,
  median_cost_usd     numeric(10,6),
  p95_cost_usd        numeric(10,6),
  total_cost_usd      numeric(10,6) not null default 0,
  primary key (agent_id, agent_version, hour)
);

create index dam_by_agent_recent
  on public.developer_agent_metrics_hourly (agent_id, hour desc);

create table public.developer_promotion_requests (
  id              bigint generated by default as identity primary key,
  agent_id        text not null,
  agent_version   text not null,
  requested_by    uuid not null references public.profiles(id) on delete cascade,
  target_tier     text not null check (target_tier in ('verified','official')),
  state           text not null default 'pending'
    check (state in ('pending','approved','rejected','needs_changes')),
  submitted_at    timestamptz not null default now(),
  decided_at      timestamptz,
  decided_by      text,
  notes           text,
  unique (agent_id, agent_version, target_tier)
);

-- RLS: authors see their own agents
alter table public.developer_profiles enable row level security;
alter table public.developer_agent_metrics_hourly enable row level security;
alter table public.developer_promotion_requests enable row level security;

create policy dp_self on public.developer_profiles
  for select using (auth.uid() = user_id);

-- Author sees metrics only for agents they authored
create policy dam_authored on public.developer_agent_metrics_hourly
  for select using (
    exists (
      select 1 from public.marketplace_agents ma
      where ma.agent_id = developer_agent_metrics_hourly.agent_id
        and ma.author_email = (select email from public.profiles where id = auth.uid())
    )
  );

create policy dpr_self on public.developer_promotion_requests
  for select using (auth.uid() = requested_by);
create policy dpr_self_insert on public.developer_promotion_requests
  for insert with check (auth.uid() = requested_by);
```

---

## Hourly aggregation cron

`app/api/cron/developer-metrics-rollup/route.ts` runs hourly:

```sql
-- Pseudocode for the rollup query
insert into developer_agent_metrics_hourly (
  agent_id, agent_version, hour,
  install_delta, invocation_count, error_count,
  p95_latency_ms, median_cost_usd, p95_cost_usd, total_cost_usd
)
select
  acl.agent_id,
  acl.agent_version,
  date_trunc('hour', acl.created_at) as hour,
  count(distinct ali.user_id) filter (where ali.event_type = 'lifecycle_installed') as install_delta,
  count(*) as invocation_count,
  count(*) filter (where acl.status <> 'completed') as error_count,
  percentile_cont(0.95) within group (order by acl.latency_ms) as p95_latency_ms,
  percentile_cont(0.50) within group (order by acl.total_usd) as median_cost_usd,
  percentile_cont(0.95) within group (order by acl.total_usd) as p95_cost_usd,
  sum(acl.total_usd) as total_cost_usd
from agent_cost_log acl
left join agent_lifecycle_events ali
  on ali.agent_id = acl.agent_id
  and ali.agent_version = acl.agent_version
  and date_trunc('hour', ali.created_at) = date_trunc('hour', acl.created_at)
where acl.created_at >= now() - interval '2 hours'
  and acl.created_at <  date_trunc('hour', now())
group by acl.agent_id, acl.agent_version, date_trunc('hour', acl.created_at)
on conflict (agent_id, agent_version, hour) do update set
  invocation_count = excluded.invocation_count,
  error_count = excluded.error_count,
  p95_latency_ms = excluded.p95_latency_ms,
  median_cost_usd = excluded.median_cost_usd,
  p95_cost_usd = excluded.p95_cost_usd,
  total_cost_usd = excluded.total_cost_usd;
```

The 2-hour overlap window plus UPSERT handles late-arriving rows.

---

## Dashboard pages — what each renders

### `/developer/dashboard`

Top section:
- Identity badge: "Email verified" or "Legal entity verified" or
  "Unverified".
- "Verify identity" CTA if not legal-entity-verified.

"Your agents" table:
- Per agent: name, latest version, trust tier, state, install count
  (last 30d), invocation count (last 30d), error rate (last 7d),
  median cost per invocation.
- Filters: state, tier.

Submission queue panel:
- Pending submissions with SLA countdown.
- Promotion requests with TRUST-1 review state.

### `/developer/dashboard/agents/[id]`

- Header: name, latest version, trust badge, state.
- Tabs: Overview | Versions | Errors | Promote.

Overview tab renders four panels:
1. **Install + invocation chart** — daily counts for last 30 days.
2. **Latency** — p95 + p99 sparkline.
3. **Cost distribution** — histogram of `total_usd` per invocation,
   plus median + p95.
4. **Top capabilities** — invocation count per capability.

### `/developer/dashboard/agents/[id]/versions`

- Table of all versions: number, published_at, state (published /
  yanked / pending review), invocation count, error rate.
- Per-row actions: "Yank" (with confirmation), "View review state".
- "Publish new version" CTA (links to docs explaining
  `lumo-agent submit`).

### `/developer/dashboard/agents/[id]/errors`

- Last 30 days of error rows from `agent_cost_log` where status <>
  'completed'.
- Per row: timestamp, error code (`SCOPE_NOT_GRANTED`, `BUDGET_EXCEEDED`,
  `SANDBOX_TIMEOUT`, etc.), redacted_user_id (stable per-author hash),
  capability_id, mission_step_id, stack trace excerpt.
- Filter: error code, time range.

### `/developer/dashboard/agents/[id]/promote`

- Current tier displayed.
- Promotion target selector (`verified`, `official` if author is
  Lumo-team).
- Eligibility checks: legal-entity-verified for `verified`; Lumo-team
  signature for `official`.
- "Submit promotion request" → inserts
  `developer_promotion_requests` row → notifies TRUST-1 reviewer.

### `/developer/identity`

- Email verification state.
- Legal entity form: company name, registration number, country of
  registration, document upload (PDF, JPEG of registration cert).
- Submission → state goes to `pending`; TRUST-1 reviewer approves
  or requests changes.

---

## Acceptance

Per `phase-4-master.md` §5:

1. Dashboard surface live for an author with at least 1 submitted
   agent. Empty state for authors with 0 agents.
2. Analytics panels render correctly with seeded data: install +
   invocation chart (30d), latency p95/p99, cost histogram, top
   capabilities.
3. Version manager can yank a version (writes
   `marketplace_agent_versions.yanked = true` with
   `yanked_reason`).
4. Error log redacts user_id with a stable per-author hash; CI test
   asserts the same user shows up under the same hash across two
   error rows but the hash differs across two authors.
5. Promote-to-verified flow submits a `developer_promotion_requests`
   row; TRUST-1 reviewer can approve from the review queue.
6. Time from submission to author seeing first analytics: < 1 hour.
   CI test seeds an invocation row, runs the rollup cron, asserts the
   metrics-hourly row appears in < 1 hour.
7. Author identity verification flow submits docs to Supabase Storage;
   TRUST-1 reviewer can approve.
8. Three commits land on `main`:
   - `feat(db): add migration 031 developer dashboard schema`.
   - `feat(developer): hourly metrics rollup + dashboard backend`.
   - `feat(developer): dashboard ui + identity verification`.

---

## Out of scope

- Author NPS survey UI (master spec mentions the metric; the survey is
  a follow-up after the ship gate).
- Public author profile pages (Phase 5).
- Author-to-author messaging (Phase 5).
- Author CSV export beyond what's covered by COST-1's per-user export
  (authors don't get user-level data; they only get aggregates).
- Stripe Connect / payouts (Phase 5).
- Bulk version yank / mass-update tooling (Phase 4.5).

---

## File map

New files (schema):
- `db/migrations/031_developer_dashboard.sql`

New files (backend):
- `app/api/cron/developer-metrics-rollup/route.ts`
- `app/api/developer/agents/route.ts`
- `app/api/developer/agents/[id]/route.ts`
- `app/api/developer/agents/[id]/versions/route.ts`
- `app/api/developer/agents/[id]/errors/route.ts`
- `app/api/developer/agents/[id]/promote/route.ts`
- `app/api/developer/identity/route.ts`
- `lib/developer/metrics-rollup.ts`
- `lib/developer/redaction.ts` — per-author user_id hash.

New files (UI):
- `app/developer/dashboard/page.tsx`
- `app/developer/dashboard/agents/[id]/page.tsx`
- `app/developer/dashboard/agents/[id]/versions/page.tsx`
- `app/developer/dashboard/agents/[id]/errors/page.tsx`
- `app/developer/dashboard/agents/[id]/promote/page.tsx`
- `app/developer/identity/page.tsx`
- `components/developer/AgentsTable.tsx`
- `components/developer/InvocationChart.tsx`
- `components/developer/LatencySparkline.tsx`
- `components/developer/CostHistogram.tsx`
- `components/developer/TopCapabilities.tsx`
- `components/developer/SubmissionQueuePanel.tsx`
- `components/developer/IdentityBadge.tsx`

Modified files:
- `vercel.json` — register `/api/cron/developer-metrics-rollup`.
- `app/layout.tsx` — add the developer-dashboard nav item if the user
  has a `developer_profiles` row.

New tests:
- `tests/developer-metrics-rollup.test.mjs`
- `tests/developer-dashboard-rls.test.mjs` (author cannot see
  another author's agents)
- `tests/developer-error-redaction.test.mjs`
- `tests/developer-promote-flow.test.mjs`
- `tests/developer-identity-verification.test.mjs`
