# Modal deploy runbook — `apps/ml-service/`

This is the production deploy path for the Lumo Intelligence Layer. The
brain runs as a Modal ASGI app under workspace `ac-uQRceJnpCxUC5fBO2zf08F`.
The orchestrator (`apps/web/`) reaches it via a single env var,
`LUMO_ML_AGENT_URL`, that points at the Modal URL.

## Prerequisites

1. **Modal CLI** installed locally:
   ```bash
   pip install modal
   ```
2. **Modal token** configured (one-time):
   ```bash
   modal token set --token-id "$MODAL_TOKEN_ID" --token-secret "$MODAL_TOKEN_SECRET"
   ```
   Tokens live in `~/.config/lumo/.env` on the developer machine. Never
   commit them.
3. **Workspace selected:**
   ```bash
   modal config set-workspace ac-uQRceJnpCxUC5fBO2zf08F
   # or pass --workspace ac-uQRceJnpCxUC5fBO2zf08F to every command
   ```

## Bootstrap the Modal Secret (first-time + rotation)

The function reads `LUMO_ML_SERVICE_JWT_SECRET` (and optionally `HF_TOKEN`,
`ANTHROPIC_API_KEY`) from the `lumo-ml-service` Modal Secret. Generate a
fresh JWT secret and bootstrap:

```bash
export LUMO_ML_SERVICE_JWT_SECRET=$(openssl rand -hex 32)
export HF_TOKEN=...   # from ~/.config/lumo/.env
bash apps/ml-service/scripts/bootstrap-modal-secrets.sh
```

Pin the same `LUMO_ML_SERVICE_JWT_SECRET` value into Vercel
(see [Vercel env wiring](#vercel-env-wiring) below).

Rotating the JWT secret is a two-step lockstep change:
1. Re-run the bootstrap script with a new value.
2. Update the matching Vercel env vars and trigger a redeploy.
Otherwise signed orchestrator → brain requests will fail validation.

## Deploy

```bash
modal deploy apps/ml-service/modal_app.py
```

First build is ~5–10 min (torch + transformers + spaCy model). Subsequent
builds are cached — only the `add_local_python_source("lumo_ml", "app")`
layer rebuilds when source changes.

Modal returns a public URL like
`https://<workspace-slug>--lumo-ml-service-asgi.modal.run`. Capture it.

## Verify

```bash
URL=https://<workspace-slug>--lumo-ml-service-asgi.modal.run

curl -fsS "$URL/api/health"                # 200, JSON status
curl -fsS "$URL/openapi.json" | head -c 200
curl -fsS "$URL/.well-known/agent.json"
```

Expected:

* `/api/health` → `200` with `{"status":"ok","agent_id":"lumo-ml",...}`.
* `/openapi.json` → 200 with a non-empty OpenAPI document.
* `/.well-known/agent.json` → 200 with the registry manifest.

### Latency benchmark

```bash
# Cold (after `modal app stop` or fresh deploy)
curl -w 'cold: %{time_total}s\n' -o /dev/null -s "$URL/api/health"

# Warm (3 consecutive calls)
for i in 1 2 3; do
  curl -w "warm-$i: %{time_total}s\n" -o /dev/null -s "$URL/api/health"
done
```

Target: warm p50 < 200 ms. Cold start depends on whether `keep_warm=1` is
honoured on the current Modal plan.

## Vercel env wiring

Set on the `lumo-super-agent` Vercel project, **Production + Preview**:

| Variable | Value |
|---|---|
| `LUMO_ML_AGENT_URL` | The Modal URL from the deploy step. |
| `LUMO_ML_SERVICE_JWT_SECRET` | The same hex string used in the Modal Secret. |

Then trigger a redeploy. The orchestrator's existing `forecasting.ts`,
`knowledge-graph.ts`, etc. callsites will start producing real responses
instead of falling back to "not_configured" stubs.

CLI alternative (requires `vercel login`):
```bash
echo -n "$URL" | vercel env add LUMO_ML_AGENT_URL production
echo -n "$URL" | vercel env add LUMO_ML_AGENT_URL preview
echo -n "$LUMO_ML_SERVICE_JWT_SECRET" | vercel env add LUMO_ML_SERVICE_JWT_SECRET production
echo -n "$LUMO_ML_SERVICE_JWT_SECRET" | vercel env add LUMO_ML_SERVICE_JWT_SECRET preview
vercel deploy --prod
```

## Rollback

```bash
modal app stop lumo-ml-service
```

This stops the active deploy. The Modal Secret and Vercel env vars stay
in place — re-deploying the same code re-establishes the same URL.

For a destructive cleanup (e.g. abandoning the workspace):
```bash
modal app stop lumo-ml-service
modal secret delete lumo-ml-service
# In Vercel dashboard or CLI, remove LUMO_ML_AGENT_URL +
# LUMO_ML_SERVICE_JWT_SECRET, then redeploy.
```

## CI smoke test

`.github/workflows/python.yml` includes a smoke job that hits
`${LUMO_ML_AGENT_URL}/api/health` and asserts a 200 response. The job is
gated on the env var being present (set as a GitHub Actions secret) and on
PRs that change `apps/ml-service/**` or `packages/lumo-shared-types/**`.
