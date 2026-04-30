# WEB-SCREENS-1 — audit, 2026-04-30

Branch: `claude-code/web-screens-1` from `origin/main` at `864cf31`.

## TL;DR

Six consumer surfaces are missing or thin on web while iOS has parity (trips, receipts, account, notification prefs, profile, settings index). Backend is mostly already real — `transactions`/`transaction_legs` (MERCHANT-1), `listTripsForUser` (history.ts), `UserProfile` (memory.ts), `/api/me` all exist. Only one surface (notification preferences) needs the stub pattern. Recommend building 7 pages + 4 small backend additions + 1 stub route + 1 middleware change + ~8 tests.

## Method

Walked `apps/web/app/*` and matched each candidate surface from the brief against existing code. Cross-checked `/api/*` and `/lib/*` for each gap to decide whether building the page is UI-only, UI + thin reader, or UI + stub. Read `middleware.ts` to map auth gating. Read `tailwind.config.ts` to confirm brand-token class names (`bg-lumo-*`, `text-lumo-*`).

## Surface-by-surface

| Surface | Page route | Backend status | Gap |
|---|---|---|---|
| Sign-in | `/login`, `/signup`, `/auth/callback` | real | none |
| Chat home | `/` | real | polish gaps vs iOS — recommend deferring to POLISH-1 |
| Marketplace | `/marketplace`, `/marketplace/[id]` | real | skip per brief |
| Trips list | `/trips` | `listTripsForUser` exists | UI missing; thin GET wrapper |
| Trip detail | `/trips/[id]` | `getTripById` + cancel exist | UI missing; thin GET wrapper |
| Receipts list | `/receipts` | `transactions` table exists | UI + new `lib/transactions.ts` reader |
| Receipt detail | `/receipts/[id]` | `transactions` + `transaction_legs` | UI + reader; refund POST = STUB |
| Account settings | `/settings/account` | `/api/me` exists | UI missing; add `member_since`; sign-out |
| Notification prefs | `/settings/notifications` | none | UI + STUB API (iOS uses local UserDefaults) |
| Voice prefs | `/settings/voice` | real | exists |
| Profile | `/profile` | `UserProfile` + PATCH exist | UI missing; add GET on the existing route |
| Cost dashboard | `/settings/cost` | real | exists |
| Settings index | `/settings` | n/a | discoverability — no top-level page |

## Detailed findings

### Already there — no work

- Sign-in flow: `middleware.ts` (lines 102–161) redirects unauthenticated visitors of protected pages to `/login?next=…`. `/` is intentionally public for the landing chat (per middleware comment, will move behind `/chat` in a future sprint — explicitly out of scope here).
- `/settings/voice` (338 LOC), `/settings/cost` (337 LOC), `/settings/wake-word` — all consumer-ready.
- `/memory`, `/history`, `/intents`, `/autonomy`, `/connections`, `/onboarding/*` — exist from prior sprints. Not touching.

### Trips — gap, mostly UI

Backend already real:
- `lib/history.ts:57` `listTripsForUser(user_id, limit)` returns rows from `public.trips`.
- `lib/trip-state.ts:389` `getTripById(trip_id)` returns the full record.
- `app/api/trip/[trip_id]/cancel/route.ts` POST cancel exists.

Naming inconsistency to flag: the existing API is singular `/api/trip/...` but consumer-page convention is plural `/trips`. Recommend adding `app/api/trips/route.ts` (GET list) and `app/api/trips/[trip_id]/route.ts` (GET detail) that delegate to the same lib functions. Leave the existing singular cancel route in place — no churn.

UI:
- `/trips` — newest-first list of trip cards (title, status pill, total, leg count, created date). Empty state copy: "No trips yet — Lumo will list your trip history here once it has booked something for you."
- `/trips/[trip_id]` — header (title, status, totals), legs as ordered list (agent, tool, summary), Cancel button when status ∈ {drafted, dispatching, partially_dispatched}, locked state when `cancel_requested_at` set.

### Receipts — gap, UI + thin reader

Backend in DB (MERCHANT-1, migration 043) but no web reader:
- `public.transactions` and `public.transaction_legs`.
- No `lib/transactions.ts` exists yet.

Need:
- `lib/transactions.ts` — `listForUser(user_id, limit)` and `getById(id, user_id)` mirroring `lib/history.ts` shape. **REAL** not stub.
- `app/api/receipts/route.ts` — GET list. REAL.
- `app/api/receipts/[id]/route.ts` — GET detail. REAL.
- `app/api/receipts/[id]/refund/route.ts` — POST **STUB** for v1. Header comment: "STUB — real flow lands in PAYMENTS-REFUND-1."

UI:
- `/receipts` — newest-first list (merchant, amount, status, date).
- `/receipts/[id]` — header (merchant, total, status), line items table, "Initiate refund" button (modal → stubbed POST → toast "We've received your refund request").

### Account settings — gap, small UI

Backend real:
- `/api/me` returns `{ id, email, full_name, first_name }`. Add `member_since` (`user.created_at`) — one-line change.
- Sign-out is `supabase.auth.signOut()` client-side.

UI:
- `/settings/account` — display name, email, member-since, "Sign out" button. Edit name → PATCH `/api/memory/profile` `display_name` (already supported via `upsertProfile`).

### Notification preferences — gap, full STUB pattern

iOS has master toggle + 4 category toggles + quiet hours, all in `UserDefaults`. Web has no equivalent and no DB column for it.

- `app/api/notifications/preferences/route.ts` — GET/PUT. Header comment naming future replacement sprint (NOTIF-PREFS-PERSIST). In-memory `Map<userId, Prefs>` for v1.
- Shape mirrors iOS: `{ master: bool, categories: { mission_update, payment_receipt, proactive_moment, system: bool }, quiet_hours: { enabled, start_hh_local, end_hh_local } }`.
- UI: `/settings/notifications` — toggles + time pickers for quiet hours.

Future-Codex hand-off (document in progress note): one migration adds `notif_prefs jsonb` to `user_profile` (or new table) + swap the lib reader from in-memory to DB. Same swap-path discipline iOS used for PAYMENTS-1 → MERCHANT-1.

### Profile — gap, UI only

Backend real:
- `lib/memory.ts:32` `UserProfile` is rich: `display_name`, `timezone`, addresses, `dietary_flags`, `allergies`, `preferred_cuisines`, `preferred_airline_class`, `preferred_airline_seat`, `frequent_flyer_numbers`, `preferred_hotel_chains`, `budget_tier`, `preferred_payment_hint`, `extra`.
- `app/api/memory/profile/route.ts` is PATCH-only today. Add a GET that returns the row via `getProfile(user.id)` — trivial.

UI:
- `/profile` — sectioned form (Identity, Travel, Food & dietary, Stay, Budget). Each field has empty/loading/error states.

### Settings index — discoverability

No top-level `/settings` page today — `/settings/cost` etc. are reachable only via direct URL or in-app links. Add `/settings/page.tsx` index that lists Account, Notifications, Voice, Wake word, Cost, with a link to /profile.

### Auth gating — middleware change

Add to `PROTECTED_PAGE_PREFIXES`:
- `/trips`
- `/receipts`
- `/profile`
- `/settings` — covers all sub-routes (existing voice/cost/wake-word aren't gated at the page level today, only via their API calls). Adding `/settings` to the prefix list closes the half-render hole.

Add to `PROTECTED_API_PREFIXES`:
- `/api/trips`
- `/api/receipts`

(`/api/notifications`, `/api/memory`, `/api/preferences` are already gated, so `/api/notifications/preferences` and the new GET on `/api/memory/profile` inherit.)

### Discoverability — header avatar + nav links

Today the header avatar in `app/page.tsx:790` links to `/memory`. Once `/settings/account` exists, repoint the avatar there. Wire links in `MobileNav` and `LeftRail` to: Trips, Receipts, Settings.

## Proposed scope — build phase

In priority order:

1. **Trips** — `/trips`, `/trips/[id]`, `/api/trips` (list+detail), middleware gate.
2. **Receipts** — `/receipts`, `/receipts/[id]`, `lib/transactions.ts`, `/api/receipts` (list+detail real, refund stub), middleware gate.
3. **Account settings** — `/settings/account`, `/api/me` adds `member_since`, sign-out.
4. **Notification preferences** — `/settings/notifications`, `/api/notifications/preferences` STUB.
5. **Profile** — `/profile`, GET on `/api/memory/profile`.
6. **Settings index** — `/settings` page.
7. **Wiring** — header avatar repoint, MobileNav + LeftRail links.
8. **Tests** — `apps/web/tests/web-screens-*.test.mjs`: unauth redirect, authenticated render, empty state, error state. Form-submit tests for `/settings/account` (sign-out) and `/settings/notifications` (toggle persists).

Estimate: ~7 pages × ~150 LOC = ~1050 LOC UI; ~250 LOC backend + stub; ~400 LOC tests. ~1 long session of work.

## Out of scope

- Chat polish parity vs iOS (POLISH-1).
- Real notification-prefs DB persistence (NOTIF-PREFS-PERSIST follow-up).
- Real refund flow (PAYMENTS-REFUND-1 follow-up).
- Mobile work (PAYMENTS-1.1 is the next iOS sprint per Kalas).
- `/landing` rework, marketing pages, blog, public docs site.
- Admin pages (covered by prior sprints).

## Open questions for review

1. **Account vs Profile split** — recommend `/settings/account` owns identity (display_name, email, sign-out) and `/profile` owns travel/food/stay preferences. Both write to `UserProfile`. OK?
2. **Refund stub UX** — modal → toast → close, no state mutation on the receipt row until real sprint ships. OK?
3. **Notification prefs storage** — in-memory `Map` (lost on server restart) is the cheapest stub. Acceptable for v1, or do you want cookie-backed?
4. **Settings index format** — flat list of links, or sectioned (Identity / Notifications / Voice / Cost)? Recommend flat with brief descriptions.
5. **Test scope** — read-only pages get redirect+render+empty+error (4 tests each); form pages additionally get a happy-path submit test. Sound bound?

Ping for scope approval. Will not start build phase until these answers + any scope adjustments.
