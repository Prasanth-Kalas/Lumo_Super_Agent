# Meta App Creation + Review Playbook

**Purpose:** Make every Meta app submission (now and in the future) repeatable. Captures the actual options Meta presents at each step, the right picks for Lumo, and the scope-by-scope review requirements.

**Last verified:** 2026-04-25 against `developers.facebook.com/apps/creation/`

---

## TL;DR — what Lumo picks, every time

For the **Lumo Super Agent** app (covers IG + FB + Ads management + DMs for the `/workspace` creator-and-advertiser pack):

| Step | Pick |
|---|---|
| 1. App details — name | `Lumo Super Agent` |
| 1. App details — contact | `prasanth.kalas@lumo.rentals` |
| 2. Use cases — V1.2 | **Manage messaging & content on Instagram** |
| 2. Use cases — V1.3 | **Manage everything on your Page** |
| 2. Use cases — V1.3 | **Engage with customers on Messenger from Meta** |
| 2. Use cases — V1.5 | **Create & manage ads with Marketing API** |
| 2. Use cases — V1.5 | **Measure ad performance data with Marketing API** |
| 2. Use cases — V1.5 | **Capture & manage ad leads with Marketing API** |
| 2. Use cases — V2 | **Access the Threads API** |
| 2. Use cases — V2 | **Embed Facebook, Instagram and Threads content in other websites** (oEmbed) |
| 2. Use cases — V3 | **Connect with customers through WhatsApp** |
| 3. Business | `Lumo Technologies` Business Portfolio (create if missing) |
| 4. Requirements | Privacy URL, ToS URL, Data deletion callback (see below) |
| 5. Overview | Review and create |

**Add all use cases up front in one app submission** — Meta lets one app bind multiple use cases, and adding later requires app amendments. We bind everything at once; the eng work behind each one ships at its respective version.

**Skip permanently:** Authenticate with Facebook Login (we use Supabase Auth), Audience Network (monetizing OUR app — not us), Catalog API (no e-commerce), Launch Instant Game, Access Live Video API, Share fundraisers, Allow data transfer (data portability), Join ThreatExchange, Advertise on your app with Audience Network, Other (deprecated path).

### Why bind ads use cases up front even if we don't ship them in V1.0

Each use case binding is independent at submission. We can ship V1.2 (IG read+write) with only `instagram_business_*` permissions submitted, even though the Marketing API use case is also bound. Binding now means we don't pay a 4–6 week amendment delay later when V1.5 lands — we just submit the additional permissions for the already-bound Marketing API use case.

---

## Step 1 — App details

| Field | Limit | Lumo value |
|---|---|---|
| App name | 30 chars | `Lumo Super Agent` |
| App contact email | — | `prasanth.kalas@lumo.rentals` |

App name shows on the user's **My Apps** page and is associated with the App ID. Can be changed later in Settings.

---

## Step 2 — Use cases (the full menu)

Meta presents 19 use cases organized in 5 filter buckets: **Featured (6) · All (19) · Ads and monetization (6) · Content management (5) · Business messaging (3) · Others (5)**. We pick from "Content management". The full list, captured for future reference:

### Featured (6)

These are Meta's UX-promoted picks. None of them are right for Lumo, but recording in case Meta reshuffles:

1. **Create & manage ads with Marketing API** — Programmatic ad campaigns. Skip.
2. **Measure ad performance data with Marketing API** — Ad ROI / custom audiences. Skip.
3. **Capture & manage ad leads with Marketing API** — Lead Ads API. Skip.
4. **Create & manage app ads with Meta Ads Manager** — Mobile app install ads. Skip.
5. **Access the Threads API** — Threads posting / threads / replies / insights. *V2 candidate for Lumo when we add Threads to the dashboard.*
6. **Launch an Instant Game on Facebook and Messenger** — In-Feed game. Skip.

### Content management (5) ← our category

7. **Manage messaging & content on Instagram** ← **Lumo picks this for IG.** Publish posts, share stories, reply to comments, answer DMs. Replaces the legacy "Instagram Basic Display" + "Instagram Graph API" options consolidated by Meta in late 2024. Works for IG Business + Creator accounts.
8. **Manage everything on your Page** ← **Lumo picks this for Facebook Pages.** Publish content, moderate posts/comments, get insights. Pages API.
9. **Embed Facebook, Instagram and Threads content in other websites** — oEmbed for content embeds on third-party sites. Skip — we render dashboards, not embed widgets.
10. **Access the Live Video API** — Streaming live to FB. Skip — not in V1 scope.
11. **Share or create fundraisers on Facebook and Instagram** — Fundraiser API. Skip.

### Business messaging (3)

12. **Engage with customers on Messenger from Meta** — *Optional V1.3+ pick.* Adds Messenger DM management for Facebook Pages. Useful for our Inbox tab if we want to surface FB Page DMs alongside YouTube comments. Required scopes: `pages_messaging`. Add when we expand the Inbox tab beyond V1.
13. **Connect with customers through WhatsApp** — WhatsApp Business Platform. *V3 candidate.* Skip for now.
14. **Authenticate and request data from users with Facebook Login** — "Sign in with Facebook" on our app. Skip — we use Supabase Auth.

### Ads and monetization (6) — all skipped

15. **Advertise on your app with Meta Audience Network** — Monetize your app. Skip.
16. **Manage products with Catalog API** — Only if we ever add e-commerce. Skip.

### Others (5)

17. **Allow users to transfer their data to other apps** — Data portability API. Skip.
18. **Join ThreatExchange** — Threat-signal sharing. Skip.
19. **Create an app without a use case** — Empty shell. Skip — we want the use cases pre-bound.

Plus a deprecated **Other** path at the bottom: "This option is going away soon. Your app will be created in the old experience." Avoid.

---

## Step 3 — Business

Meta requires every app to belong to a **Business Portfolio** (formerly "Business Manager"). If you don't have one for Lumo:

1. Open **Meta Business Suite** (`business.facebook.com`).
2. Create Business Portfolio: name `Lumo Technologies`.
3. Verify business identity — Meta will require:
   - Business legal name
   - Business address (same as our company registration)
   - Business phone
   - Business website (`lumotechnologies.com`)
   - Tax-ID / business registration documents (for verification level 2, needed for Live mode)

**Business verification is on the critical path for App Review.** Without a verified business, the app stays in Development mode and only test users can connect. Start verification immediately — Meta usually returns within 2–5 business days.

---

## Step 4 — Requirements

Meta's data-handling questionnaire. Required fields:

| Field | Lumo value |
|---|---|
| Privacy Policy URL | `https://www.lumotechnologies.com/privacy` |
| Terms of Service URL | `https://www.lumotechnologies.com/terms` |
| Data Deletion Instructions URL | `https://www.lumotechnologies.com/legal/meta-data-deletion` |
| Data Deletion Callback URL | `https://lumo-super-agent.vercel.app/api/connections/meta/data-deletion` |
| App icon | 1024×1024 PNG, transparent or solid |
| App category | "Productivity" (or "Business and Pages" — both acceptable) |

### Pages we need to ship before submitting

These are blockers for App Review approval, not just for the form:

- **`/privacy`** on `lumotechnologies.com` — must explicitly state what data Lumo reads from Meta APIs and what we do with it (the per-scope language).
- **`/terms`** — standard ToS.
- **`/legal/meta-data-deletion`** — public page describing how a user can request data deletion. Either an email address (acceptable) or a self-service portal (preferred). Reachable without auth.
- **`/api/connections/meta/data-deletion`** — server endpoint that accepts Meta's signed deletion-request webhook, returns an opaque tracking ID + a status URL. We have to build this. (Task to add: see §6.)

### Data Use Checkup

Meta also requires an annual **Data Use Checkup** — every 365 days you re-attest that the app's data use matches what you declared. Calendar reminder for one year from app creation.

---

## Step 5 — Overview

Final review screen. Confirm everything, click **Create**. The app lands in **Development Mode** by default.

---

## After creation — the path to Live mode

Three parallel tracks:

### Track A — Business verification

1. Open Meta Business Suite → Settings → Business Info → Business Verification.
2. Submit legal docs.
3. Wait 2–5 business days.

Without verification, the app cannot enter App Review.

### Track B — App Review submission (per scope)

For each scope we need, we submit a **screen recording** showing exactly how Lumo uses that scope. Meta reviewers literally watch the video and approve or request changes. Each video should be 1–3 minutes, narrated, demonstrating real Lumo UX.

#### Scopes for "Manage messaging & content on Instagram"

| Scope | What it does | Demo video should show |
|---|---|---|
| `instagram_business_basic` | Read profile + media | User connects IG → /workspace populates "Instagram" card with username, follower count, last 5 posts |
| `instagram_business_manage_comments` | Read + reply to comments | User on /workspace Inbox tab → sees recent IG comments → clicks "Draft reply" → confirmation card → reply posts |
| `instagram_business_manage_messages` | Read + send DMs | User on /workspace Inbox tab → sees recent DMs → drafts reply → confirmation card → sends |
| `instagram_business_content_publish` | Publish posts / reels / stories | User on /workspace Content tab → "Schedule post" → confirmation card → publishes |

#### Scopes for "Manage everything on your Page"

| Scope | What it does | Demo video should show |
|---|---|---|
| `pages_show_list` | List Pages user manages | Connect → /workspace shows Page selector dropdown with all Pages |
| `pages_read_engagement` | Read Page insights + comments | /workspace shows Page reach, engagement, top posts, recent comments |
| `pages_manage_posts` | Publish/edit/delete Page posts | "Schedule Page post" → confirmation card → publishes |
| `pages_manage_engagement` | Reply to / hide / delete comments | Inbox tab → click comment → draft reply → confirmation card → posts |

#### Scopes for "Engage with customers on Messenger" (V1.3+)

| Scope | What it does | Demo video should show |
|---|---|---|
| `pages_messaging` | Read + send Page DMs | Inbox tab → Page DM thread → draft reply → confirmation card → sends |

### Track C — Test users

While App Review is pending (4–6 weeks typical), we can test the full flow with **Test Users** (added in App Dashboard → Roles → Test Users) or **App Roles** (yourself + 1–2 dev teammates as Admins/Developers/Testers).

This is how we ship V1.2/V1.3 internally and demo to investors before the public launch.

---

## Estimated timeline

| Milestone | Calendar days |
|---|---|
| App created in Development Mode | Day 0 |
| Business Portfolio verified | Day 0 → Day 5 |
| Privacy / ToS / Data deletion pages live | Day 0 → Day 3 (small eng task) |
| `/api/connections/meta/data-deletion` endpoint live | Day 0 → Day 3 (small eng task) |
| First scope demo videos recorded | Day 5 → Day 8 |
| App Review submitted | Day 8 |
| First Meta review response | Day 22 → Day 35 |
| Most-requested-changes resubmission | Day 28 → Day 40 |
| App in Live Mode | Day 35 → Day 50 |

**Optimistic:** 5 weeks.  **Realistic:** 7 weeks.  **Pessimistic:** 12 weeks if Meta requires multiple resubmissions.

---

## Live app identifiers (created 2026-04-25)

| Identifier | Value |
|---|---|
| App ID | `843352985454776` |
| App Secret | (in App settings → Basic → click Show. Store as `LUMO_META_APP_SECRET` in Vercel.) |
| Business Portfolio | `Lumo Technologies` |
| Business ID | `620974270974051` |
| Instagram (sub-)app ID | `845859035210425` |
| Instagram app name | `Lumo Technologies-IG` |
| App admin | prasanth.kalas@lumo.rentals |
| Status | Development Mode (Unpublished) |
| Use cases auto-bound on creation (all 11) | Marketing API (3 ad use cases), Meta Ads Manager, Threads, IG, Pages, oEmbed, Live Video, Messenger, WhatsApp |

### Permissions added (state as of 2026-04-25 evening)

**Instagram API use case — V1.2 set complete:**
- `instagram_business_basic` ✓
- `instagram_manage_comments` ✓
- `instagram_business_manage_messages` ✓
- `instagram_business_content_publish` ✓
- `instagram_business_manage_insights` ✓
- (auto-included as "Ready for testing": `ads_management`, `ads_read`, `business_management`, `pages_read_engagement`, `pages_show_list`, `public_profile`)

**Pages API use case — V1.3 set complete:**
- `pages_manage_posts` ✓
- `pages_manage_engagement` ✓
- `pages_manage_metadata` (auto-included as "Ready for testing")
- `pages_show_list` (auto-included)
- `pages_read_engagement` (auto-included)

**Marketing API / Threads / WhatsApp / oEmbed / Messenger / Live Video / Meta Ads Manager use cases — bound but no permissions Added yet** (intentional — adding scopes there triggers their App Review tier; we Add when V1.5/V2/V3 eng is ready).

### App Submission readiness — blockers

App settings → Basic shows banner "Currently Ineligible for Submission" with 4 missing fields. These are the V1.0 blockers to surface in App Review:

| Missing field | Action | Dependency |
|---|---|---|
| App icon (1024×1024) | Upload final Lumo logo PNG | Operator |
| Privacy policy URL | Paste `https://www.lumotechnologies.com/privacy` | Build page first (Task #22) |
| User data deletion URL | Paste `https://www.lumotechnologies.com/legal/meta-data-deletion` + the callback `https://lumo-super-agent.vercel.app/api/connections/meta/data-deletion` | Build page + endpoint first (Task #22) |
| Category | Select **Productivity** dropdown | Operator (60 sec) |

Plus separately required (not in the banner but blocking):
- **Terms of Service URL** field on same page — paste `https://www.lumotechnologies.com/terms` (Task #22 ships this page)
- **OAuth Redirect URI** in Facebook Login for Business → Settings — paste `https://lumo-super-agent.vercel.app/api/connections/callback`
- **Business Verification** in Review → Verification — needs operator-side legal docs

---

---

## Step 6 — Customize use case (post-creation)

After Steps 1–5 complete, Meta drops you on the **Customize use case** surface for each bound use case. This is where you pick the **exact permissions + features** within that use case. Every permission has an **Add** button → adds it as "Ready for testing" → and is then submittable for App Review later.

The left sidebar exposes: **Dashboard · Required actions · Use cases · Facebook Login for Business · Review (Testing · Verification · App Review) · Publish**, plus **App settings (Basic · Advanced) · App roles (Roles · Test users) · Alert Inbox · Activity Log**.

### Auto-included permissions (don't touch — they're bonus from the use case enum)
- `ads_management`, `ads_read`, `business_management`
- `pages_read_engagement`, `pages_show_list`
- `public_profile`

### IG permissions to ADD (V1.2 — locked)

| Permission | Purpose |
|---|---|
| `instagram_business_basic` | Read profile + media |
| `instagram_business_content_publish` | Publish posts / reels / stories |
| `instagram_business_manage_comments` | Read + reply to comments |
| `instagram_business_manage_insights` | Get audience + engagement metrics |
| `instagram_business_manage_messages` | DM inbox *(optional V1.3 — add now to save a future amendment)* |

### IG permissions to SKIP

`instagram_branded_content_ads_brand`, `instagram_branded_content_brand`, `instagram_branded_content_creator`, `instagram_creator_marketplace_discovery`, `instagram_manage_upcoming_events`, `instagram_shopping_tag_products`, `instagram_basic` (legacy, replaced by `instagram_business_basic`), `instagram_content_publish` (legacy, replaced by `instagram_business_content_publish`), `instagram_manage_*` (legacy variants), `email`, `Human Agent`, `Instagram Public Content Access`, `Business Asset User Profile Access`, `catalog_management`.

### Switching to FB Pages use case

Use the **"Use case switcher"** combobox at the top of the Customize page (currently labeled "Instagram API"). Switch to **"Manage everything on your Page"**.

### Page permissions to ADD (V1.3 — locked)

| Permission | Purpose |
|---|---|
| `pages_manage_posts` | Publish / edit / delete Page posts |
| `pages_manage_engagement` | Reply to / hide / delete Page comments |
| `pages_manage_metadata` | Webhooks + Page settings (needed for live refresh) |
| `pages_messaging` | Page DMs *(V1.3+)* |

(`pages_show_list` and `pages_read_engagement` already auto-included.)

---

## Operator checklist for the current submission

### Steps 1–5 (DONE 2026-04-25)
- [x] App name + email entered in Step 1
- [x] Use case 1: **Manage messaging & content on Instagram**
- [x] Use case 2: **Manage everything on your Page**
- [x] Business Portfolio: `Lumo Technologies` (Business ID `620974270974051`)
- [x] App created → App ID `843352985454776`

### Step 6 — Customize use case (CURRENT)
- [ ] On Instagram API use case: click **Add** on `instagram_business_basic`
- [ ] click **Add** on `instagram_business_content_publish`
- [ ] click **Add** on `instagram_business_manage_comments`
- [ ] click **Add** on `instagram_business_manage_insights`
- [ ] click **Add** on `instagram_business_manage_messages` *(optional V1.3 — add now to save a future amendment)*
- [ ] Switch use case dropdown → **Manage everything on your Page**
- [ ] click **Add** on `pages_manage_posts`
- [ ] click **Add** on `pages_manage_engagement`
- [ ] click **Add** on `pages_manage_metadata`
- [ ] click **Add** on `pages_messaging` *(V1.3)*

### After permission selection — App settings
- [ ] App settings → Basic → capture App ID + App Secret
- [ ] Add Vercel env: `LUMO_META_APP_ID=843352985454776`, `LUMO_META_APP_SECRET=<from settings>`
- [ ] Add OAuth redirect URI in App settings → Basic → "Valid OAuth Redirect URIs": `https://lumo-super-agent.vercel.app/api/connections/callback`
- [ ] Privacy URL → `https://www.lumotechnologies.com/privacy`
- [ ] ToS URL → `https://www.lumotechnologies.com/terms`
- [ ] Data deletion callback → `https://lumo-super-agent.vercel.app/api/connections/meta/data-deletion`
- [ ] Data deletion instructions URL → `https://www.lumotechnologies.com/legal/meta-data-deletion`
- [ ] App icon uploaded (1024×1024 PNG)
- [ ] App category: **Productivity**

### Required actions tab — see what Meta wants
- [ ] Open left nav → **Required actions** → resolve each item

### Verification track (parallel)
- [ ] Open left nav → **Review → Verification** → start Business Verification
- [ ] Submit business legal docs

### Once permissions added + Business Verification submitted
- [ ] Add yourself as Test User: **App roles → Test users → Add**
- [ ] Connect IG Business account in Test mode → verify Lumo workspace pulls live data
- [ ] Connect FB Page in Test mode → verify Page card loads
- [ ] Record demo videos per scope (1–3 min each, 9 total)
- [ ] **Review → App Review** → submit each scope with its video
- [ ] Wait 2–4 weeks
- [ ] Address any change requests, resubmit
- [ ] Once all scopes approved → **Publish** → flip to Live mode

---

## Future Meta amendments (post-V1.3)

If we extend the dashboard into other Meta surfaces, here's what we'd add:

| Future feature | Use case to add |
|---|---|
| Threads (X-style microblog) | "Access the Threads API" |
| WhatsApp Business support for clients | "Connect with customers through WhatsApp" |
| Embed our content on partner sites | "Embed Facebook, Instagram and Threads content" (oEmbed) |
| FB Live streaming for events | "Access the Live Video API" |

Each addition is an **app amendment** — not a new app. Submit through the same App Review surface, with new demo videos for the new scopes.

---

## Sources

- Captured live from `developers.facebook.com/apps/creation/` on 2026-04-25.
- Tied to PRD: `docs/specs/workspace-and-creator-connectors.md` §11 (Approval / legal track).
