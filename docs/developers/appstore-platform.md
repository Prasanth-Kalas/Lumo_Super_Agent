# Lumo App Store Platform

Lumo treats the Super Agent like an operating system and specialist agents like
apps. A published agent declares what it can do, what permissions it needs, how
much it can cost, and what trust tier it has earned. The platform then enforces
that contract on every install and every dispatch.

The current implementation is the Phase 4 substrate: PERM-1 permissions,
MARKETPLACE-1 distribution, COST-1 metering, DEV-DASH author surfaces, and
TRUST-1 review and monitoring.

## Marketplace lifecycle

Two rows matter most:

- `marketplace_agents` is the catalog row users browse.
- `marketplace_agent_versions` is the immutable-ish version row reviewers and
  bundle download paths inspect.

| State | Where | Meaning |
| --- | --- | --- |
| `pending_review` | `marketplace_agents.state` | A submitted agent exists but is not installable. |
| `published` | `marketplace_agents.state` | Users can browse, install, and invoke the agent if permission and budget checks pass. |
| `rejected` | `marketplace_agents.state` | Submission failed automated checks or human review. |
| `killed` | `marketplace_agents.state` | Security or operator action removed the agent from live use. |
| `pending_review` | `marketplace_agent_versions.review_state` | Version has been stored but has not passed checks. |
| `automated_passed` | `marketplace_agent_versions.review_state` | Five automated TRUST-1 checks passed; human review may still be required. |
| `approved` | `marketplace_agent_versions.review_state` | Version is eligible for publication. |
| `rejected` / `needs_changes` | `marketplace_agent_versions.review_state` | Developer must fix and resubmit. |

Install state is separate. `agent_installs.state='active'` means a user has
installed the agent. `agent_installs.state='revoked'` means the user uninstalled
or consent was withdrawn. Version yanks are tracked in
`marketplace_yanked_versions` and migrated by the version-sync cron.

## Permissions and consent

PERM-1 stores install consent in two places:

- `agent_installs` records the user-agent install, pinned version, install
  state, permission JSON, and `consent_text_hash`.
- `agent_scope_grants` records each active scope grant with optional expiry and
  constraints.

The install flow is intentionally hash-checked:

1. The detail page asks `GET /api/agents/:agent_id/install` for the consent
   contract.
2. Lumo renders scopes, cost caps, and the consent text.
3. The client posts the same `consent_text_hash` back on install.
4. If the manifest or consent text changed between GET and POST, the route
   rejects with `consent_text_hash_mismatch`.

Grant constraints are JSONB and currently use this shape:

```json
{
  "up_to_per_invocation_usd": 5,
  "per_day_usd": 20,
  "specific_to": "optional human-readable bound"
}
```

Users may reduce default caps during install, but they cannot raise caps above
the manifest defaults. Time-bounded grants use `expires_at`; expired grants stop
being honored without needing a revoke write.

If a future version changes declared scopes or consent text, the next session
routes through `/api/agents/:agent_id/reconsent`. Existing grants are not silently
expanded.

## Kill switches

`agent_kill_switches` is checked on dispatch. It supports four scopes:

| Switch type | Scope |
| --- | --- |
| `system` | Blocks all agent dispatches. |
| `agent` | Blocks one agent for everyone. |
| `user` | Blocks one user from all agents. |
| `user_agent` | Blocks one user's access to one agent. |

TRUST-1 can create an `agent` kill switch automatically for a P0 incident.
Operators can also set switches through the admin route. Auto-kill is
deliberately manual-to-recover: a security reviewer must clear the switch after
review.

## Cost model

COST-1 records every billable invocation in `agent_cost_log`. The row is keyed by
`request_id` so retries reconcile into the same invocation instead of
double-counting. Identity fields are immutable, while final cost and status may
be updated as a retry settles.

Each row decomposes cost into:

- `brain_calls_usd`
- `model_tokens_cost_usd`
- `connector_calls_usd`
- `cost_usd_platform`
- `cost_usd_developer_share`
- `cost_usd_total`

Users also have `user_budget_tiers`:

| Tier | Default hard caps |
| --- | --- |
| `free` | `$0.50/day`, `$5/month` |
| `pro` | Same schema, usually raised by operator override. |
| `enterprise` | Same schema plus `soft_cap=true` for alert-before-block behavior. |

Before dispatch, the runtime evaluates the minimum of the manifest ceiling, the
user's grant cap, and the user's remaining daily/monthly budget. If a Sonnet or
Opus-priced forecast would exceed the cap and a cheaper fallback model is
allowed, the runtime can fall back to Haiku-style pricing and records
`evidence.fallback_model_used`. Otherwise dispatch is blocked with a typed
budget error.

Daily digest work runs hourly and monthly digest work runs daily. The
`user_cost_digest_deliveries` idempotency table prevents duplicate emails even
when the cron fires more often than a user's local digest window.

## Trust tiers

Trust tier controls review depth and publication behavior.

| Tier | Who it is for | Review behavior |
| --- | --- | --- |
| `experimental` | Small, low-risk read-only or dev agents. | If all automated checks pass, it can auto-publish. |
| `community` | Public agents that need human review but are not high-risk. | Automated checks pass first, then queue with same-day SLA. |
| `verified` | Agents handling sensitive data, broad scopes, or higher cost. | Queue with 5-business-day SLA and identity-verification expectations. |
| `official` | Lumo-owned or high-trust partner agents. | Queue with high priority and staff-engineer review. |

TRUST-1 runs five automated checks before any tier advances:

1. Manifest validation against the SDK parser.
2. OSV dependency scan.
3. Static malware-pattern scan.
4. Sandbox execution with synthetic inputs.
5. Behavioral fingerprint compared with declared scopes.

Failures stop the pipeline early and surface structured reasons to the
developer dashboard.

## Continuous monitoring

Published, non-yanked versions are scanned by the health-monitor cron every six
hours. It reads `agent_cost_log`, `agent_action_audit`, and lifecycle data, then
upserts `agent_health_signals`.

The thresholds are:

- 7-day error rate greater than 25% -> demotion review.
- 7-day scope-denied rate greater than 5% -> demotion review.
- 30-day security flag count at least 3 -> demotion review.
- Any 24-hour P0 security flag -> auto-kill.

Reviewer-visible queue rows live in `agent_review_queue`; append-only reviewer
decisions live in `agent_review_decisions`.

## Runtime responsibilities

The Super Agent owns:

- user identity and sessions
- marketplace install state
- permission consent and re-consent
- cost forecasting, budget enforcement, and cost logging
- author signature verification before bundle use
- confirmation gates for sensitive actions
- audit events and kill switches
- health scoring and review queues

The agent owns:

- its provider integrations and data store
- tool-specific authorization checks
- idempotency for side-effecting tools
- cancellation or compensation behavior
- its privacy policy, terms, and operational support

App review gets an agent into the marketplace. It never bypasses runtime
permission, budget, signature, confirmation, or kill-switch policy.

## Related

- [Publishing](publishing.md) - how submission, signing, and review work.
- [Example agents](example-agents.md) - concrete manifests for each tier.
- [OAuth integration](oauth-integration.md) - user-account connection model.
- [Testing your agent](testing-your-agent.md) - local and sandbox validation.
