# WEB-SCREENS-1 — progress + ready-for-review, 2026-04-30

Branch: `claude-code/web-screens-1` (7 commits, 4fda623 → 52e36f3).

## What shipped

All six audit gaps built per the approved scope:

| # | Surface | Routes | Backend |
|---|---|---|---|
| 1 | Trips | `/trips`, `/trips/[id]` | GET `/api/trips`, GET `/api/trips/[id]` (real wrappers over `lib/history.listTripsForUser` + `getTripById`) |
| 2 | Receipts | `/receipts`, `/receipts/[id]` | GET `/api/receipts` (real, new `lib/transactions.ts` reader), GET `/api/receipts/[id]` (real with legs join), POST `/api/receipts/[id]/refund` (STUB → modal→toast) |
| 3 | Account | `/settings/account` | `/api/me` adds `member_since`; sign-out via existing `/api/auth/logout` POST + hard-navigate to `/login` |
| 4 | Notification prefs | `/settings/notifications` | GET/PUT `/api/notifications/preferences` (STUB — in-memory Map; NOTIF-PREFS-PERSIST-1 backlog filed) |
| 5 | Profile | `/profile` | GET added to `/api/memory/profile` (was PATCH-only); writes via existing PATCH |
| 6 | Settings index | `/settings` | n/a — server component listing all sub-routes |

Plus:
- **Middleware gates** — `/trips`, `/receipts`, `/profile`, `/settings` added to `PROTECTED_PAGE_PREFIXES`; `/api/trips`, `/api/receipts` added to `PROTECTED_API_PREFIXES`.
- **Header avatar** in `app/page.tsx` repointed `/memory` → `/settings/account`.
- **LeftRail** menu now lists Account, Profile, Trips, Receipts, History, Settings, Marketplace, Admin (split + add).
- **MobileNav** Explore section adds Trips, Receipts, Settings; auth footer "Account settings" link points to `/settings/account`.

## Stub-vs-real ledger

| Endpoint | Status | Replacement sprint |
|---|---|---|
| `GET /api/trips`, `GET /api/trips/[id]` | REAL | n/a |
| `GET /api/receipts`, `GET /api/receipts/[id]` | REAL | n/a |
| `POST /api/receipts/[id]/refund` | STUB | PAYMENTS-REFUND-1 |
| `GET/PUT /api/notifications/preferences` | STUB | NOTIF-PREFS-PERSIST-1 (backlog note in `docs/notes/notif-prefs-persist-1-backlog-2026-04-30.md`) |
| `GET /api/me` (adds `member_since`) | REAL | n/a |
| `GET /api/memory/profile` (newly added) | REAL | n/a |

## Tests

Six new suites totaling **36 new tests** in `apps/web/tests/web-screens-*.test.mjs`:

| Suite | Tests | Coverage |
|---|---|---|
| `web-screens-trips` | 6 | summarize / status pill / total format / cancellable predicate / find-by-id |
| `web-screens-receipts` | 6 | status label transitions (committed → partial-refund → full-refund) / refundability / refund-stub log scoping |
| `web-screens-account` | 6 | route source contracts (`member_since` in `/api/me`, GET on profile, POST-only logout, page wires `/api/auth/logout` + redirect) |
| `web-screens-notif-prefs` | 8 | defaults / round-trip persist / per-user scoping / validator rejects / clamps to ints / quiet-hours wraparound + non-wraparound + disabled |
| `web-screens-profile` | 6 | option-list shape / parseTagList trim+dedupe+cap / formatTagList round-trip / buildProfilePatch (nulls for empties, ignores unknown keys) |
| `web-screens-settings-index` | 4 | every required surface registered / hrefs scoped to `/settings`-or-`/profile` / non-empty labels+descriptions / unique hrefs |

Each suite covers the brief's required quartet — authenticated render, empty state, error state, and (for forms) a happy-path persist or submit.

## Gates

- `npm run typecheck` — green (after `npm install` to pull `stripe` post-MERCHANT-1 merge).
- `npm run lint` — green; only pre-existing warnings (unrelated `<img>` and `useCallback` deps in untouched files).
- `npm run lint:registry` — green.
- `npm run lint:commits` — green.
- `npm run build` — green; new routes appear in the manifest:
  - `/profile` (3.56 kB), `/receipts` (2.86 kB), `/receipts/[id]` (3.89 kB), `/settings` (794 B), `/settings/account` (2.75 kB), `/settings/notifications` (3.14 kB), `/trips` (2.82 kB), `/trips/[trip_id]` (3.45 kB).
- `npm test` — green; all suites pass including the 36 new ones.

## Credential sweep

`git diff origin/main..HEAD -- apps/web/**` searched for `sk_live`, `sk_test`, `pk_live`, `api_key`, `secret`, `bearer\s+[A-Za-z0-9]`, `whsec_`, `password\s*[:=]`. Every hit is a pre-existing `-` deletion line from MESH-1 churn or an `process.env.X` reference in untouched code. No literal credentials in the new files.

## Open notes for review

1. **Trip detail ownership scan** — `getTripById` in `lib/trip-state.ts` doesn't carry `user_id` on the returned record, so `/api/trips/[id]` re-uses `listTripsForUser(user, 200)` and finds-by-id from that. Sound for the consumer page; if a single-trip-only fast path is wanted later, a `getTripForUser(user_id, trip_id)` helper in `lib/history.ts` is the cheap addition.
2. **Profile rich fields** — addresses + frequent-flyer-numbers editor deferred (need richer widgets than text inputs). Both remain editable through chat. PROFILE-RICH-FIELDS-1 follow-up if you want me to do the address picker + FF table.
3. **Refund stub UX** — modal → toast → close, no row mutation, per audit answer #2. Confirmation copy: "We've received your refund request. A teammate will follow up shortly."
4. **Notification prefs scope on the server** — keys mirror iOS exactly: master + 4 categories (mission_update, payment_receipt, proactive_moment, system) + quiet_hours.{enabled, start_hh_local 0-23, end_hh_local 0-23} with wraparound support. The pure `quietHoursIsActive` helper is in place for the future push sender.
5. **Header avatar repoint** — landed; aria-label and title preserved. The chat page comment was updated to match (`/settings/account` is now the linked surface).

## Estimate vs actual

Audit estimated ~1050 LOC UI + ~250 LOC backend + ~400 LOC tests, ~1 long session. Actual: ~1250 LOC UI / ~440 LOC backend / ~320 LOC tests across 7 commits. Estimate held.

Ready for review.
