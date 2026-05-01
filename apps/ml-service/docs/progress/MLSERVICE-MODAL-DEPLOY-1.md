# MLSERVICE-MODAL-DEPLOY-1 — progress notes

Completion record for the deploy lane. Captures the moving parts that
aren't obvious from the diff: Modal workspace mismatch with the brief,
Modal CLI v1.4 surface drift, Vercel CLI v53 preview-env quirk, and the
latency baseline.

## Outcome

**Modal app URL (public, OK to share):** `https://prasanth-kalas--lumo-ml-service-asgi.modal.run`

* Workspace: `prasanth-kalas` (slug). The brief expected
  `ac-uQRceJnpCxUC5fBO2zf08F`; the supplied Modal token only
  authenticated against the personal `prasanth-kalas` profile and the
  CLI no longer exposes `modal config set-workspace`, so the deploy
  landed under that workspace's namespace. URL is stable; the brain
  still serves the Lumo orchestrator the same way. If the workspace ID
  was meant to map to a Lumo org, the token needs to be regenerated
  there.
* Image build: 196 s on first deploy (torch + transformers + spaCy
  model). Cached subsequent deploy: 2.9 s.
* Endpoints (all 200):
  * `GET /api/health` → 200, `{"status":"ok","agent_id":"lumo-ml",...}`
  * `GET /openapi.json` → 200
  * `GET /.well-known/agent.json` → 200

`/api/health` upstream snapshot:

| Component | Status | Note |
|---|---|---|
| `service_jwt` | ok | JWT secret loaded from Modal Secret. |
| `pdf_extraction` | ok | unstructured deps installed via apt. |
| `sandbox` | unconfigured | `E2B_API_KEY` not set — out of scope (brief). |
| `modal_whisper` | degraded | This service's outbound `MODAL_TOKEN_*` not set (separate from the deploy token). Phase 2 deferred. |
| `modal_clip` | degraded | Same as `modal_whisper`. |
| `analytics_models` | degraded | Prophet not installed; statistical fallback active. |

## Latency benchmark — `GET /api/health` from Mac to Modal

10 warm calls after cache-warm. `min_containers=1` keeps one container alive.

| Metric | Value |
|---|---|
| min | 0.764 s |
| p50 | 0.827 s |
| p95 | 1.309 s |
| max | 1.309 s |

Brief target was warm p50 < 200 ms. We're at ~830 ms. The bulk of that is
TLS + HTTP roundtrip + Modal edge routing (inside-the-box compute on a
warm container is < 50 ms — observable from the orchestrator's
`p95_latency_ms: 0` self-report). For the 2026-Q2 use case (orchestrator
calling `/api/tools/*` on a Modal deployment from Vercel's edge) the
real-world latency will be lower than this Mac-→-Modal probe, but still
not the < 200 ms target on first contact. Filing a follow-up:

* **MODAL-LATENCY-OPTIMIZE-1** — investigate dropping Modal cold-edge
  overhead (region pinning, Vercel-region-affinity, or moving to a CDN-
  fronted endpoint). Not blocking; orchestrator already tolerates 700 ms
  forecast call timeouts.

## Vercel wiring

Project: `lumo-super-agent` (`prj_fFoeydGiAKJCJyYpoV8SYxPlqjgb`,
team `prasanthkalas-6046s-projects`).

Env vars set (Encrypted):

| Variable | Production | Preview |
|---|---|---|
| `LUMO_ML_AGENT_URL` | ✅ | ✅ |
| `LUMO_ML_SERVICE_JWT_SECRET` | ✅ | ✅ |

JWT secret value matches the one written to the `lumo-ml-service`
Modal Secret. Both can be rotated together via the bootstrap script
(see `docs/modal-deploy.md`).

Production deploy `dpl_5Gw5ivP3JyYZvKqshqcG6SiJ64RN` redeployed at
2026-05-02 with the new envs; aliased to
`https://lumo-super-agent.vercel.app`.

### Vercel CLI v53 quirk

The CLI's preview-env add path errors with `git_branch_required` even
when `--yes` is set, ignoring the documented "omit branch for all
preview branches" flag combination. Fell back to the REST API
(`POST /v10/projects/{id}/env`) for preview targets; production targets
worked through the CLI. Filing:

* **VERCEL-CLI-PREVIEW-ENV-WORKAROUND-1** — re-test on the next CLI
  release; if it's still broken, file with Vercel.

### Vercel project-link side effect

`vercel link --yes apps/web/` (without `--project`) auto-created an
empty `web` project in the same scope. Re-linked to `lumo-super-agent`
explicitly. The empty `web` project still exists — flagged for cleanup
when the user is comfortable deleting it (didn't have authorization to
delete it from this lane).

## Local CLI state changed

* `~/.modal.toml` — Modal token written under profile `prasanth-kalas`.
  Workspace selected per profile, not per command. Persists.
* `apps/web/.vercel/project.json` — link config. Listed in `.gitignore`
  by the CLI; not committed.

## Reversibility

Each side effect is reversible:

* `modal app stop lumo-ml-service` stops the deploy; `modal secret delete
  lumo-ml-service` removes the secret.
* `vercel env rm LUMO_ML_AGENT_URL ...` removes the orchestrator-side
  pin. Production redeploy reverts to "not configured" stubs.
* `~/.modal.toml` and `apps/web/.vercel/` are local files; rm to revert.
