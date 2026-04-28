# Sprint 4 MARKETPLACE-1 — Marketplace UX + Distribution

**Status:** Design draft, written during Kalas-Cowork session 2026-04-28, pending Kalas seal.
**Author:** Claude coworker (Cowork session), reviewed by Kalas.
**Implements:** Phase 4 W3-W4 deliverable per `docs/specs/phase-4-master.md`
§4 (MARKETPLACE-1) and `docs/specs/adr-015-marketplace-distribution-trust-tiers.md`.
**Precondition:** SDK-1 shipped, PERM-1 shipped, ADR-015 sealed.

---

## Goal

Ship the public-facing marketplace and the bundle distribution
pipeline. After MARKETPLACE-1 lands:

- Users browse, search, filter, and install agents from
  Workspace → Marketplace.
- Developers' submissions via `lumo-agent submit` upload bundles to
  Supabase Storage `agent-bundles` (object-locked) and create
  `marketplace_agents` rows in `state='pending_review'`.
- The platform serves bundles by sha256-verified download.
- Patch updates auto-install; minor/major prompts re-consent (delegating
  to PERM-1).
- Yanked versions migrate pinned users to the nearest non-yanked patch
  within 1 hour.
- Anti-typosquatting blocks confusable agent_ids at submission.

---

## What previous sprints already shipped

- **SDK-1** — `lumo-agent submit` exists and POSTs to
  `https://api.lumo.rentals/v1/marketplace/submissions` (currently the
  stub returning 501). MARKETPLACE-1 makes it real.
- **PERM-1** — install flow, consent screen, scope-grant tables.
  MARKETPLACE-1 calls into PERM-1 for the install half of the
  marketplace install button.
- **`app/marketplace/page.tsx`** (commit `8954920` 2026-04-28) — early
  marketplace UI scaffold. MARKETPLACE-1 replaces and extends it.
- **`lib/marketplace-ui.ts`, `lib/marketplace-intelligence.ts`** —
  existing helpers for tile rendering and risk badges. Reused.

---

## What this sprint adds

Six workstreams.

1. **Migration 029 — marketplace schema extension**
   Extends the stub `marketplace_agents` from PERM-1 with the full
   ADR-015 §4.2 columns; adds `marketplace_agent_versions`,
   `agent_security_reviews`, `agent_ratings` (UI deferred to post-MVP),
   and the Phase-5 commerce columns (`price_usd`, `billing_period`,
   `revenue_split_pct` — all defaulted, no UI).

2. **`agent-bundles` storage bucket**
   Supabase Storage bucket with object-lock enabled. Per-version path:
   `<agent_id>/<version>/bundle.tar.gz`. Sha256 of bundle stored in
   `marketplace_agents.bundle_sha256` for download-time verification.
   Bundle signed by author submission key (key infra is a follow-on;
   MARKETPLACE-1 ships the verification check stubbed and TRUST-1 wires
   the real key store).

3. **Submission API**
   - `POST /api/marketplace/submissions` — accepts a multipart payload
     with the bundle tarball + manifest. Validates the manifest server-side
     (re-runs the SDK validator to defend against client tampering),
     runs anti-typosquatting (Levenshtein distance + punycode), inserts
     `marketplace_agents` row in `state='pending_review'`, hands off to
     TRUST-1's automated check pipeline (TRUST-1 ships W5; this sprint's
     stub auto-publishes `experimental` tier and queues `community` /
     `verified`).
   - `POST /api/marketplace/agents/:id/yank` — admin/author yanks a
     version.
   - `GET /api/marketplace/agents/:id/bundles/:version/download` — signed
     URL for SDK runtime to fetch bundle, sha256-verified on the way down.

4. **Browse + search + filter API**
   - `GET /api/marketplace?q&category&tier&installed_only&page` —
     returns paginated tile data. Search powered by `lumo_recall_unified`
     (Phase 3 MMRAG-1) when available; falls back to ILIKE on
     `marketplace_agents.manifest`.
   - `GET /api/marketplace/agents/:id` — detail page payload.
   - `GET /api/marketplace/trending?window=7d` — install-velocity ranked.
   - `GET /api/marketplace/lumos-picks` — hand-curated row.

5. **UI surfaces**
   - `app/marketplace/page.tsx` — browse view (replace the stub).
   - `app/marketplace/[id]/page.tsx` — detail view with capabilities,
     scopes, cost, author, install button.
   - `app/marketplace/install/[id]/page.tsx` — wraps PERM-1's consent
     screen, then redirects to "configure" page (caps, qualifiers).
   - `app/admin/marketplace/lumos-picks/page.tsx` — internal-only
     curation editor.
   - Components: `MarketplaceTile`, `TrustBadge`, `CategoryRail`,
     `SearchBar`, `FilterChips`.

6. **Patch auto-install + version yank propagation**
   - Cron `app/api/cron/marketplace-version-sync/route.ts` runs every 15
     minutes. Detects new patch versions, auto-installs for users on the
     prior patch (writes `lifecycle_published` event, no UI prompt).
   - Detects yanked versions, migrates pinned users to the nearest
     non-yanked patch in the same minor; writes `lifecycle_yank` events.
   - SLA: yank → migrate complete within 1 hour (CI test enforces).

---

## Schema — migration 029

```sql
-- db/migrations/029_marketplace_distribution.sql

-- Extend marketplace_agents (PERM-1 created the stub; here we add the rest)
alter table public.marketplace_agents
  add column if not exists current_version       text,
  add column if not exists pinned_minimum        text,
  add column if not exists trust_tier            text not null default 'experimental'
    check (trust_tier in ('official','verified','community','experimental')),
  add column if not exists state                 text not null default 'pending_review'
    check (state in ('pending_review','published','yanked','killed','withdrawn')),
  add column if not exists category              text,
  add column if not exists install_count         integer not null default 0,
  add column if not exists rating_avg            numeric(3,2),
  add column if not exists rating_count          integer not null default 0,
  add column if not exists bundle_sha256         text,
  add column if not exists price_usd             numeric(10,2) default 0,
  add column if not exists billing_period        text default 'one_time',
  add column if not exists revenue_split_pct     numeric(5,2) default 0,
  add column if not exists author_email          text,
  add column if not exists author_name           text,
  add column if not exists author_url            text,
  add column if not exists homepage              text,
  add column if not exists privacy_url           text,
  add column if not exists support_url           text,
  add column if not exists data_retention_policy text,
  add column if not exists updated_at            timestamptz not null default now();

create index if not exists marketplace_agents_published
  on public.marketplace_agents (trust_tier, install_count desc)
  where state = 'published' and killed = false;

create table public.marketplace_agent_versions (
  agent_id      text not null,
  version       text not null,
  manifest      jsonb not null,
  bundle_path   text not null,                 -- e.g., agent-bundles/<id>/<v>/bundle.tar.gz
  bundle_sha256 text not null,
  signature     text,                          -- author key signature (verified by TRUST-1)
  published_at  timestamptz not null default now(),
  yanked        boolean not null default false,
  yanked_reason text,
  yanked_at     timestamptz,
  primary key (agent_id, version)
);

create index marketplace_versions_active
  on public.marketplace_agent_versions (agent_id, published_at desc)
  where yanked = false;

create table public.agent_security_reviews (
  agent_id      text not null,
  agent_version text not null,
  reviewer      text not null,
  reviewed_at   timestamptz not null default now(),
  outcome       text not null check (outcome in ('approved','rejected','needs_changes')),
  notes         text,
  primary key (agent_id, agent_version)
);

create table public.agent_ratings (
  user_id     uuid not null references public.profiles(id) on delete cascade,
  agent_id    text not null,
  rating      smallint not null check (rating between 1 and 5),
  review_text text,
  created_at  timestamptz not null default now(),
  primary key (user_id, agent_id)
);

-- RLS
alter table public.marketplace_agents enable row level security;
alter table public.marketplace_agent_versions enable row level security;
alter table public.agent_security_reviews enable row level security;
alter table public.agent_ratings enable row level security;

-- Public read on published, non-killed marketplace rows
create policy marketplace_public_read on public.marketplace_agents
  for select using (state = 'published' and killed = false);
create policy marketplace_versions_public_read on public.marketplace_agent_versions
  for select using (yanked = false);

-- agent_security_reviews: admin role only (RLS denies by default; admin uses service role)
-- agent_ratings: user reads own + aggregate
create policy ratings_self_read on public.agent_ratings
  for select using (auth.uid() = user_id);
create policy ratings_self_write on public.agent_ratings
  for insert with check (auth.uid() = user_id);
create policy ratings_self_update on public.agent_ratings
  for update using (auth.uid() = user_id);
```

---

## Anti-typosquatting

ADR-015 §6.3:

```ts
// lib/marketplace/typosquatting.ts

const RESERVED_PREFIXES = ["lumo-", "official-", "verified-"];

export function checkTyposquat(candidate_id: string): TyposquatResult {
  // 1. Reserved prefix
  for (const prefix of RESERVED_PREFIXES) {
    if (candidate_id.startsWith(prefix)) {
      return { ok: false, reason: "reserved_prefix" };
    }
  }

  // 2. Punycode / homoglyph
  if (containsHomoglyph(candidate_id) || candidate_id !== candidate_id.normalize("NFKC")) {
    return { ok: false, reason: "homoglyph" };
  }

  // 3. Levenshtein distance
  const officials = await listOfficialAgentIds();
  const verifieds = await listVerifiedAgentIds();
  for (const oid of officials) {
    if (levenshtein(candidate_id, oid) < 3) return { ok: false, reason: "near_official", neighbor: oid };
  }
  for (const vid of verifieds) {
    if (levenshtein(candidate_id, vid) < 2) return { ok: false, reason: "near_verified", neighbor: vid };
  }
  return { ok: true };
}
```

The submission API calls this before insert. CI test exercises both
the homoglyph reject and the near-neighbor reject paths.

---

## Submission flow end-to-end

1. Developer runs `lumo-agent submit` (SDK-1 already built this; the
   CLI was stubbed to 501).
2. CLI bundles the agent, signs it with the author's submission key
   (read from `~/.lumo-agent/credentials`), POSTs to
   `https://<host>/api/marketplace/submissions` with multipart payload.
3. The submission API:
   a. Re-validates the manifest server-side (defense against client
      tampering).
   b. Runs `checkTyposquat` on `manifest.id`.
   c. Runs developer rate-limit checks (ADR-015 §6.1: 5 submissions/day
      free tier, 10 pending reviews concurrently, 10/day failed
      validations before throttle).
   d. Uploads the bundle to `agent-bundles/<id>/<version>/bundle.tar.gz`.
   e. Computes sha256, stores in `marketplace_agents.bundle_sha256` and
      `marketplace_agent_versions.bundle_sha256`.
   f. Inserts/updates `marketplace_agents` and inserts
      `marketplace_agent_versions` row.
   g. Hands off to TRUST-1's automated check pipeline (TRUST-1 W5
      wires the real pipeline; MARKETPLACE-1 ships a stub):
       - For `experimental` tier: auto-publish on automated checks pass
         (state → `published`).
       - For `community` tier: queue, same-day SLA, auto-publish on
         pipeline pass.
       - For `verified` tier: queue, 5-business-day SLA, requires
         human review (TRUST-1 surface).
4. Developer receives a tracking URL; can poll
   `GET /api/marketplace/submissions/:id/status`.

---

## Browse / search / filter

`GET /api/marketplace`:
- `q` — free text. Routes to `lumo_recall_unified` if MMRAG-1 health
  ok; falls back to ILIKE on `marketplace_agents.manifest @@ q`.
- `category` — one of the v1 hardcoded categories: Productivity,
  Finance, Travel, Communication, Lumo Rentals, Other.
- `tier` — one of the four trust tiers (multi-select).
- `installed_only` — filter to user's installed agents.
- `page`, `limit` — pagination.

Tile rendering (`MarketplaceTile`):
- Name, author display name (linked to homepage).
- Trust badge (per ADR-015 §2): Lumo logo / Verified check / Community
  tag / Experimental warning + warning banner if `experimental`.
- One-line description.
- Install state: "Install" / "Installed" / "Update available".
- Cost summary: `$<max_cost_usd_per_invocation> max per use`.
- Install count + rating placeholder.

Detail page (`app/marketplace/[id]/page.tsx`):
- Full description.
- Trust badge with link to "What does this badge mean?" docs.
- Capabilities list with consent text preview.
- Required scopes summary.
- Cost-model summary.
- Author + homepage + support + privacy links.
- Data retention policy.
- Reviews + ratings (placeholder; UI ships post-MVP).
- Install button (≤ 4 taps to installed via the install flow).

---

## Patch auto-install + yank propagation

Cron at `/api/cron/marketplace-version-sync` runs every 15 minutes:

```ts
// pseudocode
for each user_install in agent_installs where state = 'installed':
  latest = latest_non_yanked_published_version(user_install.agent_id)
  if same minor as user_install.agent_version and patch > current:
    update install to latest
    write lifecycle_published event
    no UI prompt (patch updates auto-install per ADR-015 §5.1)
  if user_install.agent_version is yanked:
    fallback = nearest_non_yanked_patch_in_same_minor(user_install.agent_id, user_install.agent_version)
    if fallback exists:
      update install to fallback
      write lifecycle_yank_migration event
    else:
      update install to state = 'suspended', error = 'all_versions_yanked'
```

SLA: yank → migrate complete within 1 hour. CI test creates a yanked
version, runs the cron, asserts the install row migrates.

---

## Acceptance

Per ADR-015 §9.1 and `phase-4-master.md` §4:

1. Marketplace surface live at Workspace → Marketplace.
2. All three reference agents from SAMPLE-AGENTS discoverable.
3. Browse, search, filter, install, uninstall flows live; install ≤ 4
   taps from tile to installed.
4. Anti-typosquatting CI test: a submission with `agent_id =
   "summarize-email-daily"` (Levenshtein 1 from
   `summarize-emails-daily`) is rejected with `near_verified`.
5. Yank propagation test: yank a version → run cron → pinned users
   migrate within 1 hour.
6. Settings panel live with per-scope toggles, cost view (placeholder
   from PERM-1), and audit summary.
7. Bundle download integrity: every download computes sha256 and
   refuses on mismatch.
8. Patch auto-install test: publishing 1.2.1 over 1.2.0 auto-installs
   for all users in `agent_installs` on `1.2.0`.
9. p95 marketplace browse load < 800 ms (HNSW + ILIKE search).
10. Three commits land on `main`:
    - `feat(db): add migration 029 marketplace distribution`.
    - `feat(marketplace): add submission api + bundle storage`.
    - `feat(marketplace): browse + search + filter + install ui`.

---

## Out of scope

- Ratings + reviews UI (post-MVP; schema lands in this sprint).
- Per-tenant private marketplaces (Phase 5+ via
  `marketplace_agents.tenant_scope`).
- Stripe Connect for paid agents (Phase 5).
- Author-key signing infrastructure beyond the placeholder (TRUST-1
  W5).
- Personalised tile ordering via BANDIT-1 (Phase 4.5).
- Admin curation editor for "Lumo's picks" (admin surface placeholder
  ships; full CMS-style editor is Phase 4.5).

---

## File map

New files (schema):
- `db/migrations/029_marketplace_distribution.sql`

New files (storage):
- `infra/supabase/storage-buckets/agent-bundles.sql` — bucket
  declaration with object-lock enabled.

New files (backend):
- `app/api/marketplace/submissions/route.ts`
- `app/api/marketplace/submissions/[id]/status/route.ts`
- `app/api/marketplace/agents/[id]/route.ts`
- `app/api/marketplace/agents/[id]/yank/route.ts`
- `app/api/marketplace/agents/[id]/bundles/[version]/download/route.ts`
- `app/api/marketplace/route.ts` (browse/search)
- `app/api/marketplace/trending/route.ts`
- `app/api/marketplace/lumos-picks/route.ts`
- `app/api/cron/marketplace-version-sync/route.ts`
- `lib/marketplace/submission.ts`
- `lib/marketplace/typosquatting.ts`
- `lib/marketplace/bundle-store.ts`
- `lib/marketplace/version-sync.ts`
- `lib/marketplace/search.ts`
- `lib/marketplace/rate-limit.ts`

New files (UI):
- `app/marketplace/page.tsx` (replaces existing stub)
- `app/marketplace/[id]/page.tsx`
- `app/marketplace/install/[id]/page.tsx`
- `app/admin/marketplace/lumos-picks/page.tsx`
- `components/marketplace/MarketplaceTile.tsx`
- `components/marketplace/TrustBadge.tsx`
- `components/marketplace/CategoryRail.tsx`
- `components/marketplace/SearchBar.tsx`
- `components/marketplace/FilterChips.tsx`
- `components/marketplace/CapabilityList.tsx`
- `components/marketplace/CostSummary.tsx`

Modified files:
- `lib/marketplace-ui.ts` — extend with new tile renderer.
- `lib/marketplace-intelligence.ts` — extend with category-aware
  ranking.
- `vercel.json` — register the new cron path
  (`/api/cron/marketplace-version-sync`).

New tests:
- `tests/marketplace-submission.test.mjs`
- `tests/marketplace-typosquatting.test.mjs`
- `tests/marketplace-yank-propagation.test.mjs`
- `tests/marketplace-patch-auto-install.test.mjs`
- `tests/marketplace-search.test.mjs`
- `tests/marketplace-browse-perf.test.mjs` (p95 < 800 ms)
- `tests/marketplace-install-flow-e2e.test.mjs`
