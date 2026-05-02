# Lumo ML Service

`apps/ml-service/` is the Python-backed Intelligence Layer for Lumo. It exposes
the same public contract as every Lumo agent:

- `GET /.well-known/agent.json`
- `GET /openapi.json`
- `GET /api/health`
- `POST /api/tools/*`

The Super Agent treats this as a registry-owned system agent (`system: true`),
not as an internal API. That means it can participate in the normal registry,
tool routing, auditing, and permission model while staying auto-installed for
authenticated Lumo users.

## Local development

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -e ".[dev]"
python -m spacy download en_core_web_sm
cp .env.example .env
uvicorn lumo_ml.main:app --reload --port 3010
```

Tool routes require a Lumo-signed JWT using `LUMO_ML_SERVICE_JWT_SECRET`.
Manifest, OpenAPI, and health routes are public so the Super Agent registry can
load and monitor the service.

Run tests:

```bash
.venv/bin/python -m pytest -q
.venv/bin/python scripts/eval_phase1.py
```

## Phase 1 tools

- `lumo_plan_task`
- `lumo_rank_agents`
- `lumo_evaluate_agent_risk`
- `lumo_optimize_trip`
- `lumo_transcribe`
- `lumo_embed_image`
- `lumo_embed`
- `lumo_classify`
- `lumo_recall`
- `lumo_analyze_file`
- `lumo_generate_chart`
- `lumo_run_python_sandbox`

The first scaffold intentionally uses deterministic, cheap heuristics. The
service boundary, authentication, and agent contract are real; model-backed
implementations land behind the same routes.

`lumo_rank_agents` and `lumo_evaluate_agent_risk` are deliberately
deterministic in this scaffold. User intent is treated as untrusted text, not
as instructions to an LLM ranker, and the Super Agent has a 300ms deterministic
fallback for both tools. Risk scoring returns stable badge inputs:
`risk_level`, `score`, `flags`, and `mitigations`.

`lumo_optimize_trip` uses Google OR-Tools when available and falls back to a
deterministic nearest-neighbor route if the solver is unavailable or infeasible.
The Super Agent sends sanitized mission-derived stops and leg estimates, not raw
user prompt text, so optimization stays a computation step rather than a
reasoning or account-action step.

`lumo_transcribe` uses Deepgram Nova-3 when `LUMO_DEEPGRAM_API_KEY` is present.
Until Deepgram is configured the route returns `status: "not_configured"` with
the same response shape, allowing Lumo Core to mark the audio upload failed
without crashing recall or chat flows. When `speaker_diarization=true`, the
Deepgram request asks for diarization and returns `speaker` labels when the
provider includes them; otherwise the transcript still succeeds with
`speaker: null` and `diarization: "not_configured"`.

`lumo_embed_image` is the Sprint-1 CLIP hook. It calls a Modal GPU job running
`openai/clip-vit-base-patch32`, returning a 512-dim image vector plus bounded
zero-shot labels and a short searchable summary. Until Modal is configured the
route returns `status: "not_configured"` with the same response shape.

`lumo_recall` is also stateless in this scaffold. Lumo Core performs Supabase
pgvector lookup over redacted `content_embeddings`, sends only the bounded
candidate documents to this service, and keeps a local fallback if the recall
tool is slow or unavailable.

`lumo_run_python_sandbox` uses E2B Code Interpreter when `E2B_API_KEY` is set.
The tool keeps the same stable fallback shape when the key is absent
(`status: "not_configured"`), runs code with a maximum 30-second timeout, logs
one structured audit event per invocation, and blocks obvious network-capable
imports/commands while `network_policy` is `disabled`. Health reports
`sandbox.status: "ok"` only when the key is present and the SDK is importable.

`lumo_embed`, `lumo_classify`, and `lumo_recall` run text through the shared
redaction helper before hashing, scoring, or reranking. Regex redaction is the
always-on fast path; Microsoft Presidio runs as a lazy second pass when its NLP
runtime (`en_core_web_sm`) is available, and failures fall back to regex without
changing the tool response shape.

`lumo_classify` includes the Day-4 lead-classifier seed eval in
`tests/test_classify.py`: 100 hand-curated synthetic labels, with a confusion
matrix assertion against the previous regex baseline. Treat this as an internal
seed/regression eval only, not a held-out generalisation metric; publish a
random production-like held-out eval before quoting precision/recall/F1 outside
engineering.
