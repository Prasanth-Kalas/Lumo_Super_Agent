"""ASGI shim that re-exports the FastAPI app from ``lumo_ml.main``.

The capability code lives in :mod:`lumo_ml`. This thin ``app`` package keeps the
historical ``app.main:app`` import path working for Dockerfiles, deploy configs,
and uvicorn invocations that reference it.
"""
