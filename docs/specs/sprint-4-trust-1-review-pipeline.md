# Sprint 4 TRUST-1 — Trust & Review Pipeline

**Status:** Design draft, written during Kalas-Cowork session 2026-04-28, pending Kalas seal.
**Author:** Claude coworker (Cowork session), reviewed by Kalas.
**Implements:** Phase 4 W5 deliverable per `docs/specs/phase-4-master.md`
§7 (TRUST-1) and `docs/specs/adr-015-marketplace-distribution-trust-tiers.md`
§6 (review pipeline + trust tier mechanics).
**Precondition:** MARKETPLACE-1 shipped (submission API, bundle store,
review-state column on `marketplace_agents`), PERM-1 shipped (kill-switch,
audit substrate), DEV-DASH shipped (promotion request surface).

---

## Goal

Make trust mechanical. After TRUST-1 ships:
- Every submission runs through five automated checks before any human
  sees it. Pass → publish path varies by tier. Fail → submission is
  rejected with a structured reason the developer sees in the
  dashboard.
- Verified-tier and official-tier submissions land in a reviewer queue
  with SLA timers and a structured review form.
- Lumo's reviewer team sees a dashboard of pending work prioritised by
  SLA risk.
- Promotion requests from DEV-DASH route into the same queue.
- Continuous monitoring runs every 6 hours and demotes / kills agents
  whose post-publish behaviour breaches trust thresholds.
- Author keys are real: bundles uploaded by `lumo-agent submit` carry
  signatures verified at download time and at run time.

TRUST-1 closes the loop opened by MARKETPLACE-1: submission → review →
publish → continuous monitoring → demote/kill.

---

## What previous sprints already shipped

- **MARKETPLACE-1** — submission API in `state='pending_review'`,
  bundle storage, version yank, anti-typosquatting. The placeholder
  auto-publish for `experimental` tier; queues for `community` and
  `verified`.
- **PERM-1** — kill-switch (`marketplace_agents.killed`),
  `agent_action_audit` substrate that monitoring reads,
  `lifecycle_yank` event semantics.
- **COST-1** — `agent_cost_log` rows that monitoring reads to detect
  runaway-cost agents.
- **DEV-DASH** — `developer_promotion_requests` table feeds promotions
  into the review queue.
- **SDK-1** — manifest validator (10 rules) the automated checks call;
  E2B sandbox runner for the test-run check.

---

## What this sprint adds

Six workstreams.

1. **Migration 032 — review queue + monitoring schema**
   `agent_review_queue`, `agent_review_decisions`, `agent_health_signals`
   (continuous-monitoring rollup), and the author-key tables
   `developer_keys` and `developer_key_revocations`.

2. **Five automated checks**
   The submission pipeline runs these in order. Any failure terminates
   the pipeline and writes a `state='rejected'` row with reasons.
   - **Check 1: Manifest validator** — re-run SDK-1 validator.
   - **Check 2: Dependency CVE scan** — `osv.dev` lookup of every
     declared dependency. Critical/high CVEs reject; medium gets a
     warning the reviewer sees.
   - **Check 3: Malware / static analysis** — pattern scan for
     known-bad calls (filesystem writes outside `ctx.state`, network
     calls outside `requires.connectors`, eval, dynamic require, etc.).
   - **Check 4: Sandbox test run** — invoke each capability against
     synthetic inputs in `--sandbox` mode. Refuse if any capability
     panics, exceeds `cost_model.max_cost_usd_per_invocation`, or
     escapes the sandbox FS.
   - **Check 5: Behavioural fingerprint** — record what scopes the
     capability touched in the test run. Compare to `requires.scopes`.
     If the run touched a non-declared scope, reject.

3. **Reviewer dashboard + queue**
   - `app/admin/trust/queue/page.tsx` — list of pending submissions
     and promotion requests sorted by SLA risk.
   - `app/admin/trust/review/[id]/page.tsx` — per-submission review
     form with: manifest diff, automated-check report, sandbox run
     output, capability descriptions, scope rationale, author identity
     state, prior version history.
   - `app/admin/trust/decisions/page.tsx` — historical decisions log.
   - Reviewer can approve, reject with template reasons, or request
     changes. Approve flips state to `published`. Reject closes with
     reasons surfaced in DEV-DASH.

4. **Continuous monitoring**
   - Cron `app/api/cron/agent-health-monitor/route.ts` runs every 6
     hours. Computes per-agent health signals from `agent_cost_log`,
     `agent_action_audit`, `agent_lifecycle_events`:
     - Error rate (last 24h, 7d).
     - Scope-denied rate (the agent kept attempting non-granted
       scopes — strong signal of broken or malicious manifest).
     - Cost outlier rate (invocations exceeding manifest ceiling, even
       if rejected by the budget enforcer).
     - Install-velocity to invocation-velocity ratio (low installs +
       high invocations from few users could be bot-driven gaming of
       the install counter — flag).
   - Thresholds (per ADR-015 §6.5): if error rate > 25% over 7 days OR
     scope-denied rate > 5% over 7 days OR three security-flag
     incidents over 30 days → auto-demote one tier (verified →
     community → experimental). Email author + reviewer team. If a
     P0/P1 incident happens or remediation isn't filed within the
     SLA, reviewer team can `kill` the agent (uses PERM-1's kill
     endpoint).

5. **Author keys + bundle signatures**
   - `developer_keys` table stores public ECDSA keys per author. The
     CLI generates a keypair on first `lumo-agent submit`, prompts the
     user to register the public key via the dashboard, and signs every
     subsequent bundle with the private key.
   - Submission API verifies signature against the registered key.
     Bundle download endpoint re-verifies.
   - Runtime download (the orchestrator pulling a bundle to install in
     a user's workspace) verifies a third time.
   - Compromised key flow: developer revokes via dashboard → all
     versions signed by that key are auto-yanked → email all installed
     users → reviewer team triages.

6. **Promotion request handling**
   - Promotion requests from DEV-DASH (table
     `developer_promotion_requests`) appear in the reviewer queue.
   - Reviewer evaluates: does the agent meet ADR-015 §3 criteria for
     the target tier? (E.g., for `verified`: legal-entity-verified
     author + ≥ 100 unique installs + < 5% error rate over last 30
     days + no security incidents.)
   - Approve flips `marketplace_agents.trust_tier` and writes
     a `lifecycle_promoted` event. Re-consent flow fires for installed
     users (PERM-1 surface) because tier change can change defaults.

---

## Schema — migration 032

```sql
-- db/migrations/032_trust_review_pipeline.sql

create table public.agent_review_queue (
  id              bigint generated by default as identity primary key,
  agent_id        text not null,
  agent_version   text not null,
  request_type    text not null check (request_type in ('submission','promotion','identity_verification','demotion_review')),
  target_tier     text check (target_tier in ('official','verified','community','experimental')),
  state           text not null default 'pending'
    check (state in ('pending','in_review','approved','rejected','needs_changes','withdrawn')),
  sla_due_at      timestamptz not null,
  submitted_at    timestamptz not null default now(),
  assigned_to     text,            -- reviewer email or 'auto'
  automated_checks jsonb not null default '{}'::jsonb,
  decided_at      timestamptz,
  decided_by      text,
  unique (agent_id, agent_version, request_type)
);

create index arq_pending_by_sla
  on public.agent_review_queue (sla_due_at asc)
  where state in ('pending','in_review');

create table public.agent_review_decisions (
  id            bigint generated by default as identity primary key,
  queue_id      bigint not null references public.agent_review_queue(id) on delete cascade,
  reviewer      text not null,
  outcome       text not null check (outcome in ('approve','reject','needs_changes')),
  reasons       text[] not null default '{}',     -- structured template ids
  notes         text,
  decided_at    timestamptz not null default now()
);

create table public.agent_health_signals (
  agent_id          text not null,
  agent_version     text not null,
  window_start      timestamptz not null,
  window_end        timestamptz not null,
  invocation_count  integer not null default 0,
  error_count       integer not null default 0,
  scope_denied_count integer not null default 0,
  cost_outlier_count integer not null default 0,
  unique_users      integer not null default 0,
  total_cost_usd    numeric(10,6) not null default 0,
  computed_at       timestamptz not null default now(),
  primary key (agent_id, agent_version, window_end)
);

create table public.developer_keys (
  user_id         uuid not null references public.profiles(id) on delete cascade,
  key_id          text not null,                  -- short fingerprint
  public_key_pem  text not null,
  algorithm       text not null default 'ecdsa-p256',
  registered_at   timestamptz not null default now(),
  state           text not null default 'active' check (state in ('active','revoked')),
  primary key (user_id, key_id)
);

create table public.developer_key_revocations (
  user_id        uuid not null references public.profiles(id) on delete cascade,
  key_id         text not null,
  revoked_at     timestamptz not null default now(),
  reason         text not null,
  versions_yanked integer not null default 0,
  primary key (user_id, key_id)
);

-- RLS: queue + decisions are admin-only (no policies = service-role only).
-- developer_keys: developer reads own.
alter table public.agent_review_queue enable row level security;
alter table public.agent_review_decisions enable row level security;
alter table public.agent_health_signals enable row level security;
alter table public.developer_keys enable row level security;
alter table public.developer_key_revocations enable row level security;

create policy dk_self on public.developer_keys
  for select using (auth.uid() = user_id);
create policy dkr_self on public.developer_key_revocations
  for select using (auth.uid() = user_id);
```

---

## Automated check pipeline

`lib/trust/check-pipeline.ts`:

```ts
export async function runChecks({ agent_id, agent_version, bundle_path, manifest, author_key_id }):
    Promise<CheckReport>
{
  const report: CheckReport = { passed: true, checks: [] };

  // 1. Manifest validator (re-run server side)
  const manifestResult = await sdkValidator.validate(manifest);
  report.checks.push({ id: "manifest", outcome: manifestResult.errors.length ? "fail" : "pass", ...manifestResult });
  if (!manifestResult.errors.length === false) { report.passed = false; return report; }

  // 2. CVE scan
  const cveResult = await osvScan(manifest.dependencies ?? []);
  report.checks.push({ id: "cve", outcome: cveResult.criticalOrHigh ? "fail" : (cveResult.medium ? "warn" : "pass"), details: cveResult });
  if (cveResult.criticalOrHigh) { report.passed = false; return report; }

  // 3. Static analysis / malware patterns
  const staticResult = await staticAnalysis(bundle_path);
  report.checks.push({ id: "static", outcome: staticResult.findings.length ? "fail" : "pass", ...staticResult });
  if (staticResult.findings.length) { report.passed = false; return report; }

  // 4. Sandbox test run
  const sandboxResult = await sandboxTestRun({ bundle_path, manifest });
  report.checks.push({ id: "sandbox", outcome: sandboxResult.passed ? "pass" : "fail", ...sandboxResult });
  if (!sandboxResult.passed) { report.passed = false; return report; }

  // 5. Behavioural fingerprint vs declared scopes
  const fingerprint = await fingerprintFromSandbox(sandboxResult);
  const fpResult = compareFingerprintToManifest(fingerprint, manifest);
  report.checks.push({ id: "fingerprint", outcome: fpResult.ok ? "pass" : "fail", ...fpResult });
  if (!fpResult.ok) { report.passed = false; return report; }

  return report;
}
```

The pipeline runs synchronously in the submission request for fast
checks (manifest, CVE scan via cached OSV mirror) and asynchronously
for slow checks (sandbox run). The submission API returns
`state='running_checks'` immediately; a background worker finalises
the state.

### Tier-specific routing

After checks pass:
- `experimental` → auto-publish.
- `community` → enqueue with same-day SLA. Reviewer can fast-approve
  on the strength of the automated check report alone.
- `verified` → enqueue with 5-business-day SLA. Reviewer must complete
  the structured review form.
- `official` → reserved for Lumo-team agents; reviewer is a Lumo
  staff engineer with security training.

---

## Continuous monitoring cron

```ts
// app/api/cron/agent-health-monitor/route.ts (every 6 hours)

for each (agent_id, agent_version) where state = 'published':
  let signals = computeSignals({ agent_id, agent_version, window: '24h' });
  let signals_7d = computeSignals({ agent_id, agent_version, window: '7d' });
  let signals_30d = computeSignals({ agent_id, agent_version, window: '30d' });

  upsert agent_health_signals;

  // Demote thresholds (per ADR-015 §6.5)
  if (signals_7d.error_rate > 0.25 or signals_7d.scope_denied_rate > 0.05 or signals_30d.security_flag_count >= 3):
    enqueue_demotion_review({ agent_id, agent_version, reason });
    email_author({ template: 'demotion_review_pending', signals });

  // P0/P1 auto-kill candidates (high-severity static or behavioural anomaly)
  if (signals.security_flag_count > 0 and signals.severity == 'P0'):
    auto_kill({ agent_id, reason: 'security incident P0', actor: 'health-monitor' });
    notify_reviewer_team({ severity: 'P0', agent_id });
```

---

## Reviewer dashboard

### `/admin/trust/queue`

- Sorted by `sla_due_at asc`.
- Filter: `request_type`, `state`, `target_tier`.
- Per row: agent, version, type, SLA-remaining countdown,
  automated-check summary (5 dots, green/red).
- Click → review page.

### `/admin/trust/review/[id]`

For submissions, renders:
- **Manifest panel** — full manifest with diff vs. prior version (if
  any).
- **Automated check report** — all 5 check outputs with details.
- **Capability breakdown** — for each capability: description, scope
  list, max cost, side-effect-confirmation flag.
- **Scope rationale** — what the manifest says about why each scope is
  needed; reviewer marks each scope "justified" / "questionable" /
  "unjustified."
- **Author identity** — email-verified or legal-entity-verified or
  unverified.
- **Prior version history** — earlier review decisions on this agent.
- **Decision form** — approve / reject / needs_changes; structured
  reasons (template list + free-text); template ids surface to the
  developer in DEV-DASH.

For promotion requests, additionally renders:
- **Eligibility check** — automated comparison of agent's last-30-day
  metrics vs. ADR-015 §3 criteria for the target tier. Auto-rejects
  ineligible promotions before reviewer time.
- **Migration impact** — count of installed users who will get the
  re-consent flow (PERM-1) on tier promotion.

For demotion reviews, additionally renders:
- **Health signal trend** — the signals that triggered the review.
- **Author's remediation plan** — the developer's response (if filed
  within SLA).

---

## Author keys + bundle signatures

### Key registration flow

1. First `lumo-agent submit`: CLI generates ECDSA-P256 keypair, stores
   private key in OS keychain (macOS Keychain / Linux Secret Service /
   Windows Credential Manager).
2. Public key auto-uploaded to `developer_keys` via
   `POST /api/developer/keys/register`. CLI prints the key fingerprint
   for the developer to verify.
3. Bundle signing: CLI signs the bundle's sha256 with the private
   key; signature attached to the submission payload.
4. Submission API: looks up `developer_keys` for this user, verifies
   signature against any active key. Reject if no matching active key.
5. Bundle download (marketplace install + runtime fetch): re-verifies
   signature against stored `developer_keys`.

### Key revocation flow

1. Developer triggers revocation in `/developer/keys` settings.
2. `developer_key_revocations` row inserted; `developer_keys.state`
   flipped to `revoked`.
3. All `marketplace_agent_versions` rows whose signature was generated
   by this key are auto-yanked.
4. PERM-1's yank propagation cron migrates pinned users.
5. Email author + email all install-counter users.
6. Reviewer team queue: `request_type='identity_verification'` row
   inserted to triage (was the revocation routine, or
   compromise-driven?).

---

## Acceptance

Per `phase-4-master.md` §7 and ADR-015 §6:

1. Automated pipeline runs all 5 checks; CI integration test seeds
   submissions for each failure mode and asserts the right reject
   reason fires.
2. Verified-tier submission lands in queue, reviewer can decision via
   dashboard, decision propagates to `marketplace_agents.state` and
   surfaces in DEV-DASH.
3. SLA timer test: a 5-business-day-SLA `verified` submission shows
   the right `sla_due_at`; the queue ordering favours older SLA.
4. Continuous monitoring test: seeded
   25%-error-rate-over-7-days agent triggers `demotion_review_pending`
   email and an `agent_review_queue` row.
5. Auto-kill test: seeded P0 security flag → `marketplace_agents.killed
   = true` within one cron cycle (6 hours, with manual trigger override
   for testing).
6. Author key flow E2E: CLI generates keypair, registers public key,
   signs bundle, submission API verifies, runtime download verifies.
7. Key revocation E2E: developer revokes → all versions auto-yanked
   → install row migrates per PERM-1 cron.
8. Promotion request from DEV-DASH appears in queue with eligibility
   check pre-computed; ineligible promotions auto-rejected before
   reviewer time.
9. Three commits land on `main`:
   - `feat(db): add migration 032 trust review pipeline`.
   - `feat(trust): automated check pipeline + reviewer dashboard +
     continuous monitoring`.
   - `feat(trust): author keys + bundle signatures`.

---

## Out of scope

- Manual security audit beyond reviewer dashboard (e.g., dedicated
  pen-test workflow) — Phase 5.
- Reviewer NPS / quality-of-decision tracking — Phase 4.5.
- Automated rollback (re-publishing the prior version after a kill) —
  Phase 4.5.
- HSM-backed Lumo signing key for `official` agents — Phase 5; v1
  uses the same ECDSA-P256 path with a Lumo-controlled key.
- Author-to-reviewer messaging — for now, the rejection reason
  template is the channel.

---

## File map

New files (schema):
- `db/migrations/032_trust_review_pipeline.sql`

New files (backend):
- `lib/trust/check-pipeline.ts`
- `lib/trust/checks/manifest.ts` (re-uses SDK validator)
- `lib/trust/checks/cve.ts`
- `lib/trust/checks/static.ts`
- `lib/trust/checks/sandbox.ts`
- `lib/trust/checks/fingerprint.ts`
- `lib/trust/queue.ts`
- `lib/trust/health-monitor.ts`
- `lib/trust/keys.ts` (registration, signing, verification)
- `app/api/admin/trust/queue/route.ts`
- `app/api/admin/trust/review/[id]/route.ts`
- `app/api/admin/trust/decisions/route.ts`
- `app/api/cron/agent-health-monitor/route.ts`
- `app/api/developer/keys/register/route.ts`
- `app/api/developer/keys/[id]/revoke/route.ts`

New files (UI):
- `app/admin/trust/queue/page.tsx`
- `app/admin/trust/review/[id]/page.tsx`
- `app/admin/trust/decisions/page.tsx`
- `app/developer/keys/page.tsx`
- `components/trust/CheckReport.tsx`
- `components/trust/CapabilityScopeRationale.tsx`
- `components/trust/HealthSignalsTrend.tsx`
- `components/trust/EligibilityCheck.tsx`
- `components/trust/DecisionForm.tsx`

Modified files:
- `lib/marketplace/submission.ts` — call into TRUST-1's pipeline
  (replaces MARKETPLACE-1's stub auto-publish).
- `lib/marketplace/bundle-store.ts` — verify signature on download.
- `lib/orchestrator.ts` — verify signature on runtime fetch.
- `vercel.json` — register `/api/cron/agent-health-monitor`.
- `packages/lumo-agent-sdk/src/cli/submit.ts` — keypair generation +
  bundle signing (this lives in the SDK; no SDK SemVer break — it's a
  feature add).

New tests:
- `tests/trust-checks-manifest.test.mjs`
- `tests/trust-checks-cve.test.mjs`
- `tests/trust-checks-static.test.mjs`
- `tests/trust-checks-sandbox.test.mjs`
- `tests/trust-checks-fingerprint.test.mjs`
- `tests/trust-reviewer-queue.test.mjs`
- `tests/trust-health-monitor.test.mjs`
- `tests/trust-auto-kill.test.mjs`
- `tests/trust-author-keys.test.mjs`
- `tests/trust-key-revocation.test.mjs`
- `tests/trust-promotion-eligibility.test.mjs`
