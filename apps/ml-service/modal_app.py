"""Modal App definition for the Lumo Intelligence Layer (FastAPI brain).

Deploy with:
    modal deploy apps/ml-service/modal_app.py

Modal returns a public URL of the form
``https://<workspace-slug>--lumo-ml-service-asgi.modal.run``. That URL is what
the orchestrator (apps/web/) pins as ``LUMO_ML_AGENT_URL`` in Vercel.

Bootstrap the ``lumo-ml-service`` Modal Secret first via
``apps/ml-service/scripts/bootstrap-modal-secrets.sh`` — the function depends
on it for ``LUMO_ML_SERVICE_JWT_SECRET`` (and ``HF_TOKEN`` for HuggingFace
model downloads).

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
    .add_local_python_source("lumo_ml", "app")
)

app = modal.App("lumo-ml-service")

ml_secret = modal.Secret.from_name("lumo-ml-service")


@app.function(
    image=image,
    secrets=[ml_secret],
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

    return fastapi_app
