# Publishing your agent

Publishing means taking a local agent bundle, signing it with your author key,
submitting it to Lumo, passing automated TRUST-1 checks, and either
auto-publishing or entering human review depending on trust tier.

The managed path is the supported path for public agents. Private deployments
can still load internal registry entries, but public Lumo users install from the
marketplace.

## The managed submission flow

1. Build and test the agent locally.
2. Run `lumo-agent sign <manifest.json> <bundle.tar.gz>` or
   `lumo-agent submit <manifest.json> <bundle.tar.gz>`.
3. The SDK generates an ECDSA-P256 keypair on first use.
4. The private key stays in the OS keychain on macOS, or in
   `~/.config/lumo/agent-keys/author-p256.pem` with `0600` permissions on
   non-macOS systems.
5. The CLI signs this canonical payload:

   ```text
   lumo-agent-bundle:v1:<agent_id>:<version>:<bundle_sha256>
   ```

6. The publisher API stores the bundle, validates the manifest, checks for
   typosquatting, verifies the signature when required, and writes
   `marketplace_agents` plus `marketplace_agent_versions`.
7. TRUST-1 runs the five automated checks.
8. The result is either published, queued, rejected, or needs changes.

The signature binds the agent id, version, and bundle hash together. That
prevents a valid signature for one agent or version from being replayed onto
another bundle.

## Trust-tier routing

| Requested tier | Signature requirement | Review route |
| --- | --- | --- |
| `experimental` | Optional in v1. | Automated checks pass -> auto-publish. |
| `community` | Recommended. | Automated checks pass -> human queue, same-day SLA. |
| `verified` | Required. | Automated checks pass -> human queue, 5-business-day SLA. |
| `official` | Required. | Automated checks pass -> high-priority staff-engineer review. |

If automated checks fail, the version is rejected before a human reviewer sees
it. The developer dashboard shows the structured check report.

## The five automated checks

TRUST-1 runs these in order and stops on the first failure:

1. **Manifest validation.** Re-runs the SDK parser server-side.
2. **CVE scan.** Checks declared dependencies against OSV.
3. **Static analysis.** Looks for malware patterns such as raw secret access,
   subprocess spawning, dynamic code execution, or suspicious network behavior.
4. **Sandbox run.** Executes the bundle with synthetic inputs in the sandbox
   runner.
5. **Behavioral fingerprint.** Compares observed behavior with declared scopes.

Warnings can still queue for review. Failures reject the version and return
reason codes.

## What reviewers see

Human reviewers work from `/admin/trust/queue`. They see:

- manifest metadata and requested tier
- author identity and developer key fingerprint
- automated check report
- requested scopes and capability rationale
- bundle signature status
- prior decisions and health signals
- promotion or identity-verification context when relevant

Reviewer outcomes are append-only in `agent_review_decisions`. Queue state is
denormalized for UI speed, but the decision log is the audit source.

## Developer dashboard status

Developers track submissions in `/developer/submissions` and individual
submission details in `/developer/submissions/:id`. The dashboard reads
`marketplace_agent_versions.review_state`, `agent_security_reviews`, and
`agent_review_queue` data.

Common states:

| State | Meaning |
| --- | --- |
| `pending_review` | Stored, waiting on checks or review. |
| `automated_passed` | Checks passed; human review may still be pending. |
| `approved` | Version is publishable or already published. |
| `rejected` | Fix and resubmit. |
| `needs_changes` | Reviewer requested specific changes. |

Promotion requests from `/developer/promotion-requests` enter the same queue.
Identity evidence from `/developer/identity-verification` is reviewed there too.

## Version yanks and key revocation

An admin can yank a specific version. A yanked version is no longer selected for
new installs, and pinned users are migrated by the marketplace version-sync
cron when a safe replacement exists.

If an author key is compromised, TRUST-1 revokes the key and yanks every version
signed by that key. Key fingerprints remain unique across active and revoked
keys so incident response can trace all affected bundles.

## Before you submit

Run these locally:

```bash
npx lumo-agent validate samples/weather-now/lumo-agent.json
npx lumo-agent dev samples/weather-now --sandbox
node --experimental-strip-types tests/sample-agents-ci.test.mjs
```

For your own agent, keep the same shape:

- validate the manifest
- run the dev harness
- run at least one sandbox invocation per capability
- confirm cost stays below `cost_model.max_cost_usd_per_invocation`
- confirm any side-effecting tool returns a confirmation card before execution

## Requirements for publication

### Contract correctness

- Manifest parses as the current `@lumo/agent-sdk` type.
- OpenAPI parses as valid OpenAPI 3.1.
- Tool responses match the OpenAPI schemas.
- Health endpoint returns `{ ok: true }`.
- SDK major version is compatible with the running Lumo platform.

### Permission and money safety

- Scopes are the smallest useful set.
- User-facing scope descriptions are plain English.
- Manifest cost ceiling is present for any non-trivial capability.
- Money tools use confirmation cards and idempotency keys.
- User caps can only reduce defaults, never increase them.

### Trust posture

- Bundle is signed for verified and official tiers.
- No raw token or secret access in bundle code.
- Privacy and support URLs are present for public listings.
- Sensitive data handling matches the declared PII scope.

## Private deployments

Private deployments can still load their own registry entries or internal
agents. That is useful for a company running Lumo for its employees. The managed
marketplace rules still make good defaults, but the operator controls review and
publication in that deployment.

## Delisting

Published agents are continuously monitored. A demotion review may be opened
when:

- 7-day error rate exceeds 25%
- 7-day scope-denied rate exceeds 5%
- 30-day security flag count reaches 3

A P0 security flag triggers an agent-level kill switch. Recovery is manual:
security review must clear the kill switch after the incident is understood.

## Related

- [App Store platform](appstore-platform.md) - lifecycle, permission, cost, and trust model.
- [Example agents](example-agents.md) - tier-specific reference manifests.
- [Testing your agent](testing-your-agent.md) - what to validate before submission.
- [SDK reference](sdk-reference.md) - manifest and OpenAPI contract.
