## Active lanes

| Lane | Worktree | Branch | Started | Sprint |
|---|---|---|---|---|
| Claude Code | Lumo_Super_Agent_claude_code | claude-code/mobile-chat-1b | 2026-04-29 | MOBILE-CHAT-1B (auth, Settings, new tests, perf, dark-mode fix, full screenshots) |

## Closed lanes

| Lane | Worktree | Branch | Started | Closed | Sprint |
|---|---|---|---|---|---|
| Codex | Lumo_Super_Agent | codex/sample-agents-1 | 2026-04-28 | 2026-04-29 | SAMPLE-AGENTS sprint |
| Codex | Lumo_Super_Agent | codex/adr-017-draft | 2026-04-29 | 2026-04-29 | ADR-017 merchant-of-record agent track |
| Claude Code | Lumo_Super_Agent_claude_code | claude-code/ios-bootstrap | 2026-04-29 | 2026-04-29 | iOS bootstrap (monorepo + hello iOS) |
| Codex | Lumo_Super_Agent_codex | codex/perm-1-permissions-and-consent | 2026-04-29 | 2026-04-29 | PERM-1 permissions and consent |
| Claude Code | Lumo_Super_Agent_claude_code | claude-code/mobile-chat-1 | 2026-04-29 | 2026-04-29 | MOBILE-CHAT-1A foundation (auth/perf deferred to 1B) |
| Codex | Lumo_Super_Agent_codex | codex/marketplace-1-distribution | 2026-04-29 | 2026-04-29 | MARKETPLACE-1 distribution |

## Last push

- 2026-04-28 — shared harness, three samples, and CI wiring ready for full acceptance pass
- 2026-04-28 — acceptance gates passed; branch ready for reviewer handoff
- 2026-04-29 — SAMPLE-AGENTS reviewer approved; lane marked closed for main fast-forward
- 2026-04-29 — ADR-017 merchant-of-record draft merged to main after reviewer approval
- 2026-04-29 — worktree-aware lane format adopted; Codex moves to PERM-1 in `Lumo_Super_Agent_codex`
- 2026-04-29 — claude-code/ios-bootstrap ready for review: monorepo conversion + apps/ios/ SwiftUI scaffold + chat-stream impl + CI; web build and iOS build+tests both green
- 2026-04-29 — claude-code/ios-bootstrap merged to main; Claude Code moves to MOBILE-CHAT-1
- 2026-04-29 — PERM-1 migration 037 drafted and pushed for early schema review
- 2026-04-29 — PERM-1 merged to main after reviewer approval; Codex moves to MARKETPLACE-1
- 2026-04-29 — claude-code/mobile-chat-1 (1A foundation) merged to main; Claude Code queued for MOBILE-CHAT-1B
- 2026-04-29 — MARKETPLACE-1 backend midpoint pushed: schema, catalog library, submissions, bundle storage, yank endpoint, version-sync cron
- 2026-04-29 — MARKETPLACE-1 second half pushed: DB-backed browse/detail feed, PERM-1 install/uninstall wiring, submission/version tests; gates green
- 2026-04-29 — MARKETPLACE-1 merged to main; Codex queued for COST-1
- 2026-04-29 — claude-code/mobile-chat-1b opened from origin/main; auth + Settings + tests + perf + dark-mode fix + full screenshot pass underway
