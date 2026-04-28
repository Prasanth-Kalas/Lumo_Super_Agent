# ADR-015 — Marketplace Distribution and Trust Tiers

**Status:** Proposed (drafted 2026-04-27, Phase 4). Codex MARKETPLACE-1 and TRUST-1 implement against this ADR.
**Authors:** Coworker M (architecture pass), to be reviewed by Kalas (CEO/CTO/CFO).
**Related:** `docs/specs/adr-013-agent-runtime-contract.md`,
`docs/specs/adr-014-agent-permissions-capabilities.md`,
`docs/specs/adr-016-agent-cost-metering-budgets.md`,
`docs/specs/phase-4-outlook.md`.
**Implements:** the four-tier trust model, the submission/review
pipeline, the distribution storage, the update propagation rules,
abuse handling, and the v1 marketplace UX requirements.

---

## 1. Context

ADR-013 defines the runtime contract; ADR-014 defines the permission
contract. ADR-015 is the *distribution* contract — how an agent
becomes available to users, how trust is communicated through the UI,
how updates propagate, and how abuse is handled.

The marketplace is the platform's user-facing surface. A marketplace
without trust tiers is a credibility failure: every agent looks the
same, the user has no signal to distinguish a Lumo-built agent from a
hobbyist hack, and the first malicious agent collapses the whole
surface. A marketplace with trust tiers but no review pipeline is the
same failure with extra typography. ADR-015 is the binding decision
on how reviews happen, how tiers are awarded, and how that maps to
the user's mental model.

The bias is shippable v1 with sealed extension paths, per Phase 4
master. Free in v1; paid agents are a Phase 5 extension whose data
model lives now so we don't migrate later.

---

## 2. Trust tiers — full definitions

| Tier | Definition | Distribution | UI badge | Default sandbox |
|---|---|---|---|---|
| `official` | Built by the Lumo team. Full security audit and ongoing on-call ownership. | Internal pipeline; not submitted via the public flow. | Lumo logo + "Official" | In-process allowed (review-gated) |
| `verified` | Third-party. Passed automated checks **and** a 5-business-day human security review. Author identity verified. | Public submission; promoted by review. | Verified check | E2B (default) |
| `community` | Third-party. Passed automated checks only. Author identity is email-verified but not legal-entity-verified. | Public submission; same-day automated review. | "Community" tag | E2B |
| `experimental` | Third-party. User installs at own risk. Loud warning banner on the marketplace tile and on every consent screen. | Public submission; minimal automated checks. | "Experimental" warning | E2B + warning banner |

The four tiers correspond to four columns in the marketplace UI and
to four review SLAs (§3). They also map to four default permission
postures in ADR-014:

- `official`, `verified`: time-bounded grants default off; the user
  may choose forever.
- `community`: time-bounded 30-day grant default; the user may
  choose forever.
- `experimental`: time-bounded 7-day grant default; the user may not
  choose forever (the platform requires periodic re-consent; this is
  the safety net for agents the user installed casually).

---

## 3. Submission flow

### 3.1 The developer's path

```
lumo-agent submit ./summarize-emails-daily/
```

The CLI:

1. Validates the manifest (`lumo-agent validate`, ADR-013 §3.2).
2. Bundles the agent into a tarball (entrypoint, dependencies,
   manifest, signed by the author's key).
3. Uploads to Supabase Storage `agent-bundles` bucket.
4. Inserts `marketplace_agents` row with
   `state = 'pending_review'`.
5. Returns a tracking URL the developer can poll.

### 3.2 Automated checks (every tier)

Before the manifest enters review, the platform runs:

- **Manifest validation** — schema, scope-allowlist, connector
  references, `max_cost_usd_per_invocation` ceiling.
- **Sandbox tests** — the bundle runs in E2B against a synthetic
  user; all happy-path capabilities are exercised; the test asserts
  no off-allowlist egress, no eval, no native-module loads.
- **Static-analysis checks** — known-bad-pattern matchers
  (cryptocurrency wallet scrapes, credential exfil patterns,
  prompt-injection backdoors, obfuscated network calls).
- **Anti-typosquatting** — the agent_id is checked against
  Levenshtein-distance ≤ 2 from any existing official or verified
  agent. Hits trigger manual review even for community tier.
- **Anti-impersonation** — author display name matched against
  reserved names ("Lumo", "Anthropic", common bank names, etc.).

Failure on any check returns a typed reason to the developer; they
fix and resubmit. Repeated failures within 24 hours throttle the
developer's submission rate (§7).

### 3.3 Tier promotion paths

| Target tier | Path | SLA |
|---|---|---|
| `experimental` | Automated checks only; published immediately on pass. | < 5 min |
| `community` | Automated checks + light reputation gating (author email-verified ≥ 24 h, no recent takedowns). | Same-day |
| `verified` | Automated checks + 5-business-day human security review. | 5 business days |
| `official` | Internal Lumo pipeline; not submitted via the public flow. | Internal sprint |

Promotion requests (e.g., a `community`-tier agent applies to be
`verified`) go to a queue managed via TRUST-1 tooling. The
TRUST-1 tooling is part of the Phase-4 deliverables (master spec §7).

### 3.4 Human review checklist (verified tier)

The human reviewer checks:

- Source-code review for malicious patterns missed by static
  analysis.
- Manifest scope ask vs. what the code actually does (over-asking
  is a denial reason).
- Privacy policy and data-retention statement match the code's
  actual behaviour.
- Author legal-entity identity (corporate / sole-proprietor
  documentation).
- License compatibility (the agent's license must permit
  distribution and the source-code review).
- A run on a synthetic Vegas user — does the agent behave as
  described.

The reviewer signs off in `agent_security_reviews`:

```sql
create table public.agent_security_reviews (
  agent_id      text not null,
  agent_version text not null,
  reviewer      text not null,
  reviewed_at   timestamptz not null default now(),
  outcome       text not null check (outcome in ('approved','rejected','needs_changes')),
  notes         text,
  primary key (agent_id, agent_version)
);
```

A `verified` agent that subsequently publishes a new minor or major
version triggers a re-review. Patch versions ride the prior review
unless the reviewer flagged the agent for tighter ongoing review
(`needs_changes` outcome history, or any user-reported abuse).

---

## 4. Distribution storage

### 4.1 Bundle storage

Agent bundles live in Supabase Storage `agent-bundles` bucket:

- Per-version directory: `agent-bundles/<agent_id>/<version>/bundle.tar.gz`.
- Object-lock enabled (immutability — ADR-013 §9.2).
- Sha256 of bundle stored in `marketplace_agents.bundle_sha256` for
  download-time verification.
- Bundle signed by the author's submission key; signature verified
  on download.

### 4.2 Marketplace index

```sql
create table public.marketplace_agents (
  agent_id              text primary key,
  current_version       text,                       -- latest published
  pinned_minimum        text,                       -- yanked-floor
  trust_tier            text not null check (trust_tier in ('official','verified','community','experimental')),
  state                 text not null check (state in ('pending_review','published','yanked','killed','withdrawn')),
  killed                boolean not null default false, -- emergency kill-switch (ADR-014)
  manifest              jsonb not null,             -- denormalised for fast browse
  category              text,                       -- e.g. 'productivity', 'finance'
  install_count         integer not null default 0,
  rating_avg            numeric(3,2),               -- post-MVP
  rating_count          integer not null default 0, -- post-MVP
  bundle_sha256         text,
  price_usd             numeric(10,2) default 0,    -- Phase 5 placeholder
  billing_period        text default 'one_time',    -- Phase 5 placeholder
  revenue_split_pct     numeric(5,2) default 0,     -- Phase 5 placeholder
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);

create table public.marketplace_agent_versions (
  agent_id     text not null,
  version      text not null,
  manifest     jsonb not null,
  bundle_path  text not null,
  bundle_sha256 text not null,
  published_at timestamptz not null default now(),
  yanked       boolean not null default false,
  yanked_reason text,
  primary key (agent_id, version)
);
```

The `marketplace_agents.manifest` column is the denormalised
*current* manifest for fast browse queries. The
`marketplace_agent_versions` table holds every published version.

---

## 5. Update propagation

### 5.1 Patch updates

A patch version (`1.2.0 → 1.2.1`) auto-installs to all users on next
invocation. The user is not prompted. The CLI rule is: patch is
bug-fix only — no new scopes, no new connectors, no new capabilities.
The validator rejects a patch bump that adds any of these.

### 5.2 Minor and major updates

Minor (`1.2.0 → 1.3.0`) and major (`1.2.0 → 2.0.0`) bumps may add or
change scopes. The user is prompted to re-consent (ADR-014 §5.2). Until
re-consent:

- The user stays pinned to the previous version in
  `agent_installs.pinned_version`.
- The user sees a "Update available" badge on the agent's tile.
- After **30 days** without re-consent, the agent's previous version
  is auto-pinned indefinitely until the user explicitly updates.
  This is a kindness — we don't want to nag users into clicking
  through prompts.

### 5.3 User-side pinning

Workspace → Settings → Agents → [Agent] → Version offers:

- "Always use latest" (default).
- "Pin to specific version" (drop-down listing every non-yanked
  version).
- "Stay on previous major" (sticky for major bumps).

A pinned version that subsequently gets yanked falls back to the
nearest non-yanked patch in the same minor.

### 5.4 Yank propagation

A yanked version is removed from the install pool within 1 hour of
yank. The platform writes `lifecycle_yank` audit rows for every user
forcibly migrated off the yanked version.

---

## 6. Abuse handling

### 6.1 Rate limits per developer

| Limit | Free tier | Paid (Phase 5) |
|---|---|---|
| Submissions per day | 5 | 20 |
| Pending reviews concurrently | 3 | 10 |
| Failed-validation submissions before throttle | 10/day | 50/day |
| Total agents per author (lifetime, all tiers) | 10 | 100 |

Throttling returns a `RATE_LIMITED` error from the submission API
with a `retry_after` header. Abusive developers (≥ 50 failed
submissions in a week) are flagged for manual review.

### 6.2 Takedown SLA

A reported abuse triggers:

| Severity | Trigger | Action SLA |
|---|---|---|
| Critical | Active credential exfil, malware, financial-fraud capability | Yank + kill within 1 hour |
| High | Privacy violation, data leak, deceptive UX | Yank within 24 h |
| Medium | Misleading capability description, minor scope over-ask | Notice to author, 7-day fix-or-yank |
| Low | Quality issue, broken capability | Notice to author, 30-day window |

The kill-switch (ADR-014 invariant 2.7) is the immediate response;
yank + permanent removal follows.

### 6.3 Anti-typosquatting

The agent_id namespace enforces:

- Levenshtein distance ≥ 3 from any official agent_id.
- Levenshtein distance ≥ 2 from any verified agent_id.
- Punycode/homoglyph attacks rejected at submission time.
- Reserved prefixes: `lumo-*`, `official-*`, `verified-*` are
  reserved. Submissions using them are rejected.

### 6.4 Banned author list

`banned_authors` table holds emails and legal-entity identifiers of
authors barred from the platform. A submission from a banned author
returns `AUTHOR_BANNED` and writes a security-alert row.

### 6.5 Appeals process

A yanked author can appeal via `support@lumo.rentals`. Appeals are
reviewed by Lumo security within 10 business days. Reinstatement
clears the ban; the author may resubmit. Appeals data is kept for
2 years.

---

## 7. Marketplace UX (v1 spec, full UI in MARKETPLACE-1)

The marketplace surface lives at Workspace → Marketplace. v1 must
ship:

### 7.1 Browse

- **Categories** down the left rail: Productivity, Finance, Travel,
  Communication, Lumo Rentals, Other. Hardcoded in v1; user-defined
  categories are Phase 5.
- **Search** at top. Searches across `name`, `description`,
  `capabilities[].description`, `author.name`. Powered by
  `lumo_recall_unified` (Phase 3 MMRAG-1) where available, falling
  back to ILIKE on `marketplace_agents.manifest`.
- **Filter chips**: trust tier (4 options), category, "free /
  paid" (paid hidden in v1), "installed / not installed".
- **Tile rendering**: name, author, trust badge, one-line
  description, install button (or "installed" state), rating (post
  MVP), install count.

### 7.2 Detail page

- Full description.
- Trust badge with link to "What does this badge mean?"
- Capabilities list with consent text (preview of what the user
  will see on install).
- Required scopes summarised.
- Cost-model summary.
- Author info, homepage, support, privacy.
- Reviews + ratings (post-MVP; UI placeholder in v1).
- Install button.

### 7.3 Install flow

The detail page → Install → Consent screen (ADR-014 §5.1) →
"Configure" screen (caps, qualifiers) → Done.

Total flow: ≤ 4 taps from marketplace tile to installed.

### 7.4 Settings panel (per-agent)

Workspace → Settings → Agents → [Agent]:

- Enable/disable per-scope toggles.
- Cost-month-to-date and budget remaining (ADR-016).
- 30-day audit summary; link to full export.
- Version selector (§5.3).
- Revoke / uninstall.

### 7.5 Trending and curation

- "Lumo's picks" row at the top of the marketplace, hand-curated
  by the Lumo team. v1: 5 agents.
- "Trending this week" — top 10 by install velocity over the last 7
  days, computed nightly.
- "Recently published" — newest 10 in the user's selected categories.

### 7.6 Ratings and reviews (post-MVP, schema lands now)

```sql
create table public.agent_ratings (
  user_id     uuid not null references public.profiles(id) on delete cascade,
  agent_id    text not null,
  rating      smallint not null check (rating between 1 and 5),
  review_text text,
  created_at  timestamptz not null default now(),
  primary key (user_id, agent_id)
);
```

UI surface lands in Phase 4.5; schema lands in MARKETPLACE-1 so we
don't migrate the table later.

---

## 8. Revenue model placeholder (Phase 5 commerce)

Phase 4 is free. The data model carries Phase 5 commerce fields so we
do not migrate the marketplace at commerce launch:

| Field | Phase 4 | Phase 5 |
|---|---|---|
| `price_usd` | Always 0 | Set by author |
| `billing_period` | Always `one_time` | `one_time`, `monthly`, `annual`, `metered` |
| `revenue_split_pct` | Always 0 | Per-deal: typically 70/30 author/Lumo |

Phase 5 also adds:

- Stripe Connect integration for builder payouts.
- A `purchase_history` table.
- A subscription state machine for `monthly` / `annual` agents.

ADR-015 does NOT design these. It commits to the data shape so v1
ships without commerce-blocking schema choices.

---

## 9. Acceptance criteria for MARKETPLACE-1 and TRUST-1

### 9.1 MARKETPLACE-1

1. Marketplace surface live at Workspace → Marketplace.
2. Browse, search, filter, install, uninstall flows live.
3. Three reference agents (ADR-013 §11) discoverable on the
   marketplace.
4. Anti-typosquatting CI test: a submission with agent_id =
   `summarize-email-daily` (typo of the reference) is rejected.
5. Yank propagation test: yanking a version triggers fallback for
   pinned users within 1 h.
6. Settings panel live with per-scope toggles, cost view, and
   audit summary.

### 9.2 TRUST-1

1. Submission CLI (`lumo-agent submit`) live and reaches the review
   queue.
2. Automated checks pipeline runs on every submission and writes
   `agent_review_pipeline_runs` rows.
3. Human review tooling at `/admin/marketplace/review-queue` lets
   a Lumo-side reviewer approve, reject, or request changes; signs
   off in `agent_security_reviews`.
4. SLA dashboard shows review queue depth, median review time, and
   tier promotion velocity.
5. Takedown action live; killing an agent flips the kill-switch
   within 60 s of click.

---

## 10. Consequences

### 10.1 Positive

- The four-tier model gives users a real signal. The
  `experimental` warning is the kindest thing we do — it tells the
  user "this is sketchy by default, install with care."
- The submission CLI is the developer's first impression. A clean
  CLI plus a fast automated-check loop is the difference between
  "I built an agent in a day" and "I gave up at the manifest."
- Object-locked bundles plus signed manifests give the platform a
  defensible immutability story.
- Phase-5 commerce is data-modelled now, so we won't migrate.

### 10.2 Negative

- Human review is a bottleneck for `verified` tier. The 5-business-day
  SLA is honest but slow; we lose authors to the friction.
  Mitigation: keep the bar realistic, automate everything we can.
- Anti-typosquatting rejects legitimate names whose Levenshtein
  distance is too small. Mitigation: appeals process, namespace
  reservation.
- Marketplace UX in v1 is intentionally narrow — no recommendations,
  no personal-bandit ranking, no per-user landing page. Phase 4
  hooks BANDIT-1's `lumo_personalize_rank` into trending; full
  personal landing is Phase 5.

### 10.3 Trade-offs accepted

- 5-day human review for verified is the right number — long enough
  to be real, short enough to not lose serious authors. We accept
  the engineering cost of staffing the queue.
- Bundle storage on Supabase keeps cost low ($0.021/GB/month at
  current pricing); we accept the vendor concentration.

---

## 11. Alternatives considered

### Option (A) — Two tiers (official, third-party)
Pro: simple. Con: collapses three real distinctions (audited
third-party, automated-only third-party, experimental) into one
"third-party" bucket. The user gets no signal. Rejected.

### Option (B) — Continuous trust score (no tiers)
Pro: nuanced. Con: untrustworthy in practice — a single number is
gameable, hard to explain, and gives the user no actionable
mental model. Rejected.

### Option (C) — Four tiers + review SLAs (CHOSEN)
Pro: honest signal, defensible UX, real review work. Con: review
queue is a bottleneck. Mitigated.

### Option (D) — GitHub-like open registry, no review
Pro: zero operational cost. Con: the platform's reputation is the
worst agent that ships. Rejected on first principles.

---

## 12. Open questions

1. **Should `verified` tier have a paid floor?** A token submission
   fee ($25-50) would discourage spam without locking out hobbyists.
   **Recommended:** free in v1; revisit if we see > 10 spam
   submissions/week.
2. **Per-tenant private marketplaces.** An enterprise customer wants
   to publish internal-only agents. **Recommended:** Phase 5+;
   data-model now via `marketplace_agents.tenant_scope` (default
   `'public'`).
3. **Agent permissions auto-update on connector schema change.** If
   a connector adds a new scope option, do existing agents
   auto-pick-up? **Recommended:** no — connector schema bumps are
   like SDK major bumps, the agent must explicitly adopt.

---

## 13. Decision log

| Date | Decision |
|---|---|
| 2026-04-27 | ADR-015 drafted; four-tier trust model sealed. |
| 2026-04-27 | Bundle storage on Supabase `agent-bundles` with object-lock. |
| 2026-04-27 | Human review SLA: 5 business days for verified, same-day for community. |
| 2026-04-27 | Patch updates auto-install; minor/major require re-consent. |
| 2026-04-27 | Phase-5 commerce fields land in v1 schema (price, billing, split). |
| 2026-04-27 | Anti-typosquatting: Levenshtein ≥ 3 from official, ≥ 2 from verified. |
