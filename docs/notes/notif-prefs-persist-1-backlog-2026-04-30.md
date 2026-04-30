# NOTIF-PREFS-PERSIST-1 — backlog entry, filed 2026-04-30

## Why this exists

WEB-SCREENS-1 shipped `/settings/notifications` with an in-memory STUB
behind `/api/notifications/preferences`. The shape on the wire is
stable (matches iOS UserDefaults exactly) — only the storage swaps.

## What needs to happen

1. **Migration** — add `notif_prefs jsonb not null default '{}'::jsonb`
   to `public.user_profile` (or a new `public.notification_preferences`
   table if there's reason to keep prefs out of the profile row).
   Schema:
   ```
   {
     master: bool,
     categories: { mission_update, payment_receipt, proactive_moment, system: bool },
     quiet_hours: { enabled: bool, start_hh_local: int 0-23, end_hh_local: int 0-23 }
   }
   ```
   Validate via a CHECK constraint or trust the lib validator (already
   written: `lib/notif-prefs-stub.ts:validatePrefsBody`).

2. **Lib swap** — replace `lib/notif-prefs-stub.ts`'s in-memory `Map`
   with Supabase upsert/select. Keep the public surface (defaultPrefs,
   getPrefs, setPrefs, validatePrefsBody, quietHoursIsActive) so the
   route + page stay untouched.

3. **iOS hand-off** — the iOS Settings page currently writes
   UserDefaults. Add a `PUT /api/notifications/preferences` call from
   iOS so server-side delivery (push fan-out, digest cron) honors the
   same prefs. Local cache stays for offline reads but is sourced from
   the server on next launch.

4. **Push-fan-out integration** — the future APNs sender (Phase 4.5)
   reads prefs to decide whether to deliver / hold during quiet hours.
   `quietHoursIsActive` is already exposed as a pure helper for that
   call site.

## Out of scope for this sprint

- A separate "snooze-for-N-hours" toggle (filed if requested later).
- Per-category quiet-hours overrides.
- Geographic timezone awareness (current shape is local-hour only;
  push sender resolves the user's timezone).

## Touch points to update

- `apps/web/lib/notif-prefs-stub.ts` → rename to `lib/notif-prefs.ts`,
  swap implementation.
- `db/migrations/04X_notif_prefs.sql` (new).
- `apps/web/app/api/notifications/preferences/route.ts` — no change
  needed if lib surface stays the same.
- `apps/web/app/settings/notifications/page.tsx` — no change.
- `apps/ios/.../NotificationSettings*` — add server PUT call alongside
  the existing UserDefaults write.

Cost: small. ~1 short Codex session.
