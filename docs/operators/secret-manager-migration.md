# Cloud Run secrets → Google Secret Manager migration plan (Brain / lumo-ml-prod)

**Task:** #64. Move Brain secrets from raw Cloud Run env vars to Secret Manager references.

**Critical constraint — read first:** This plan is purely architectural. **No secret values change. No keys are re-issued. No credentials are re-generated.** Every value currently held in a Cloud Run env var is moved verbatim into a Secret Manager version with the same string content. Re-issuance of any credential is explicitly out of scope and is tracked separately for after the broader project ships.

**Outputs:** new Secret Manager secrets, updated Cloud Run revision referencing them via `--set-secrets`, and the env-var entries removed once the new revision serves traffic. No code changes in either repo.

---

## 1. Inventory — environment variables read by the Brain

Source: grep `os.getenv` / `os.environ` across `Lumo_ML_Service/app/**/*.py` plus `.env.example` and `Dockerfile`.

| # | Env var                       | Read in (file:line)                                  | Purpose                                              | Sensitivity | Required to boot? |
|---|-------------------------------|------------------------------------------------------|------------------------------------------------------|-------------|-------------------|
| 1 | `LUMO_ML_SERVICE_JWT_SECRET`  | app/config.py:22; app/auth.py:21–29; app/main.py:124 | HMAC-SHA256 secret for verifying inbound service JWTs | **HIGH**    | Soft — health returns `degraded` if absent; tool calls 503 |
| 2 | `MODAL_TOKEN_ID`              | app/main.py:350; app/transcription.py:46; app/image_embedding.py:47 | Modal Labs API token id (Whisper, CLIP)              | **MEDIUM**  | No — disables modal upstreams |
| 3 | `MODAL_TOKEN_SECRET`          | same as MODAL_TOKEN_ID                               | Modal Labs API token secret                          | **HIGH**    | No |
| 4 | `E2B_API_KEY`                 | app/sandbox.py:162                                   | E2B sandbox API key (E2B-WIRE, post commit 204e896)  | **HIGH**    | No — sandbox returns `not_configured` |
| 5 | `PYANNOTE_AUTH_TOKEN`         | app/modal_whisper.py:67                              | HuggingFace pyannote token (diarization)             | **MEDIUM**  | No |
| 6 | `HUGGINGFACE_TOKEN`           | app/modal_whisper.py:68                              | Generic HF fallback for the above                    | **MEDIUM**  | No |
| 7 | `HF_TOKEN`                    | app/modal_whisper.py:69                              | Second alias for HF token                            | **MEDIUM**  | No |
| 8 | `LUMO_ML_PUBLIC_BASE_URL`     | app/config.py:18                                     | Public origin for `/.well-known/agent.json`          | **LOW**     | No (defaults to localhost) |
| 9 | `LUMO_ML_ENV`                 | app/config.py:20                                     | `dev` / `staging` / `prod` flag                      | **LOW**     | No |

**Total: 9 env vars. Of those, 4 are HIGH sensitivity, 3 are MEDIUM, 2 are LOW (config flags).**

### About `LUMO_FOOD_OAUTH_SIGNING_SECRET`

The user-supplied list mentioned this var. A repository-wide grep confirms it is **not** read by the Brain (`Lumo_ML_Service`). It is consumed elsewhere (Super Agent / food agent path). Out of scope for this migration but flagged here so the eventual cross-service inventory is consistent.

### Sensitivity tiers (definitions)

- **HIGH** — auth/signing material. Compromise lets an attacker impersonate the service or mint valid JWTs. Stored in Secret Manager, accessed by service account only.
- **MEDIUM** — third-party API tokens (Modal, HuggingFace, E2B). Compromise costs money / data leakage but not full service impersonation. Same Secret Manager treatment.
- **LOW** — config strings (env name, public URL). Non-sensitive; can stay as plain `--set-env-vars`. Migrating them adds friction with no security benefit. **Recommendation: leave LOW vars as env-vars.**

---

## 2. Secret Manager design

### Naming convention

Recommended pattern: `lumo-ml-{purpose}-{env}` (kebab case, lowercase). Examples:

| Env var                       | Secret Manager name              |
|-------------------------------|----------------------------------|
| `LUMO_ML_SERVICE_JWT_SECRET`  | `lumo-ml-service-jwt-prod`       |
| `MODAL_TOKEN_ID`              | `lumo-ml-modal-token-id-prod`    |
| `MODAL_TOKEN_SECRET`          | `lumo-ml-modal-token-secret-prod`|
| `E2B_API_KEY`                 | `lumo-ml-e2b-api-key-prod`       |
| `PYANNOTE_AUTH_TOKEN`         | `lumo-ml-pyannote-token-prod`    |
| `HUGGINGFACE_TOKEN`           | `lumo-ml-huggingface-token-prod` |
| `HF_TOKEN` (alias)            | (consolidate — see below)        |

Rationale: `{service}-{purpose}-{env}` makes filtering by service or environment a single `gcloud secrets list --filter` and keeps prod/staging/dev parallel. Hyphens are required (Secret Manager rejects underscores in some surfaces and uppercase isn't allowed).

#### Consolidating `HUGGINGFACE_TOKEN` / `HF_TOKEN`

The Brain reads them as a fallback chain (`PYANNOTE_AUTH_TOKEN || HUGGINGFACE_TOKEN || HF_TOKEN`). With the value held identically in three places today, point both `HUGGINGFACE_TOKEN` and `HF_TOKEN` Cloud Run env entries at the same secret `lumo-ml-huggingface-token-prod`. We do not collapse the env-var aliases (that would require a code change, which is out of scope).

### Version strategy

- One secret per logical credential. New value = new **version**, old version stays `enabled` until verification, then `disabled` (kept for audit, not deleted).
- Cloud Run reference style: `--set-secrets KEY=lumo-ml-service-jwt-prod:latest`. Using `:latest` lets Cloud Run auto-pick the newest enabled version on each new revision deploy. Pin to an explicit version (`:1`, `:2`) for any secret where you want change-control gating.
- Initial migration: each secret starts at version `1` containing the current value lifted verbatim from the existing Cloud Run env var.

### IAM design

Subjects (who reads):

- **Cloud Run runtime service account** for `lumo-ml-prod`. If the service still uses the default compute SA, create a dedicated SA first: `lumo-ml-prod-runtime@<project>.iam.gserviceaccount.com`. Dedicated SAs are required for least-privilege secret access and are a SOC2/IAM hygiene baseline.

Roles:

- Grant `roles/secretmanager.secretAccessor` to the runtime SA at the **per-secret** level (not project-level). Per-secret bindings keep blast radius small if any one secret leaks an audit log.
- Operators (you, on-call) need `roles/secretmanager.admin` only at the project level for create/version/disable; do **not** grant `secretAccessor` to humans by default — fetching plaintext should require an explicit `gcloud secrets versions access` and leave an audit log line.

Optional but recommended:

- Customer-managed encryption (CMEK) is **not** in scope for this migration. Default Google-managed encryption is acceptable for HIGH-tier app secrets. Revisit during the SOC2/ISO track.
- Enable **Secret Manager audit logging** for `DATA_READ` on this project so every `secretAccessor` access is logged. One-time project setting; no per-secret cost.

### Future-policy placeholder (NOT planned in this task)

A secret-lifecycle policy will be defined as a follow-up after the broader project ships. That follow-up will cover cadence, ownership, and incident-driven re-issuance windows. **Nothing in the current migration changes any value or schedules any value change.**

---

## 3. Migration steps (paste-ready)

Pre-work: identify the runtime service account on `lumo-ml-prod` and the project id.

```bash
export PROJECT_ID="lumo-prod"          # replace
export REGION="us-central1"            # replace
export SERVICE="lumo-ml-prod"
export RUNTIME_SA="lumo-ml-prod-runtime@${PROJECT_ID}.iam.gserviceaccount.com"

# (a) Confirm or create the dedicated runtime SA. Skip create if it already exists.
gcloud iam service-accounts describe "$RUNTIME_SA" --project="$PROJECT_ID" \
  || gcloud iam service-accounts create lumo-ml-prod-runtime \
       --display-name="Lumo ML Brain (prod) runtime" \
       --project="$PROJECT_ID"

# (b) Bind the SA to the Cloud Run service if it isn't already.
gcloud run services update "$SERVICE" \
  --region="$REGION" --project="$PROJECT_ID" \
  --service-account="$RUNTIME_SA"
```

### Step 1 — Create the secrets in Secret Manager

For each HIGH/MEDIUM env var, create the secret and load version 1 from the value currently on Cloud Run. Pull current values into local shell vars **once** from the Cloud Run revision; never paste them into a chat or commit.

```bash
# Pull current env values from the live revision into local vars.
# (The grep extracts NAME=value pairs from the active revision template.)
gcloud run services describe "$SERVICE" --region="$REGION" --project="$PROJECT_ID" \
  --format='value(spec.template.spec.containers[0].env)'   # inspect, copy values into shell vars manually

# Then, for each secret (do not echo values):
read -rs JWT;          export JWT          # paste LUMO_ML_SERVICE_JWT_SECRET, then Enter
read -rs MODAL_ID;     export MODAL_ID
read -rs MODAL_SEC;    export MODAL_SEC
read -rs E2B;          export E2B
read -rs PYANNOTE;     export PYANNOTE
read -rs HF;           export HF

# Create + populate version 1 for each secret.
for pair in \
  "lumo-ml-service-jwt-prod:JWT" \
  "lumo-ml-modal-token-id-prod:MODAL_ID" \
  "lumo-ml-modal-token-secret-prod:MODAL_SEC" \
  "lumo-ml-e2b-api-key-prod:E2B" \
  "lumo-ml-pyannote-token-prod:PYANNOTE" \
  "lumo-ml-huggingface-token-prod:HF"; do
  NAME="${pair%%:*}"; VAR="${pair##*:}"
  gcloud secrets create "$NAME" \
    --replication-policy=automatic --project="$PROJECT_ID" 2>/dev/null || true
  printf '%s' "${!VAR}" | gcloud secrets versions add "$NAME" \
    --data-file=- --project="$PROJECT_ID"
done

# Wipe shell vars immediately.
unset JWT MODAL_ID MODAL_SEC E2B PYANNOTE HF
```

### Step 2 — Grant per-secret accessor role to the runtime SA

```bash
for NAME in \
  lumo-ml-service-jwt-prod \
  lumo-ml-modal-token-id-prod \
  lumo-ml-modal-token-secret-prod \
  lumo-ml-e2b-api-key-prod \
  lumo-ml-pyannote-token-prod \
  lumo-ml-huggingface-token-prod; do
  gcloud secrets add-iam-policy-binding "$NAME" \
    --member="serviceAccount:${RUNTIME_SA}" \
    --role="roles/secretmanager.secretAccessor" \
    --project="$PROJECT_ID"
done
```

### Step 3 — Deploy a new Cloud Run revision that references secrets

This single command swaps the HIGH/MEDIUM env vars to secret references and keeps the LOW config flags as plain env vars.

```bash
gcloud run services update "$SERVICE" \
  --region="$REGION" --project="$PROJECT_ID" \
  --set-secrets="\
LUMO_ML_SERVICE_JWT_SECRET=lumo-ml-service-jwt-prod:latest,\
MODAL_TOKEN_ID=lumo-ml-modal-token-id-prod:latest,\
MODAL_TOKEN_SECRET=lumo-ml-modal-token-secret-prod:latest,\
E2B_API_KEY=lumo-ml-e2b-api-key-prod:latest,\
PYANNOTE_AUTH_TOKEN=lumo-ml-pyannote-token-prod:latest,\
HUGGINGFACE_TOKEN=lumo-ml-huggingface-token-prod:latest,\
HF_TOKEN=lumo-ml-huggingface-token-prod:latest" \
  --update-env-vars="LUMO_ML_ENV=prod,LUMO_ML_PUBLIC_BASE_URL=https://api.lumo.rentals/ml" \
  --remove-env-vars="LUMO_ML_SERVICE_JWT_SECRET,MODAL_TOKEN_ID,MODAL_TOKEN_SECRET,E2B_API_KEY,PYANNOTE_AUTH_TOKEN,HUGGINGFACE_TOKEN,HF_TOKEN"
```

Notes:

- `--set-secrets` and `--remove-env-vars` are applied in the same revision; the new revision boots with secret-backed values and the env-var copies removed in one atomic deploy.
- The `--update-env-vars` line preserves the LOW-tier config flags. Adjust the URL to whatever you currently use.
- Cloud Run mounts secrets as env vars at container start; no application code change is needed.

### Step 4 — Verify the new revision is healthy

```bash
# Confirm the revision serves traffic.
gcloud run services describe "$SERVICE" --region="$REGION" --project="$PROJECT_ID" \
  --format='value(status.latestReadyRevisionName,status.url)'

# Public health probe (no auth — same path the admin page uses).
curl -sS "$(gcloud run services describe "$SERVICE" --region="$REGION" --project="$PROJECT_ID" --format='value(status.url)')/api/health" \
  | python3 -m json.tool
# Expected: status:"ok", upstream.service_jwt.status:"ok",
# upstream.sandbox.status:"ok", upstream.modal_whisper.status:"ok".
# A "degraded" on any upstream means that secret didn't mount — check Step 1/2 for that name.

# Authenticated probe (only if you keep a verification token handy).
# Run the JWT-mint snippet from brain-unreachable-triage.md §5 step (3).
```

Acceptance gates before considering the migration done:

1. `/api/health` returns `status: "ok"` end-to-end.
2. An authenticated `plan_task` call returns 200 (proves JWT secret mounted correctly).
3. At least one tool route exercising Modal (e.g. `transcribe` smoke) returns 200 in staging-equivalent traffic.
4. No new error class in Cloud Run logs in the 30-minute window after deploy.

### Step 5 — Tear-down (env-var copies)

After Step 4 passes, the env vars are already removed by the `--remove-env-vars` clause in Step 3. There is no cleanup left on the Cloud Run side. The values still exist as Secret Manager `version 1` (and any future versions) and that is the new source of truth.

If you also want to scrub the values from any developer `.env` files or password-manager exports tied to the old Cloud Run console, do that out of band. Do not commit values to the repo at any point.

---

## 4. Rollback path

If Step 4 fails (boot loop, auth failures, missing upstream), restore the previous revision in one command:

```bash
# List recent revisions to find the last known good one.
gcloud run revisions list --service="$SERVICE" \
  --region="$REGION" --project="$PROJECT_ID" --limit=10

# Route 100% traffic back to the previous revision.
gcloud run services update-traffic "$SERVICE" \
  --region="$REGION" --project="$PROJECT_ID" \
  --to-revisions="<previous-revision-name>=100"
```

The previous revision still has the env-var-backed config baked into its template, so it boots without depending on Secret Manager. Once you've root-caused the failure, re-deploy Step 3 with the fix.

If the failure is specifically that a secret value didn't load, the most common causes are:

1. The runtime SA isn't bound on `secretAccessor` for that secret (Step 2 missed an entry).
2. The secret name in `--set-secrets` is misspelled (typo in `lumo-ml-...-prod`).
3. The version pin (`:latest` vs `:1`) points at a `disabled` version.

Each of these is fixable without touching values.

---

## 5. Open items (not blocking this migration)

- **`LUMO_FOOD_OAUTH_SIGNING_SECRET` placement.** Lives outside the Brain. Decide whether it follows the same `lumo-{service}-{purpose}-{env}` convention when its owning service migrates.
- **Staging mirror.** Same plan applies to `lumo-ml-staging` with `-staging` suffix on every secret name. Recommend doing staging first as a dress-rehearsal before prod.
- **Future secret-lifecycle policy** (cadence, ownership, incident-driven re-issuance). Tracked separately. Out of scope here. No values change in this task.
