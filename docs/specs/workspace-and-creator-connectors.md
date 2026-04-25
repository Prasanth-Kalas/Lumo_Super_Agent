# PRD — Lumo Workspace + Creator Connectors

**Status:** Draft v1.0 — pending review
**Owner:** Kalas (CEO/CTO/CFO/PM hat)
**Inspired by:** Vaibhav Sisinty's "Content OS" demo (Codex-built, 9-hour overnight build of a unified Mac app for a 5M-follower creator)
**Decision date locked:** 2026-04-25

---

## 1. Why we're building this

### The strategic gap
Lumo Super Agent today is **chat-first**. Connectors are real (Google, Microsoft, Spotify), the orchestrator is real, memory + intents + autonomy are real — but the only surface a user sees is a chat thread. When someone asks "show me what Lumo does" we open a conversation, type a prompt, wait for a response. That's a great *capability* demo and a poor *product* demo.

The market has shifted. Buyers — both executive and creator — are asking for a **dashboard surface**: one screen that proves the connectors exist by showing live data from them. Vaibhav Sisinty's Content OS video is the latest and clearest articulation of this pattern (5-tab Mac app, his real metrics, no code, end-to-end auth solved by an agent). The pattern reduces "AI assistant" from an abstract claim to a screenshot.

### What we're shipping
Two things, tightly coupled:

1. **`/workspace`** — a unified dashboard route that pulls from every connector the user has authorized. Productivity (Gmail, Calendar, Outlook, Spotify) AND social (YouTube → Newsletter → Meta → LinkedIn → X, in that order). One screen, dense cards, real numbers, chat strip across the bottom.

2. **Creator/social connector pack** — five new connectors (YouTube, Beehiiv/Mailchimp, Instagram, Facebook, LinkedIn) shipped via the same OAuth + `agent_connections` plumbing that already runs Google/Microsoft/Spotify. X (Twitter) is deferred to v2 due to API pricing.

The connector framework stays the same. The dashboard is the new surface. Both are needed: dashboard without new connectors is thin (executives only see Gmail + Calendar); connectors without dashboard means the new APIs only show value through chat — which is exactly what we're trying to escape.

### Strategic positioning
This is **not** a pivot to creator tooling. Lumo's North Star stays: personal AI assistant for professionals. The creator stack is the *first vertical* of a reusable pattern — same dashboard model will absorb e-commerce (Shopify/Stripe/Amazon), fitness (Whoop/Strava/Apple Health), and finance (Plaid/QuickBooks) verticals over the next year. We're investing in a surface, not a segment.

---

## 2. Target users

| Persona | Why they buy | Primary value from V1 |
|---|---|---|
| **Solo creator** (10K–10M followers) | They check 4–7 apps daily for analytics + comments + DMs. Switching cost is real. | Unified `/workspace` Today + Inbox tabs, comment triage, "what to make next" co-pilot |
| **Founder/exec who posts** | They use LinkedIn + X + Substack + Calendar + Gmail. Same switching cost, more time-poor. | Same dashboard but emphasis on calendar + email side; social as second-class but visible |
| **Agency operator** | They manage social for clients. Multi-account is a future ask, not V1. | V1 only their own accounts. V2 adds multi-account. |
| **Existing Lumo executive user** | Already on Gmail/Calendar/Spotify. Adding social is bonus. | `/workspace` becomes their default view; no behavior change required |

**Not in scope:** brand teams, large media orgs, regulated industries (we'll add SSO + audit + brand-safety later).

---

## 3. Goals & non-goals

### Goals (V1 ship)
1. **Demo metric:** A signed-in user can land on `/workspace` and see real data from at least 3 connected platforms within 2 seconds of page focus.
2. **Activation metric:** ≥60% of new sign-ups connect at least one social platform within their first session.
3. **Retention metric:** Users who connect ≥2 platforms have 30-day retention ≥2× users with only chat.
4. **Trust metric:** Zero unauthorized posts shipped to user accounts. 100% of publish actions go through the confirmation card.
5. **Reusability:** Adding a 6th platform (e.g., TikTok in v1.2) takes ≤1 week of engineering, not a rebuild.

### Non-goals (explicit)
- No multi-tenant / agency / brand management in V1.
- No paid-ads APIs (Meta Ads, LinkedIn Campaign Manager) in V1.
- No content scheduling for "best time to post" optimization in V1 — just user-specified time.
- No AI-generated original posts in V1 — only drafts of *replies* and *repurposes*. (V1.1 expands.)
- No CSV import/export in V1.
- No team / shared dashboards.

---

## 4. Locked scope (from spec discussion)

| Decision | Choice |
|---|---|
| V1 platforms (in shipping order) | YouTube → Beehiiv/Mailchimp (newsletter) → Instagram → Facebook → LinkedIn |
| Deferred | X (Twitter) — API cost prohibitive in V1; framework supports drop-in later |
| Capability scope | Read + reply + publish/schedule (full creator workflow) |
| Surface | Net-new `/workspace` route as unified dashboard. `/marketplace` stays for connecting more apps. |
| Onboarding | Per-tile in `/marketplace` (existing pattern). Reuses our OAuth + `agent_connections` plumbing. |
| Approval timeline | Phased — YouTube ships first (~10 days), Meta + LinkedIn behind "Coming soon — in review" pills until platform approval lands |
| Publish autonomy | Always show confirmation card before any post / reply / DM goes live, regardless of user's autonomy tier |
| Newsletter (Beehiiv/Mailchimp/Substack) | v1.1, immediately after YouTube |

---

## 5. Phased rollout plan

### V1.0 — YouTube + `/workspace` shell (target: 10 working days)
- New `/workspace` route with 5-tab structure (Today / Content / Inbox / Co-pilot / Operations)
- YouTube connector end-to-end: OAuth, Data API, Analytics API, comment fetch, draft-reply-publish gated
- All tabs render with YouTube data + existing Google/Microsoft/Spotify data
- Other 4 social tiles in `/marketplace` show "Coming soon — in review" pill
- Connector-archive layer (caches raw API payloads; degrades gracefully when tokens expire)
- Operations tab shows live connector health (token state, last sync, cache hit rate)

### V1.1 — Newsletter (target: +5 days after V1.0)
- Beehiiv connector (API key auth, simpler than OAuth)
- Mailchimp connector (OAuth)
- Substack: RSS-only fallback (no public API)
- Newsletter widget on `/workspace`: subscriber count, open rate, top issues, recent comments

### V1.2 — Instagram (target: post-Meta-approval; ETA 2–4 weeks elapsed)
- Submit Meta app for review immediately (parallel to V1.0/V1.1 build)
- Required scopes: `instagram_basic`, `instagram_manage_comments`, `instagram_content_publish`, `pages_show_list`, `pages_read_engagement`
- IG Business/Creator account required (we'll handle the FB-page-link UX gracefully)

### V1.3 — Facebook (concurrent with V1.2; same Meta app)
- Page insights, post engagement, comment management, publish/schedule
- Same `pages_*` scopes from the V1.2 Meta submission

### V1.4 — LinkedIn (target: post-LinkedIn-MDP-approval; ETA 4–8 weeks elapsed)
- Apply to LinkedIn Marketing Developer Platform Day 1 (parallel to everything else)
- Personal post creation works without MDP; analytics requires MDP approval
- Ship personal post + comment-reply first, layer analytics in when approval clears

### V1.5 — Marketing API + Lead Ads (target: 4–6 weeks of focused eng)

Bundles three Meta use cases that are already bound to the app:
- **Create & manage ads with Marketing API** — campaign + ad set + creative management
- **Measure ad performance data with Marketing API** — ROAS, attribution, custom audiences
- **Capture & manage ad leads with Marketing API** — Lead Ads inbox into the Inbox tab

What ships:
- New `/workspace` "Ads" sub-tab on Today (or a 6th top-level tab, TBD) with campaign overview + budget gauge
- `lib/integrations/meta-ads.ts` — campaign CRUD, ad set CRUD, creative upload via `/api/media/upload`
- Server-side **spend caps** enforced before any budget-bump call (per-day + per-week + per-account)
- Confirmation card extended with monetary delta — every campaign budget change shows old + new + impact
- Audit log gets a `monetary_delta_usd` field
- Lead Ads webhook handler routing new leads into Inbox tab

Compliance:
- Marketing API requires **Standard Access** then **Advanced Access** review tiers (extra App Review pass with case-study submission)
- ToS update: "Lumo manages your Meta ad spend on your behalf"
- Possibly required: jurisdiction-specific financial-services disclosure

### V2 — Threads + oEmbed
- **Access the Threads API** — adds Threads card to Today tab + Threads platform to PostConfirmationCard
- **Embed Facebook, Instagram, Threads content** (oEmbed) — read-only API for embedding curated content on partner sites (lumotechnologies.com case studies)

### V2 — X (deferred on pricing)
- Connector slot reserved in registry. Drop-in when budget approves $200–$5K/mo X API tier.

### V3 — WhatsApp Business Platform
- **Connect with customers through WhatsApp** — adds a "WhatsApp" surface to the Inbox tab for users with WhatsApp Business accounts
- WhatsApp has its own approval (Cloud API tier free for first 1K conversations/mo, paid afterward) and template-message gate (outbound templates pre-approved by Meta)
- Make this last in the creator pack — by V3 we should have learned enough about Meta App Review to nail it first try

---

## 6. Surface design — `/workspace`

### Layout (desktop ≥1280px)
```
┌─────────────────────────────────────────────────────────────────────┐
│  [Lumo logo]   Today  Content  Inbox  Co-pilot  Operations    👤    │ ← top nav
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐             │
│  │  card    │  │  card    │  │  card    │  │  card    │             │
│  └──────────┘  └──────────┘  └──────────┘  └──────────┘             │
│                                                                     │
│  ┌─────────────────────────────────┐  ┌────────────────────────┐    │
│  │  larger panel                   │  │  side panel            │    │
│  │                                 │  │                        │    │
│  └─────────────────────────────────┘  └────────────────────────┘    │
│                                                                     │
├─────────────────────────────────────────────────────────────────────┤
│  💬  Ask Lumo anything…                                       🎙️    │ ← chat strip
└─────────────────────────────────────────────────────────────────────┘
```

### Mobile (≤768px)
Single column, tabs become a horizontal scroller, chat strip docks to bottom safe-area, voice mode floats.

### Tab specs

#### Tab 1 — **Today**
*Purpose: "what do I need to know in the next 4 hours?"*

Cards:
- **Calendar next-3** — title, time, attendees count, click → opens conflict resolver if conflicts
- **Inbox top-3** — most-important unread emails (Gmail + Outlook merged), AI-scored
- **Notifications** — what changed since last visit (digest, not raw stream)
- **Now playing** — Spotify track, controls (only renders if Spotify connected)
- **Today's posts** — scheduled or recently-published posts across YouTube + IG + FB + LI + newsletter
- **Ambient context** — local time + weather + day-of-week framing

Empty states for unconnected platforms link to the relevant `/marketplace` tile.

#### Tab 2 — **Content**
*Purpose: "what's working, what to repurpose, what to stop making."*

Cards:
- **Outliers Live** — posts ranked by × multiplier over the user's median reach. Per-platform filter.
- **Cross-platform winners** — content themes that performed top-quartile on ≥2 platforms in last 30d
- **Repurpose queue** — specific suggestions: "This LinkedIn post got 5× engagement → make a YouTube short with this hook" (uses Claude to generate suggestion)
- **Content calendar** — drag/drop scheduled posts, color-coded by platform
- **Hashtag/topic trends** — what your audience is engaging with most

#### Tab 3 — **Inbox**
*Purpose: "respond to the right people, ignore the noise."*

Cards:
- **Relationship Index** — top mentioners / commenters / DM senders, sorted by inferred importance
- **Business leads** — auto-flagged (heuristic + LLM scoring): partnership requests, hiring inquiries, podcast asks, consulting calls. Pulled across YouTube comments + IG DMs + LI messages + email.
- **Super-fans** — frequent positive engagers; surfaced for "thank them" actions
- **Comments stream** — unified across YouTube + IG + FB, filterable by platform/sentiment/recency
- **Reply drafts** — draft responses generated by Lumo, awaiting confirm-card approval

#### Tab 4 — **Co-pilot**
*Purpose: "ask the agent anything about your data."*

This is the existing Super Agent chat orchestrator, but framed inside `/workspace` and pre-loaded with social/content context. Same memory layer, same intents, same tools. Plus a few `/workspace`-specific tool surfaces:
- `analytics_query` — "Which YouTube videos performed best in the last 90 days for the topic 'AI agents'?"
- `audience_segment` — "Who are my top 20 commenters across YouTube and IG?"
- `repurpose_suggest` — "What's my best LinkedIn post that hasn't been turned into a YouTube short?"
- `draft_reply` — "Draft a reply to this DM" (returns draft → confirm card)
- `schedule_post` — "Schedule this for tomorrow 9am IST on LinkedIn" (returns post preview → confirm card)

#### Tab 5 — **Operations**
*Purpose: "is everything working?" — and graceful degradation when not.*

Cards:
- **Connector status grid** — one row per connected platform: state (Live / Cached / Error / Re-auth needed), last successful sync, cache age, retries today
- **Token health** — expiration countdown per token, refresh rate, "Re-auth now" CTA when expiring soon
- **API budget** — per-platform call counts vs daily quota (esp. YouTube Analytics: 10K queries/day default)
- **Cache archive size** — total raw payloads stored, link to per-platform breakdown
- **Audit log** — every publish/reply/schedule action with timestamp, channel, content hash, user-confirm timestamp
- **Cron + ops-cron-runs** — reuses existing observability surface

This tab is the answer to "what happens when Meta rejects my IG token at 2am?" — user lands on `/workspace`, dashboard still renders with the cache-age pill, Operations tab tells them why and offers "Re-auth Instagram" CTA.

---

## 7. Connector framework — what changes

### New connectors to add

| Platform | Auth | Key APIs | Notes |
|---|---|---|---|
| YouTube | Existing Google OAuth + new scopes | YouTube Data API v3 (channel/video/comment), YouTube Analytics API v2 (reports) | Add scopes: `youtube.readonly`, `youtube.force-ssl` (for comment write), `yt-analytics.readonly`, `yt-analytics-monetary.readonly` |
| Beehiiv | API key (publication-scoped) | Beehiiv API v2 | Simpler than OAuth; user pastes key |
| Mailchimp | OAuth 2.0 | Marketing API v3 | Standard OAuth flow |
| Substack | RSS only (no public API) | Public RSS feed per publication | Read-only; no publish |
| Instagram | Meta OAuth (Facebook Login for Business) | Instagram Graph API + Pages API | Requires IG Business/Creator + linked FB Page |
| Facebook | Same Meta OAuth as IG | Pages API + Graph API | Same app review covers both |
| LinkedIn | LinkedIn OAuth 2.0 (3-legged) | Sign In with LinkedIn (basic), Marketing API (analytics, MDP-gated) | Personal post via `w_member_social`; analytics needs MDP partner approval |
| X (deferred) | OAuth 2.0 PKCE | X API v2 | Skipped V1; framework reserves the slot |

### Connector framework changes
1. **Scope-additive consent** — current model fully revokes + reconnects on scope change. Need to support adding scopes to an existing connection without re-auth UX feeling like "starting over."
2. **Connector-archive layer** — new `connector_responses_archive` table:
   ```
   id (uuid pk)
   user_id (fk users)
   platform (text)
   endpoint (text)
   request_hash (text)  -- canonical hash of the request
   response_body (jsonb)
   fetched_at (timestamp)
   ttl_seconds (int)    -- per-endpoint cache life
   ```
   Read path: hit cache first if within TTL; on miss or staleness, fetch live + write back. On API error, serve stale cache + flag in Operations tab.
3. **Multi-account-per-platform support** — a user might have 3 YouTube channels. `agent_connections` already keyed on `(user_id, platform)`; bump to `(user_id, platform, external_account_id)`.
4. **Publish queue** — new table `scheduled_posts`:
   ```
   id, user_id, platform, draft_body (jsonb), media_refs (jsonb),
   scheduled_for (timestamp), status (draft|queued|posted|failed),
   confirmation_card_shown_at, confirmed_by_user_at, posted_at, error_text
   ```
   Cron worker (`/api/cron/publish-due-posts`, every 1 minute) reads `status=queued AND scheduled_for<=now()`, calls platform API, updates status.
5. **Media handling** — `media_refs` points to objects in Supabase Storage. New `/api/media/upload` endpoint with signed URLs. Cap: 100 MB per asset V1.

---

## 8. Autonomy model for write actions

All publish / reply / DM / schedule actions enforce:

```
User triggers action (chat, dashboard button, or cron firing a scheduled post)
   ↓
System builds draft (body, target platform, target account, scheduled time)
   ↓
Confirmation card shown to user:
   ┌─────────────────────────────────────┐
   │  ✏️  Reply to @username on Instagram │
   │  ───────────────────────────────────│
   │  "Thanks for the kind words!        │
   │   Working on a follow-up post on    │
   │   exactly this — stay tuned 👋"     │
   │  ───────────────────────────────────│
   │  Posting from: @lumo_official       │
   │  Scheduled: Now                     │
   │  ───────────────────────────────────│
   │  [Edit]  [Cancel]   [Post now ✓]   │
   └─────────────────────────────────────┘
   ↓
On approve → record in audit log → call platform API → record outcome
On reject → drop draft, record in audit log
```

**Mandatory in V1, regardless of user autonomy tier.** No user-configurable bypass. Audit log is queryable from Operations tab.

When a *cron-fired* scheduled post comes due, we don't bypass the card — we send the user a notification + push the draft to a `pending_user_action` queue. They tap → see the card → confirm or cancel. If un-confirmed for 30 minutes after scheduled time, we mark `status=expired` and surface in Inbox.

---

## 9. Co-pilot tool surface (chat orchestrator additions)

New tools the orchestrator calls when the user is on `/workspace` or asks social/content questions in chat:

| Tool name | Inputs | Output |
|---|---|---|
| `youtube_channel_overview` | channel_id (defaults to user's primary) | last-30d views, subs, top videos, comment volume |
| `youtube_video_analytics` | video_id | views, watch time, retention curve, traffic sources |
| `youtube_comments_list` | video_id, limit | recent comments with author handle, sentiment, like count |
| `youtube_reply_draft` | comment_id, prompt | draft reply (returns to confirm card) |
| `instagram_account_overview` | account_id | followers, reach, profile views, top posts |
| `instagram_media_insights` | media_id | likes, comments, saves, shares, reach |
| `instagram_dm_inbox` | filter (unread/business-leads/all) | DM list with priority scoring |
| `facebook_page_overview` | page_id | similar shape to IG |
| `linkedin_profile_overview` | profile_id (defaults to me) | followers, post views, top posts last 30d |
| `linkedin_post_create` | body, media_refs?, scheduled_for? | confirm card → post |
| `newsletter_overview` | publication_id | subscribers, recent send open rate, top issues |
| `cross_platform_outliers` | window_days, multiplier_threshold | list of posts beating user's median by X× |
| `repurpose_suggest` | source_post_id, target_platform | LLM-suggested adaptation (returns draft) |
| `schedule_post` | platform, body, scheduled_for, media_refs? | writes to `scheduled_posts`, returns confirm card |

Each tool's `x-lumo-autonomy` annotation is set explicitly: read-only tools → `auto`, write tools → `confirm`, cross-account tools → `confirm`.

---

## 10. Operations & cost model

### Refresh cadence
- **On-focus refresh:** when `/workspace` mounts, hit cache; if cache age >5 min, kick async refresh in background
- **Background sync cron** (`/api/cron/sync-workspace`, every 15 min): refresh primary metrics for all active users (active = signed-in within last 7 days)
- **Heavy queries** (analytics reports): on-demand only, never cron

### Rate limits to design around
- YouTube Data API: 10K units/day default (can request increase). Each video list = 1 unit, each comment list = 1 unit, each video detail = 1 unit. → comfortable for ~500 active users at default quota.
- YouTube Analytics: 10K queries/day default. → bigger constraint; use cache aggressively.
- Meta Graph: rate limits per app-user pair. Standard tier covers small cohort; need to apply for higher tier post-100 users.
- LinkedIn: 100 requests/day per scope on free tier; MDP tier raises significantly.
- Mailchimp: 10/sec per API key, no daily cap.
- Beehiiv: 100/min per publication.

### Cost summary (V1 monthly, single-user demo cohort)
| Line item | Cost |
|---|---|
| YouTube API | $0 (free tier) |
| Meta Graph API | $0 (free tier) |
| LinkedIn API | $0 (free tier; MDP free if approved) |
| Beehiiv API | $0 (free with publication subscription) |
| Mailchimp API | $0 (free) |
| Substack (RSS) | $0 |
| Anthropic + OpenAI for new co-pilot tools | +~$0.10 / user / day at moderate use |
| Supabase storage (media refs, archive) | +~$5/mo for 50 users |
| Vercel cron / serverless | absorbed in existing tier |
| **Total marginal monthly cost** | **<$30/mo for first 50 users** |

Add X v2 if/when we activate: +$200/mo (Basic) or +$5K/mo (Pro).

### Reliability — what happens when an API is down
1. Read-side: serve from cache; show "Cached 12 min ago" pill on the affected card.
2. Token-revoked: card shows "Re-authorize Instagram" CTA inline; rest of dashboard unaffected.
3. Publish failure: confirmation card already approved → publish job marked `failed`, user sees toast notification + entry in Inbox queue with retry CTA.
4. We never auto-retry a failed publish without explicit user action.

---

## 11. Approval / legal track (parallel to engineering)

Day 1 (start of V1.0 sprint):
- Submit Meta app for review with the V1.2/V1.3 scope list (covers IG + FB)
- Apply to LinkedIn Marketing Developer Platform
- Update privacy policy + terms-of-use to cover social data handling
- Add platform-specific privacy disclosures to each `/marketplace` tile (Meta requires explicit display of data use)

These run in parallel with V1.0/V1.1 engineering. By the time YouTube + Newsletter are live, IG/FB approval should be lined up to enable V1.2/V1.3 immediately or within a week.

---

## 12. Dependencies & risks

### Hard dependencies
- Existing OAuth + `agent_connections` plumbing (already shipped)
- Autonomy framework with confirmation card pattern (already shipped)
- Memory + intents (already shipped)
- Vercel cron (Pro tier — already on)
- Supabase storage (already on)

### Risks ranked
1. **Meta app review delay** — could push V1.2/V1.3 by 4–8 weeks. *Mitigation:* phased launch with "Coming soon" pills means dashboard ships value with YouTube alone.
2. **LinkedIn MDP approval rejection** — MDP is selective. *Mitigation:* personal post creation works without MDP; we ship the limited feature set, layer analytics in when approval clears (or never, gracefully).
3. **YouTube Analytics quota** — 10K queries/day caps us at ~500 active daily users. *Mitigation:* aggressive cache, request quota increase when we cross 200 users.
4. **Trust incident** — an LLM-drafted reply gets posted off-brand. *Mitigation:* mandatory confirmation card. Audit log. We can show a user every draft that was approved + posted.
5. **Substack offers no API** — only RSS. *Mitigation:* read-only via RSS in V1.1; no publish flow promised.
6. **Multi-account confusion** — user has 3 YouTube channels and isn't sure which one we're acting on. *Mitigation:* always-visible channel selector in `/workspace` header.
7. **API token churn** — Meta tokens expire frequently if user changes FB password. *Mitigation:* clear "Re-auth needed" UX in Operations + non-blocking rest of dashboard.

### Resolved questions (locked 2026-04-25)
- **Q1 — IG Personal→Business:** Detect, show inline conversion guide with link to Meta docs. Never hard-block.
- **Q2 — Multi-account / agency:** V2. V1 supports multiple channels per platform for ONE user (e.g., 3 YouTube channels). True multi-tenant comes later.
- **Q3 — Scheduled-post timezone:** User-local from profile. Confirmation card shows both user-local and platform-side time.
- **Q4 — Co-pilot reasoning:** Recommendation primary; "Why?" collapsible disclosure default-closed.
- **Q5 — Publish failure detail:** Platform's exact error message verbatim + Lumo-context one-liner suggesting next step.

---

## 13. Success criteria & launch gates

### Pre-V1.0 ship gates
- [ ] `/workspace` route renders without errors for users with 0 connectors
- [ ] YouTube connector e2e: connect → fetch → display → reply (confirm) → publish → verify on YouTube
- [ ] Connector archive degrades gracefully when YouTube API returns 5xx or 401
- [ ] Confirmation card appears for every write action; no path to bypass
- [ ] Operations tab accurately reflects YouTube connection state
- [ ] Mobile layout renders on iPhone SE (smallest target)
- [ ] Voice mode works on `/workspace` (chat strip activates voice)
- [ ] Audit log persists and is queryable

### V1.0 launch metrics (week 1)
- ≥30% of new sign-ups visit `/workspace` within first session
- ≥40% of users with Google connected also connect YouTube within first week
- 0 unauthorized publish actions in audit log
- p50 dashboard load time <1.5s for users with 3 connectors

### V1.1 (Newsletter) launch metrics (week 2)
- ≥20% of YouTube-connected users add a newsletter connector within first week of v1.1

### V1.2/V1.3 (Meta) launch
- ≥50% of dashboard users connect IG or FB within first week post-Meta-approval
- Net new sign-ups attributable to Meta connector via UTM-tagged announce post

### V1.4 (LinkedIn) launch
- ≥40% of executive-persona users connect LinkedIn within first week

---

## 14. What we're NOT designing (future watchlist)

- TikTok connector (V2 candidate)
- Threads (V2 candidate; Meta scope likely covers it)
- Reddit, Discord, Telegram (V2.5)
- Brand kit + style enforcement on AI drafts (V2)
- Multi-account / agency view (V2)
- Paid ads APIs (V2)
- Video editing / clip generation (long-term; would need Remotion-style scaffolding)
- "Best time to post" optimization (V2 with enough data)
- Audience CSV export (V2.5)

---

## 15. Decision log

| Date | Decision | Rationale |
|---|---|---|
| 2026-04-25 | Build dashboard surface, not just chat | Vaibhav's Content OS validates pattern; demo-to-close needs visual surface |
| 2026-04-25 | YouTube ships first | Easiest path; reuses existing Google OAuth |
| 2026-04-25 | Skip X in V1 | API pricing not justified by V1 user base |
| 2026-04-25 | Mandatory confirmation card on all writes | Trust > speed in V1; can relax later if data supports |
| 2026-04-25 | `/workspace` separate route, not new home | Lower regression risk for existing users; can promote to home in V2 if metrics warrant |
| 2026-04-25 | Per-tile marketplace onboarding | Reuses existing pattern; zero new UX to teach |
| 2026-04-25 | Bind ALL Meta use cases up front | Adding later = 4–6 week amendment delay. Bind everything (Marketing API ×3, Threads, WhatsApp, oEmbed, Live Video, Messenger), Add scopes only when each version ships. |
| 2026-04-25 | V1.5 ads management is a real product investment | 4–6 weeks dedicated eng + monetary audit log + spend caps + Advanced Access App Review tier. ToS update mandatory. |
| 2026-04-25 | Co-pilot tab V1 = preset prompts + handoff to / chat | Embedded chat would duplicate the orchestrator UI; preset prompts ship value immediately and the embedded chat slots in V1.x once we extract a clean Composer component. |
| 2026-04-25 | Inbox lead-scoring is heuristic V1, LLM later | Keyword regex + length signal is good enough for first cut; LLM scoring is a future task once we have signal on false-positive rate. |

---

## 16. Engineering breakdown (pre-task-list view)

When we move from PRD-approved to building, this becomes 18-22 distinct eng tasks. Sketch:

**V1.0 (YouTube + `/workspace` shell):**
1. DB migration: `connector_responses_archive`, `scheduled_posts`, `audit_log_writes` tables
2. `lib/connector-archive.ts` cache layer
3. YouTube OAuth scope additions + reconnect flow
4. YouTube Data API client (channels, videos, comments, replies)
5. YouTube Analytics API client (reports)
6. New marketplace tile + privacy disclosure for YouTube
7. `/workspace` route scaffold (5 tabs, mobile + desktop)
8. Tab 1 — Today widgets (each existing connector + YouTube)
9. Tab 2 — Content widgets (cross-platform outliers, repurpose queue)
10. Tab 3 — Inbox widgets (unified comments + lead detection)
11. Tab 4 — Co-pilot integration (orchestrator + new tools)
12. Tab 5 — Operations (status grid, audit log, retry CTAs)
13. Confirmation card component (reuse autonomy pattern, themed for posts)
14. Publish queue cron (`/api/cron/publish-due-posts`)
15. Media upload pipeline (`/api/media/upload` + Supabase Storage)
16. New orchestrator tools registered + tested
17. Multi-channel selector in `/workspace` header
18. Voice mode integration on `/workspace`
19. Smoke test + ship gate verification
20. Marketplace "Coming soon" tiles for IG/FB/LI/Newsletter

**V1.1 (Newsletter):**
21. Beehiiv connector + tile
22. Mailchimp OAuth + tile
23. Substack RSS reader (read-only)
24. Newsletter widget on Tab 1 + Tab 2

**V1.2/V1.3 (Meta — gated by approval):**
25. Meta app review submission (start Day 1, parallel to V1.0 engineering)
26. Instagram connector
27. Facebook connector
28. IG/FB widgets across tabs

**V1.4 (LinkedIn — gated by approval):**
29. LinkedIn MDP application (start Day 1)
30. LinkedIn connector + personal post flow
31. LinkedIn analytics integration (when MDP clears)
32. LinkedIn widgets across tabs

---

## 17. Sign-off

This PRD is ready for review. Once approved, I'll:
1. Create eng tasks 1–32 in the task system with dependencies wired
2. Submit Meta + LinkedIn approval applications same day
3. Start implementation on Task 1 (DB migration) immediately
4. Ship V1.0 in ~10 working days

**Reviewer:** Kalas
**Pending approvals before code:** PRD acceptance + answer to Q1–Q5 in §12
