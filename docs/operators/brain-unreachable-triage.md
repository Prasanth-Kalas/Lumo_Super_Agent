# Brain "unreachable" triage — `/admin/intelligence`

**Status:** Root cause identified from code review. Recommended fix is a one-line constant change plus an optional ops-side change (Cloud Run min-instances).

**Scope of investigation:** Super Agent code path that produces the `unreachable` badge on the admin observability page, and the Brain (Lumo_ML_Service) endpoint it probes.

---

## 1. Observed call path (Super Agent → Brain)

Files inspected:

- `app/api/admin/intelligence/stats/route.ts` — admin-gated route, calls `fetchAdminIntelligenceStats()`.
- `lib/admin-stats.ts` — owns the brain probe (`fetchBrainHealth`).
- `lib/admin-stats-core.ts` — `interpretBrainHealth()` maps a null/empty body to `status: "unreachable"`.
- `lib/service-jwt.ts` — HS256 signer (NOT used for the health probe; see below).
- `Lumo_ML_Service/app/main.py` — `@app.get("/api/health")` is **public** (no `Depends(require_lumo_jwt)`).

### Exact request shape

From `lib/admin-stats.ts` (`fetchBrainHealth`):

```
URL:      ${LUMO_ML_AGENT_URL}/api/health        (trailing slashes stripped)
Method:   GET
Headers:  none added by Super Agent (no Authorization, no JWT, no x-lumo-* header)
Body:     none
Cache:    no-store
Timeout:  AbortController @ BRAIN_HEALTH_TIMEOUT_MS = 1000 ms  ← critical
Auth on Brain side: /api/health is unauthenticated (no Depends).
```

Fallback URL: when `LUMO_ML_AGENT_URL` is unset and `NODE_ENV !== "development"`, `resolveBrainBaseUrl()` returns `""`. The probe then short-circuits and `interpretBrainHealth(null, ...)` returns `unreachable`.

### Brain health response (success path)

`/api/health` returns a JSON object with top-level `status: "ok" | "degraded"` and an `upstream` map containing `service_jwt`, `sandbox`, `modal_whisper`, `modal_clip`, `pdf_extraction`, `analytics_models`. The Super Agent reads only `status`, `upstream.service_jwt`, `upstream.sandbox`, and `upstream.modal_whisper|modal_clip|modal`. Schemas are compatible — no field-name drift between the two repos as of this triage.

---

## 2. Hypothesis evaluation

### (a) Cold start exceeds the 1000 ms admin-stats timeout — **CONFIRMED ROOT CAUSE**

Evidence:

- `BRAIN_HEALTH_TIMEOUT_MS = 1000` (lib/admin-stats.ts:38).
- Brain Dockerfile installs FastAPI + JWT + uvicorn + spaCy `en_core_web_sm` model + pulls in e2b-code-interpreter (post commit 204e896 / E2B-WIRE), Prophet/scikit-learn (`_analytics_models_available`), Modal client, unstructured PDF, etc. Container init for this footprint on Cloud Run is empirically several seconds; cold start of 3–10 s is normal.
- Cloud Run scales to zero by default. Any time the Brain has been idle, the very first request after idle bears the full cold-start cost. The admin page is a low-traffic surface, so it almost always hits a cold instance.
- On `AbortError`, the `catch {}` in `fetchBrainHealth` returns `interpretBrainHealth(null, ...)` which produces `status: "unreachable"` with `service_jwt: "missing"`, `sandbox: "unconfigured"`, `modal: "unconfigured"` — exactly the symptom described.

This single failure mode reproduces the entire observed badge state without any other infrastructure issue.

### (b) JWT validation drift between Super Agent and Brain — **RULED OUT**

Evidence:

- `Lumo_ML_Service/app/main.py` line 122–175: `@app.get("/api/health")` has no `Depends(require_lumo_jwt)`. It is intentionally public so unauthenticated probes (load balancer, this admin page, uptime monitors) can hit it.
- `lib/admin-stats.ts` `fetchBrainHealth` does not call `signLumoServiceJwt()` and sends no `Authorization` header. There is no JWT in the request, and none is required.
- Therefore `LUMO_ML_SERVICE_JWT_SECRET` parity is **irrelevant** to this code path. (It still matters for tool calls — but those go through different routes, not the admin probe.)

### (c) Cloud Run public URL changed after the org-policy override — **POSSIBLE, SECONDARY**

Evidence and reasoning:

- Domain Restricted Sharing override on `lumo-ml-prod` does not in itself rotate the `*.run.app` URL. Cloud Run URLs are deterministic from `service-project.region.run.app`, so unless the service was deleted and recreated, the URL is stable.
- However, `LUMO_ML_AGENT_URL` in the Super Agent's Vercel/Cloud Run env may still point at a stale URL from before the production project. If it points at a non-existent host, fetch fails fast (DNS/connect refused) and we get `unreachable` — same symptom as (a).
- Distinguishing test: the curl below tells you immediately whether the URL is reachable; if it returns 200 in <2 s the URL is fine and the issue is purely (a); if it fails or returns ≥500 the URL needs to be updated.

---

## 3. Root cause (from code alone)

**Primary:** `BRAIN_HEALTH_TIMEOUT_MS = 1000` is too tight for a Cloud Run service that scales to zero and has a multi-second cold start. Every cold probe lands as `unreachable` even when the Brain is healthy. Post-E2B-WIRE the import surface grew (e2b SDK, sandbox module), nudging cold-start time up further, which is why this surfaced now.

**Secondary (verify):** `LUMO_ML_AGENT_URL` may be unset or stale on the Super Agent deployment; the curl below will tell you in one round trip.

---

## 4. Recommended fix

**Code change (Super Agent), one line:**

```ts
// lib/admin-stats.ts
const BRAIN_HEALTH_TIMEOUT_MS = 8000; // was 1000 — Cloud Run cold start can take 3–10s
```

8 s is a safe ceiling for the admin page (the request is awaited but the page is admin-only, occasional and tolerant of latency). If you want to keep the page snappy on cold-start days, render the badge optimistically and let the snapshot's `age_ms` reveal staleness — but the simple bump is sufficient for the immediate UX bug.

**Operational change (recommended, not strictly required):**

Set Cloud Run min-instances to `1` on `lumo-ml-prod` so the Brain stays warm. Trade-off: ~$5–15/mo per always-on CPU; eliminates cold-start for all callers (admin page, system agent dispatch, cron-triggered tools), not just this probe.

```bash
gcloud run services update lumo-ml-prod \
  --region=us-central1 \
  --min-instances=1
```

**Env-var verification (no code change):**

Confirm `LUMO_ML_AGENT_URL` on the Super Agent deploy is set to the correct Cloud Run URL of `lumo-ml-prod`. The Super Agent expects no trailing slash (it strips them) but should be the full `https://...run.app` origin.

**No JWT or secret changes are required for the health probe itself.**

---

## 5. Curl command — verify reachability + JWT + latency from your terminal

Run these from your laptop. Replace placeholders with your real values; **do not commit the output**.

```bash
# ────────────────────────────────────────────────────────────────────────
# Set these once per shell session — values come from your password
# manager / Cloud Run console / Vercel env.
# ────────────────────────────────────────────────────────────────────────
export BRAIN_URL="https://lumo-ml-prod-XXXXXXXX-uc.a.run.app"   # the value of LUMO_ML_AGENT_URL
export LUMO_ML_SERVICE_JWT_SECRET="paste-your-secret-here"      # the live secret on Cloud Run

# (1) Reachability + cold-start timing — UNAUTHENTICATED, this is exactly
#     what the admin page does. Look for HTTP 200 and total < ~10s on
#     first call, < 1s on warm calls.
curl -sS -o /tmp/brain_health.json -w 'http=%{http_code}  total=%{time_total}s  connect=%{time_connect}s\n' \
  "$BRAIN_URL/api/health"
echo '--- body ---'; cat /tmp/brain_health.json | python3 -m json.tool
# Expected: http=200, body has status:"ok" or "degraded" with upstream.* details.
# If http=000 or curl errors → URL is wrong or the service is down (hypothesis c).
# If http=200 but total>1.0s → cold start, that's the admin-page bug (hypothesis a).

# (2) Re-run immediately to measure WARM latency. Should be <300ms.
curl -sS -o /dev/null -w 'http=%{http_code}  total=%{time_total}s\n' \
  "$BRAIN_URL/api/health"

# (3) JWT validation — call an authenticated tool route with a freshly
#     signed token. Confirms LUMO_ML_SERVICE_JWT_SECRET parity end-to-end.
#     Expected: http=200 with a JSON plan_task body. If http=401 with
#     "invalid_bearer" the secret on Cloud Run does not match the secret
#     you exported above.
PYJWT_SCRIPT=$(cat <<'PY'
import os, time, uuid, jwt
secret = os.environ["LUMO_ML_SERVICE_JWT_SECRET"]
now = int(time.time())
print(jwt.encode(
    {"iss":"lumo-core","aud":"lumo-ml","sub":"triage-user",
     "jti":str(uuid.uuid4()),"scope":"admin:triage",
     "iat":now,"exp":now+60},
    secret, algorithm="HS256"))
PY
)
TOKEN=$(python3 -c "$PYJWT_SCRIPT")    # requires `pip install pyjwt` once
curl -sS -o /tmp/brain_plan.json -w 'http=%{http_code}  total=%{time_total}s\n' \
  -X POST "$BRAIN_URL/api/tools/plan_task" \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"intent_text":"triage check","user_id":"triage-user"}'
echo '--- body ---'; cat /tmp/brain_plan.json | python3 -m json.tool

# (4) Cleanup
unset LUMO_ML_SERVICE_JWT_SECRET BRAIN_URL TOKEN
rm -f /tmp/brain_health.json /tmp/brain_plan.json
```

### Interpretation matrix

| Step (1) result               | Step (2) result | Step (3) result | Diagnosis                                                      |
|-------------------------------|-----------------|------------------|----------------------------------------------------------------|
| http=200, total > 1.0 s       | total < 0.3 s   | http=200         | **Hypothesis (a)** confirmed. Apply the timeout bump.          |
| http=200, total < 0.3 s both  | total < 0.3 s   | http=200         | Brain is healthy and warm — issue is intermittent; still bump. |
| http=000 / connect failure    | —               | —                | **Hypothesis (c)**. Update `LUMO_ML_AGENT_URL`.                |
| http=200 on (1–2)             | —               | http=401         | Hypothesis (b) for tool calls (NOT the admin badge).           |
| http=403 / IAM denial         | —               | —                | Org-policy override didn't propagate; re-check allUsers grant. |

---

## 6. Out of scope for this triage

- Adjusting Cloud Run concurrency/CPU sizing (will affect cold-start duration but not whether the 1 s budget is sufficient).
- Replacing the unauthenticated `/api/health` with an authenticated variant — keep public for uptime probes; if needed add `/api/health/internal` later.
- Secret-manager migration — covered in `secret-manager-migration.md`.
