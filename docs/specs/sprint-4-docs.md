# Sprint 4 DOCS — Public Developer Documentation Site

**Status:** Design draft, written during Kalas-Cowork session 2026-04-28, pending Kalas seal.
**Author:** Claude coworker (Cowork session), reviewed by Kalas.
**Implements:** Phase 4 W6 deliverable per `docs/specs/phase-4-master.md`
§8 (DOCS).
**Precondition:** SDK-1, SAMPLE-AGENTS, PERM-1, MARKETPLACE-1, COST-1,
DEV-DASH, TRUST-1 all shipped. DOCS is the last Phase 4 deliverable;
it depends on all prior surfaces existing so the docs reference real
behaviour, not pre-implementation hopes.

---

## Goal

Move the 13-file developer doc pack from `docs/developers/` (where
SDK-1 left it) to a public-facing site at `docs.lumo.rentals/agents`,
fill the placeholders that prior sprints punted on, and establish the
publishing pipeline so any merge to `main` that touches `docs/developers/`
auto-rebuilds the site within 5 minutes.

After DOCS ships:
- A non-Lumo developer can land on `docs.lumo.rentals/agents`, follow
  the quickstart, get their first agent running locally in 15 minutes,
  understand the trust tiers and what tier their agent qualifies for,
  consult the API reference for SDK types and methods, and ship a
  submission.
- Every cross-reference between docs and platform behaviour is live —
  e.g., the consent UI behaviour described in PERM-1's docs page
  matches what's deployed in the consent flow.
- The docs site has its own analytics so we can see which pages
  developers stall on and iterate.

---

## What previous sprints already shipped

- **SDK-1** drafted these 13 files in `docs/developers/`:
  - `00-overview.md`
  - `01-quickstart.md`
  - `02-manifest-reference.md`
  - `03-capabilities.md`
  - `04-scopes-and-permissions.md`
  - `05-cost-model.md`
  - `06-trust-tiers.md`
  - `07-runtime-api.md`
  - `08-confirmation-cards.md`
  - `09-state-and-idempotency.md`
  - `10-testing-locally.md`
  - `11-submission-and-review.md`
  - `12-faq.md`
  - `example-agents.md` (placeholder; SAMPLE-AGENTS filled it)
- **SAMPLE-AGENTS** — three reference agents that the docs reference.
- **MARKETPLACE-1, PERM-1, COST-1, DEV-DASH, TRUST-1** — each shipped
  the surface its docs page describes; DOCS now updates the prose to
  match the as-built behaviour.

---

## What this sprint adds

Five workstreams.

1. **Docs site bootstrap**
   - Docusaurus 3 site at `apps/docs/` in the monorepo.
   - Source: `docs/developers/*.md`. The site imports the same files
     so there's exactly one source of truth.
   - Theme: Lumo brand (use the in-repo `lib/brand-tokens.ts` as the
     CSS variable bridge).
   - Search: Algolia DocSearch (free for open-source projects;
     application + custom config in `apps/docs/docusaurus.config.ts`).
   - Sidebar: ordered to match the 13-file numbering, with grouped
     sections (Get started, Build, Ship, Reference, FAQ).

2. **Fill the deferred placeholders**
   Several docs pages drafted in SDK-1 reference future-sprint
   surfaces with `(coming in Phase 4)` placeholders. Replace them now:
   - `04-scopes-and-permissions.md` — describe the consent UI as
     shipped in PERM-1, including spending caps, time-bounded grants,
     re-consent flow, and revocation.
   - `05-cost-model.md` — describe cost log, daily / monthly digests,
     fallback model behaviour from COST-1, and the user budget tiers
     (free/pro/enterprise) with concrete cap values.
   - `06-trust-tiers.md` — describe the four tiers as shipped in
     MARKETPLACE-1 + TRUST-1, including the automated check pipeline,
     SLA per tier, and the demotion / kill thresholds.
   - `11-submission-and-review.md` — describe the full TRUST-1
     pipeline including author keys, bundle signing, and the reviewer
     queue UX (developer-facing perspective).
   - `example-agents.md` — replace the stub with full walkthroughs for
     all three SAMPLE-AGENTS agents, line-by-line manifest commentary,
     and runnable copy-paste snippets.

3. **API reference auto-generation**
   - TypeDoc against `packages/lumo-agent-sdk/src/`.
   - Output rendered as Docusaurus pages under `/reference/api/`.
   - Cross-linked from the prose docs (e.g.,
     `02-manifest-reference.md` links to `/reference/api/Manifest`).
   - CI fails on broken cross-links (Docusaurus has a built-in
     broken-link checker).

4. **Continuous publishing pipeline**
   - GitHub Action `.github/workflows/docs-publish.yml`:
     - Trigger: push to `main` that touches `docs/developers/**`,
       `apps/docs/**`, or `packages/lumo-agent-sdk/src/**`.
     - Build: `npm run docs:build`.
     - Deploy: Vercel (separate project from the main app, hosted at
       `docs.lumo.rentals`).
     - SLA: site reflects the merge within 5 minutes (Vercel deploy
       time + DNS propagation; the existing `docs.lumo.rentals` zone
       is already provisioned, just needs the apex pointed).
   - Slack notification on deploy failure to `#agent-platform`.

5. **Analytics + feedback**
   - Plausible Analytics on `docs.lumo.rentals/agents` (privacy-respecting,
     no cookies, GDPR clean).
   - Per-page "Was this helpful?" widget that POSTs to
     `app/api/docs/feedback/route.ts` with page id + score + optional
     text. Stored in `docs_page_feedback` table.
   - Weekly digest email to `#agent-platform` listing top-feedback
     pages (positive and negative).

---

## Schema — migration 033

```sql
-- db/migrations/033_docs_feedback.sql

create table public.docs_page_feedback (
  id              bigint generated by default as identity primary key,
  page_id         text not null,                   -- e.g., 'developers/04-scopes-and-permissions'
  user_id         uuid references public.profiles(id) on delete set null,
  anonymous_id    text,                            -- for unauthenticated visitors
  score           smallint not null check (score in (-1, 1)),
  free_text       text,
  url_referrer    text,
  user_agent      text,
  created_at      timestamptz not null default now()
);

create index docs_feedback_by_page on public.docs_page_feedback (page_id, created_at desc);

alter table public.docs_page_feedback enable row level security;
-- No public read; service-role only for the digest cron.
```

---

## Site structure

```
docs.lumo.rentals/agents/
├── /                                    → 00-overview.md (landing)
├── /get-started/quickstart              → 01-quickstart.md
├── /build/manifest                      → 02-manifest-reference.md
├── /build/capabilities                  → 03-capabilities.md
├── /build/scopes-and-permissions        → 04-scopes-and-permissions.md
├── /build/cost-model                    → 05-cost-model.md
├── /build/runtime-api                   → 07-runtime-api.md
├── /build/confirmation-cards            → 08-confirmation-cards.md
├── /build/state-and-idempotency         → 09-state-and-idempotency.md
├── /build/testing                       → 10-testing-locally.md
├── /ship/trust-tiers                    → 06-trust-tiers.md
├── /ship/submission-and-review          → 11-submission-and-review.md
├── /ship/example-agents                 → example-agents.md
├── /reference/api/                      → TypeDoc-generated
├── /reference/scope-taxonomy            → vendored from ADR-014 §3
├── /reference/error-codes               → vendored from SDK source
├── /faq                                 → 12-faq.md
└── /changelog                           → SDK release notes
```

---

## Continuous publishing pipeline

```yaml
# .github/workflows/docs-publish.yml
name: Publish docs site

on:
  push:
    branches: [main]
    paths:
      - 'docs/developers/**'
      - 'apps/docs/**'
      - 'packages/lumo-agent-sdk/src/**'

jobs:
  publish:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: '20', cache: 'npm' }
      - run: npm ci
      - run: npm run docs:build
      - name: Deploy to Vercel
        run: npx vercel deploy --prod --token=${{ secrets.VERCEL_TOKEN }} apps/docs/build
      - name: Notify Slack on failure
        if: failure()
        uses: slackapi/slack-github-action@v1
        with:
          payload: '{"text":"docs site publish failed: ${{ github.event.head_commit.url }}"}'
        env:
          SLACK_WEBHOOK_URL: ${{ secrets.SLACK_WEBHOOK_AGENT_PLATFORM }}
```

The Vercel project is separate from the main app:
- Project name: `lumo-docs`.
- Domain: `docs.lumo.rentals`.
- DNS: A record pointing apex to Vercel's anycast IP; CNAME on
  `agents.docs.lumo.rentals` → vercel-deploy URL (Vercel's apex
  alternative).

Build time budget: 90 seconds for the Docusaurus build + 60 seconds
for Vercel deploy = 150 seconds. Adding GitHub Action queue time
(~30s) and DNS propagation (cached at 60s TTL on Vercel side), p95 is
~4 minutes — under the 5-minute SLA.

---

## Quickstart resolution

The 15-minutes-to-first-agent claim depends on the quickstart actually
working. DOCS verifies this with a CI E2E test:

```ts
// tests/docs-quickstart-e2e.test.mjs

test("quickstart 15-min path resolves end-to-end", async () => {
  // 1. Run the same npx command the docs tell developers to run
  await exec("npx @lumo/agent-cli@latest init my-test-agent --template=weather-now");
  // 2. Run the same dev command
  await exec("cd my-test-agent && npm run dev");
  // 3. Hit the local invocation endpoint with the same curl the docs show
  const response = await fetch("http://localhost:3500/invoke", {
    method: "POST",
    body: JSON.stringify({ capability: "whats_the_weather_now", inputs: { fallback_location: "Las Vegas" }}),
  });
  expect(response.status).toBe(200);
  const body = await response.json();
  expect(body.outputs.summary).toBeDefined();
  // 4. Run the validator the docs say to run
  const { stdout } = await exec("npx lumo-agent validate");
  expect(stdout).toContain("OK: 0 errors");
});
```

This test lives in the docs sprint's CI lane and runs nightly. If the
quickstart breaks (because some upstream change broke the
template / CLI / SDK / sample), the test fails and a Slack alert
fires.

---

## Acceptance

Per `phase-4-master.md` §8:

1. `docs.lumo.rentals/agents` resolves and renders the Docusaurus site.
2. All 13 doc pages render with no broken cross-links (Docusaurus
   broken-link checker passes in CI).
3. API reference auto-generated from TypeDoc; every public export of
   `@lumo/agent-sdk` has a reference page.
4. Search live (Algolia DocSearch), top results are sensible for these
   queries: "manifest scopes", "confirmation card", "test locally",
   "submit agent", "cost ceiling".
5. The five deferred placeholders from SDK-1's docs are filled with
   as-built content from PERM-1, COST-1, MARKETPLACE-1, TRUST-1, and
   SAMPLE-AGENTS.
6. Continuous publishing pipeline lands site updates within 5 minutes
   of a docs-touching merge to `main` (CI test: trigger a doc edit,
   measure deploy URL freshness).
7. Quickstart E2E test resolves in < 15 minutes wall-clock on a clean
   dev machine simulation in CI.
8. Plausible Analytics live; "Was this helpful?" widget functional;
   weekly digest cron lands.
9. Two commits on `main`:
   - `feat(docs): docusaurus site at docs.lumo.rentals/agents`.
   - `feat(docs): fill placeholder pages + analytics + feedback`.

---

## Out of scope

- Multi-language docs (i18n) — Phase 5.
- Versioned docs for SDK 2.x — Phase 5 when 2.x ships.
- Embedded interactive sandbox (CodeSandbox/StackBlitz embed) — Phase
  4.5; the v1 quickstart relies on `lumo-agent dev` locally.
- Video walkthroughs — Phase 4.5.
- Public RSS feed of release notes — Phase 4.5; v1 surfaces them as
  the changelog page only.
- Author-facing docs for the developer dashboard (DEV-DASH); a
  developer-side `/docs/developer-dashboard` lands in DEV-DASH, not
  here. DOCS only owns the SDK and platform-contract docs.

---

## File map

New files (schema):
- `db/migrations/033_docs_feedback.sql`

New files (site):
- `apps/docs/docusaurus.config.ts`
- `apps/docs/sidebars.ts`
- `apps/docs/src/css/custom.css` (Lumo brand tokens)
- `apps/docs/src/components/HelpfulFeedback.tsx`
- `apps/docs/src/theme/Footer.tsx`
- `apps/docs/static/img/lumo-mark.svg`

New files (CI / publish):
- `.github/workflows/docs-publish.yml`
- `tests/docs-quickstart-e2e.test.mjs`
- `tests/docs-broken-links.test.mjs`

New files (backend):
- `app/api/docs/feedback/route.ts`
- `app/api/cron/docs-weekly-digest/route.ts`
- `lib/docs/feedback-digest.ts`

Modified files (in-place fill of SDK-1 placeholders):
- `docs/developers/04-scopes-and-permissions.md`
- `docs/developers/05-cost-model.md`
- `docs/developers/06-trust-tiers.md`
- `docs/developers/11-submission-and-review.md`
- `docs/developers/example-agents.md`

Modified files (root):
- `package.json` — add `apps/docs` to workspaces, add `docs:build`,
  `docs:dev` scripts.
- `turbo.json` — add `docs:build` task.
- `vercel.json` — register `/api/cron/docs-weekly-digest`.

DNS / infra (not in repo):
- `docs.lumo.rentals` apex A record → Vercel anycast.
- Vercel project `lumo-docs` provisioned, `VERCEL_TOKEN` set in
  GitHub Actions secrets.
- Algolia DocSearch application created, API key set in
  `apps/docs/docusaurus.config.ts` (publishable key, not secret).
