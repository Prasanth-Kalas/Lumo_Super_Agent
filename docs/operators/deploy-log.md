# Operator Deploy Log

Short notes for production changes that had non-obvious apply behavior. This
is not a substitute for git history; it is the place to write down operational
footnotes that will matter during the next incident review.

## 2026-04-28 — Migration 036 embedding RPC auth hardening

Migration `036_embedding_rpc_auth_hardening.sql` was applied in two passes.
The first Supabase SQL Editor run redefined only the rollback RPC because the
editor executed the focused statement inside the cursor block. The second pass
selected the full embedding-RPC block and landed the three embedding batch RPCs:
audio, PDF, and image.

Takeaway: for DDL migrations applied through Supabase SQL Editor, select the
entire migration (`Cmd+A`) before clicking **Run**, or use `psql` via the
pooler/direct connection. Always run the migration's post-deploy verification
query after `CREATE OR REPLACE FUNCTION` changes.
