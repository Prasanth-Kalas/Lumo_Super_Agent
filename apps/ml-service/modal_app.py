"""Modal App definition for the Lumo Intelligence Layer (FastAPI brain).

Deploy with:
    modal deploy apps/ml-service/modal_app.py

Modal returns a public URL of the form
``https://<workspace-slug>--lumo-ml-service-asgi.modal.run``. That URL is what
the orchestrator (apps/web/) pins as ``LUMO_ML_AGENT_URL`` in Vercel.

Prereqs:

1. Modal Secret ``lumo-ml-service`` — created via
   ``apps/ml-service/scripts/bootstrap-modal-secrets.sh``; carries
   ``LUMO_ML_SERVICE_JWT_SECRET`` and ``HF_TOKEN``.
2. Modal Volume ``lumo-ml-models`` — created via
   ``modal volume create lumo-ml-models`` (one-time per workspace).
   Mounted at ``/models`` so sentence-transformers' weights survive
   container restarts and cold starts skip the HuggingFace download.

See ``apps/ml-service/docs/modal-deploy.md`` for the full runbook.
"""

from __future__ import annotations

from pathlib import Path

import modal

ML_SERVICE_DIR = Path(__file__).parent
PYPROJECT = ML_SERVICE_DIR / "pyproject.toml"

# Image build:
#   1. Pin Python 3.11 (matches pyproject `requires-python`).
#   2. apt deps that unstructured / pikepdf / opencv expect at runtime.
#   3. pip install from pyproject — first build ~5-10 min, subsequent are cached.
#   4. Download spaCy ``en_core_web_sm`` so Presidio's NLP fallback works (the
#      brain still degrades to regex redaction if this is unavailable).
#   5. add_local_python_source pulls our own packages into the image.
image = (
    modal.Image.debian_slim(python_version="3.11")
    .apt_install("poppler-utils", "tesseract-ocr", "libmagic1", "libgl1")
    .pip_install_from_pyproject(str(PYPROJECT))
    .run_commands("python -m spacy download en_core_web_sm")
    .env(
        {
            # Point sentence-transformers + huggingface-hub at the
            # mounted Volume so model weights persist across container
            # restarts. The IntentClassifier reads LUMO_ML_MODEL_CACHE
            # to derive ``cache_folder`` for SentenceTransformer().
            "LUMO_ML_MODEL_CACHE": "/models/sentence-transformers",
            "HF_HOME": "/models/huggingface",
            "SENTENCE_TRANSFORMERS_HOME": "/models/sentence-transformers",
        }
    )
    .add_local_python_source("lumo_ml", "app")
)

app = modal.App("lumo-ml-service")

ml_secret = modal.Secret.from_name("lumo-ml-service")
# Persistent Volume for HF / sentence-transformers model weights.
# `create_if_missing=True` so a fresh workspace bootstraps cleanly;
# subsequent deploys reuse the same Volume.
ml_models = modal.Volume.from_name("lumo-ml-models", create_if_missing=True)


@app.function(
    image=image,
    secrets=[ml_secret],
    volumes={"/models": ml_models},
    # Keep one container warm so /api/health + /plan stay tier-zero on the
    # free CPU pool. Brief target: warm < 200 ms p50. (Modal renamed
    # ``keep_warm`` → ``min_containers`` in 2025-02; brief example
    # predates the rename.)
    min_containers=1,
    timeout=120,
)
@modal.asgi_app()
def asgi():
    from lumo_ml.main import app as fastapi_app
    from lumo_ml.plan.classifier import IntentClassifier

    # Warm the classifier once per container so the first /api/tools/plan
    # request doesn't pay the model-load cost (~2–5 s from the cached
    # Volume; ~30 s if the Volume hasn't yet seen the weights).
    IntentClassifier.get_instance().warmup()

    return fastapi_app
