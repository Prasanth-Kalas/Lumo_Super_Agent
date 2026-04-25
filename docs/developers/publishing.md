# Publishing your agent

How to get an agent into a live Lumo deployment's registry. The short version:
deploy your agent, submit its manifest URL through `/publisher`, pass automated
certification, then wait for admin approval.

The old manual-registry path still works for private deployments, but the
managed Lumo app store path is now the publisher portal.

## Publishing options

### Option 1 — Public agent in the Lumo managed deployment

For agents that should be available to every Lumo user:

1. Your agent must be hosted at a stable HTTPS URL.
2. Sign in to the Super Agent and open `/publisher`.
3. Paste your `/.well-known/agent.json` URL.
4. The portal certifies your manifest, OpenAPI, health endpoint, OAuth metadata,
   permissions, and money-tool safety.
5. Passing submissions enter `/admin/review-queue`.
6. An admin approves the app; approved rows are loaded from `partner_agents` and
   appear in `/marketplace`.

Expected turnaround: days, not weeks — these reviews are primarily checking that your manifest is well-formed and your agent is reachable, not judging business value.

Submissions with blocking certification issues are stored as
`certification_failed` and show the report to the publisher. Fix those findings
and resubmit.

### Option 2 — Private registry in your own Lumo deployment

For agents internal to your org:

1. Run your own Super Agent deployment.
2. Fork or branch the repo; edit `config/agents.registry*.json` or insert an
   `approved` row into `partner_agents`.
3. Deploy the Super Agent to your infrastructure.
4. Users in your org sign into your Super Agent deployment (with whatever SSO/Supabase Auth you wire), see your agent in `/marketplace`, connect, and use it.

No Lumo-maintainer review involved. You own the deployment, you own the registry.

### Option 3 — Experimental agent in a dev deployment

During development, temporarily register by:

1. Running Super Agent locally or a dev branch.
2. Add your local/tunnel URL to `config/agents.registry.json`, or submit through
   `/publisher` if your local Super Agent has Supabase configured.
3. Using it, iterating, removing when done.

Not durable — don't leave an ngrok URL in a production manifest list.

## Requirements for the managed registry

Your PR needs to satisfy:

### Contract correctness

- Manifest parses as `AgentManifest` from the current SDK version.
- OpenAPI parses as valid OpenAPI 3.1.
- Health endpoint returns 200 with `{ ok: true }` at least 99% of the time (measured over a 7-day probe window).
- Tool responses match the OpenAPI schemas.

### Safety

- Autonomy markers (`x-lumo-autonomy`) are correctly set. Over-strict is fine; under-strict is a blocker.
- Destructive actions use the confirmation card pattern.
- Error responses are structured (`{ error: { code, message, retryable } }`).
- Logs don't leak user content or tokens.

### UX

- Tool `summary` and `description` fields are clear and actionable.
- `intents` and `example_utterances` match real user phrasings.
- Listing has a category, logo, one_liner, and a privacy_note.

### Hosting stability

- TLS certificate valid.
- CORS allows the Super Agent's domain to fetch manifest + OpenAPI.
- Reasonable uptime (we're not strict SLA judges, but a manifest URL that's down half the time will get delisted).

## What gets reviewed vs. what doesn't

**Reviewed:**
- The manifest.
- The OpenAPI.
- Sample tool calls (contract-tested).
- Health probe output.
- Privacy / safety claims in the listing.

**NOT reviewed:**
- Your backend code.
- Your infrastructure choices.
- Your business logic.
- Your pricing.

Lumo treats third-party agents as opaque HTTP services. Your implementation is yours; we only verify what's at the contract boundary.

## After merge — the operator's side

Once the PR is merged, the managed Lumo deployment's operator takes one more step if your agent uses OAuth:

1. Register an OAuth app with the provider.
2. Set the `client_id_env` and `client_secret_env` vars on Vercel.
3. Add the Super Agent's callback URL to the provider app's allowed redirects.

Until that's done, your marketplace card shows but "Connect" fails with a "not configured" error. The operator's PR reviewer usually tracks this as a pre-deploy checklist item; provide them everything they need via the docs you include in your PR.

## Versioning your agent post-publish

Subsequent updates to your agent don't require a new PR as long as:

- Your manifest's `base_url` and `openapi_url` are unchanged.
- Your SDK version stays within the same major.
- You haven't added a new required scope (that's effectively a new product).

Just redeploy your agent. The Super Agent's registry re-probes every 5 minutes; changes appear shortly after.

For breaking changes (new required scope, major SDK bump, significant UX changes), open a new PR to signal — and mention what the change is so operators know.

## Delisting

If your agent:

- Is offline for more than 24 hours during active probes.
- Violates the privacy posture claimed in its listing.
- Returns error responses for more than 10% of calls over 48 hours.
- Is reported by users for bad behavior that can't be resolved in a reasonable window.

...the managed deployment's maintainers may temporarily remove your manifest URL from the registry. You'll get an issue on your repo explaining why; re-listing happens when the issue is resolved.

For private deployments (self-hosted Super Agent), delisting is whatever your operator wants it to be — they control the registry.

## A final note on trust

Publishing an agent on Lumo means users will consent to your agent reading scopes from their accounts on your domain. That's a trust transfer they're making, and they're doing it partly because Lumo vouched for you by including you in the registry. Take that seriously:

- Log as little provider content as possible.
- Don't sell, share, or aggregate user data.
- Be explicit in your privacy_note — users read those.
- Fix bugs that affect user data fast.

Lumo's reputation is everyone's reputation. Protect it and ours by treating users' trust as a renewable-but-fragile resource.

## Related

- [quickstart.md](quickstart.md) — your first agent.
- [testing-your-agent.md](testing-your-agent.md) — what to validate before publishing.
- [sdk-reference.md](sdk-reference.md) — contract specs.
