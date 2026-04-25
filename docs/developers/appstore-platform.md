# Lumo App Store Platform

Lumo treats the Super Agent like the operating system and specialist agents
like apps. An agent is independently deployed, declares its capabilities through
the Lumo contract, passes automated certification, then appears in the
marketplace after admin approval.

## Deployment Models

### External Agent Deployment

This is the default and safest model.

1. The developer builds from `Lumo_Agent_Starter`.
2. The developer deploys the agent to their own HTTPS origin.
3. The developer submits `https://agent.example.com/.well-known/agent.json`
   through `/publisher`.
4. Lumo certifies the manifest, OpenAPI, health endpoint, OAuth metadata,
   permission scope, and money-tool safety.
5. An admin approves the certified submission.
6. The registry loads the approved agent from `partner_agents`.

The agent stays owned and operated by the publisher. Lumo only trusts the
contract boundary.

### Managed Agent Deployment

Managed deployment is a future layer on top of the same contract. The developer
would grant Lumo access to a repo or template parameters, Lumo would deploy the
agent service, then the same certification and approval gate would run. Do not
skip certification for managed agents; hosting an agent does not make its tools
safe.

## Lifecycle

| State | Meaning |
| --- | --- |
| `certification_failed` | Automated checks found blocking or high-risk issues. Publisher fixes and resubmits. |
| `pending` | Certification passed. Waiting for admin review. |
| `approved` | Agent is live and loadable by the registry. |
| `rejected` | Human reviewer rejected the submission. |
| `revoked` | Previously approved app was pulled from the marketplace. |

User install state is tracked separately from review state. OAuth apps are
installed when the user completes the OAuth connection; connectionless apps are
installed explicitly through the marketplace. Revoking an install removes the app
from the user's chat tool list without changing the marketplace listing.

## Certification Gates

Certification runs on submit and again immediately before approval. Approval is
blocked unless the latest report is `passed`.

Checks include:

- Manifest parses with the current `@lumo/agent-sdk`.
- Manifest, OpenAPI, health, and OAuth URLs stay on the manifest origin.
- OpenAPI converts to Lumo tools and passes cancellation-protocol validation.
- `/api/health` returns a valid health report for the same `agent_id`.
- SDK major version matches the Super Agent SDK major version.
- Payment or money tools do not run as anonymous public tools.
- Money tools require structured confirmation.
- Tool PII requirements are a subset of manifest `pii_scope`.
- OAuth agents expose scopes and should expose a revocation URL.
- Tool descriptions are scanned for obvious prompt-injection language.
- Marketplace listings should include privacy and terms URLs before public launch.

## Runtime Responsibilities

The Super Agent owns:

- user identity and sessions
- app install/connect state
- encrypted per-user token storage
- permission display and enforcement
- tool routing and bearer forwarding
- confirmation gates for money/commitment tools
- Saga rollback for compound trips
- health scoring and registry filtering
- audit events and kill-switches

The agent owns:

- its backend and provider integrations
- bearer validation on every protected tool route
- tool-specific authorization scopes
- idempotency for commit tools
- cancellation or compensation tools
- its privacy policy, terms, and data retention promises

## Approval Philosophy

An approved app is not trusted forever. Every runtime request is still scoped to
the user, the user install/connection, the declared permissions, the circuit
breaker, the confirmation system, admin runtime overrides, and per-user quotas.
App review gets an agent into the marketplace; it does not bypass runtime
policy.

## Runtime Governance

Before dispatch, the router checks:

- the agent is not suspended or revoked by `agent_runtime_overrides`
- the signed-in user has installed the app or has an active OAuth connection
- per-user minute/day quotas have not been exceeded
- money-tool daily quotas have not been exceeded

Every dispatch writes a narrow `agent_tool_usage` row with agent, tool, outcome,
latency, and cost tier. Tool arguments and user PII are not stored there.
