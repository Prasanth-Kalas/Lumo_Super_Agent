# APPROVAL-CONNECTION-RPC-STRICT-1 Recon

Date: 2026-05-02

## Query

Production Vercel logs were queried for the last 7 days using:

```bash
npx vercel logs --project lumo-super-agent --environment production --since 7d --no-follow --no-branch --query "first-party connect failed" -n 100 --expand
```

## Finding

The scan returned 33 log entries containing:

```text
[session-app-approvals] first-party connect failed: column reference "user_id" is ambiguous
```

The failures appeared on both:

- `POST /api/chat`
- `POST /api/lumo/mission/install`

This confirms the active bug path: the database RPC failed while the application layer could continue far enough to emit conversational success text.

## Scope Decision

This lane fixes the write path and prevents future fake-success responses. It does not attempt historical repair.

Deferred follow-up filed:

- `BACKFILL-FAILED-APPROVALS-1` — inspect affected sessions from the 7-day failure window and backfill first-party app approval + connection rows where user intent is unambiguous.

## Migration Check

Migration 060 was executed against the linked Supabase database inside an explicit `begin; ... rollback;` wrapper. The transaction completed successfully, then rolled back, so the branch proves forward syntax without changing the shared database before review.
