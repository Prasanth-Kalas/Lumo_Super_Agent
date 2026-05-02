"""BGE-large-en-v1.5 text embedding primitive.

Public API surface (re-exported from :mod:`lumo_ml.core`):

- :data:`ModelVersion` — Literal of model_version strings this module
  emits. Cross-stack contract: vector_store imports the same Literal
  to validate that a vector it stores carries a model_version it
  recognizes.
- :data:`DIMENSIONS` — output dimensionality (always 1024 for
  BGE-large-en-v1.5). vector_store's table column is ``vector(1024)``;
  pgvector raises on length mismatch pre-DB.
- :class:`Embedding` — Pydantic schema carrying a vector + the
  model_version + dimensions + normalized flag.
- :class:`EmbedTextRequest` / :class:`EmbedBatchRequest` — request
  envelopes. ``text`` / ``texts`` carry the ``Secret`` annotation so
  ``model_dump_for_logs`` redacts user input (Layer-A discipline).
- :class:`EmbedTextResponse` / :class:`EmbedBatchResponse` — response
  envelopes. ``tokens_consumed`` is BGE's tokenizer-reported count and
  is the source of truth for the cost calculation.
- :func:`embed_text` / :func:`embed_batch` — async public functions,
  each ``@traced``, each emitting ``record_cost``. Modal-backed via
  :mod:`lumo_ml.modal_bge`.

Design reference: ``apps/ml-service/docs/designs/embedding-service.md``.

Cost basis — ``DOLLARS_PER_M_TOKENS``: synthetic mapping from Modal
T4 list price ($0.000164 / GPU-second) and measured throughput
(~1400 tokens / GPU-second batched) to the dashboard-friendly
"dollars per 1M tokens" units. Drifts with Modal pricing; recurring
recalibration filed as ``EMBEDDING-COST-CALIBRATION-SWEEP-1``.
"""

from __future__ import annotations

import os
from time import monotonic
from typing import Annotated, Any, Literal

from pydantic import BaseModel, Field, field_validator

from .observability import Secret, record_cost, traced

# ──────────────────────────────────────────────────────────────────────
# Cross-stack contract values
# ──────────────────────────────────────────────────────────────────────

ModelVersion = Literal["bge-large-en-v1.5"]
"""Model versions this module emits. Single-value Literal v1; widening
ships via a paired migration on the consumer side (vector_store's
enumerated check constraint) per the reindex playbook in
``apps/ml-service/docs/designs/vector-store.md`` §8."""

DIMENSIONS: int = 1024
"""BGE-large-en-v1.5 output dimensionality. Cross-pinned to
``vector(1024)`` in the consumer's pgvector column."""

DOLLARS_PER_M_TOKENS: float = 0.117
"""Synthetic cost basis. Modal T4 list price * inverse measured
throughput ≈ $0.117 / 1M tokens. Recalibrate via
``EMBEDDING-COST-CALIBRATION-SWEEP-1``."""

_MODEL_NAME = "BAAI/bge-large-en-v1.5"
_OPERATION_TEXT = "embedding.bge_large.embed_text"
_OPERATION_BATCH = "embedding.bge_large.embed_batch"


# ──────────────────────────────────────────────────────────────────────
# Pydantic schemas
# ──────────────────────────────────────────────────────────────────────


class Embedding(BaseModel):
    """A single 1024-d L2-normalized BGE-large-en-v1.5 embedding.

    ``model_version`` is a Literal cross-imported by ``vector_store`` so
    a vector cannot land in storage with a model contract its consumer
    doesn't recognize.
    """

    values: list[float] = Field(..., min_length=DIMENSIONS, max_length=DIMENSIONS)
    model_version: ModelVersion = "bge-large-en-v1.5"
    dimensions: int = DIMENSIONS
    normalized: bool = True


class EmbedTextRequest(BaseModel):
    text: Annotated[str, Secret] = Field(..., min_length=1, max_length=8192)
    instruction: str | None = Field(None, max_length=512)

    @field_validator("text")
    @classmethod
    def _no_whitespace_only(cls, v: str) -> str:
        if not v.strip():
            raise ValueError("text must not be empty / whitespace-only")
        return v


class EmbedBatchRequest(BaseModel):
    texts: list[Annotated[str, Secret]] = Field(..., min_length=1, max_length=64)
    instruction: str | None = Field(None, max_length=512)

    @field_validator("texts")
    @classmethod
    def _no_empty_items(cls, v: list[str]) -> list[str]:
        for idx, text in enumerate(v):
            if not isinstance(text, str):
                raise ValueError(f"texts[{idx}] is not a string")
            if not text.strip():
                raise ValueError(f"texts[{idx}] must not be empty / whitespace-only")
            if len(text) > 8192:
                raise ValueError(f"texts[{idx}] exceeds 8192 chars")
        return v


class EmbedTextResponse(BaseModel):
    embedding: Embedding
    tokens_consumed: int = Field(..., ge=0)
    dollars_estimated: float = Field(..., ge=0.0)


class EmbedBatchResponse(BaseModel):
    embeddings: list[Embedding]
    tokens_consumed: int = Field(..., ge=0)
    dollars_estimated: float = Field(..., ge=0.0)


# ──────────────────────────────────────────────────────────────────────
# Modal runner accessor
# ──────────────────────────────────────────────────────────────────────


def _load_modal_runner() -> Any | None:
    """Resolve the Modal-hosted ``embed_batch_remote`` function, or
    return ``None`` if Modal is not configured (local dev / CI without
    Modal credentials). Mirrors the pattern in
    :mod:`lumo_ml.image_embedding`.
    """
    if not (os.getenv("MODAL_TOKEN_ID") and os.getenv("MODAL_TOKEN_SECRET")):
        return None
    try:
        from ..modal_bge import embed_batch_remote
    except Exception:
        return None
    return embed_batch_remote


# ──────────────────────────────────────────────────────────────────────
# Public surface — async embed_text / embed_batch
# ──────────────────────────────────────────────────────────────────────


@traced(_OPERATION_TEXT)
async def embed_text(req: EmbedTextRequest) -> EmbedTextResponse:
    """Embed a single text string.

    Implemented as a length-1 :func:`embed_batch` under the hood — one
    code path on the GPU, two ergonomic shapes for callers. Always
    emits ``record_cost`` (success or failure).
    """
    batch_resp = await embed_batch(
        EmbedBatchRequest(texts=[req.text], instruction=req.instruction)
    )
    return EmbedTextResponse(
        embedding=batch_resp.embeddings[0],
        tokens_consumed=batch_resp.tokens_consumed,
        dollars_estimated=batch_resp.dollars_estimated,
    )


@traced(_OPERATION_BATCH)
async def embed_batch(req: EmbedBatchRequest) -> EmbedBatchResponse:
    """Embed a batch of texts (1..64 entries).

    Modal serves the inference; this wrapper handles validation +
    telemetry. ``record_cost`` always fires — successful calls report
    ``tokens_consumed`` + ``dollars_estimated``; failed calls report
    ``embedding_ops=len(texts)``, ``dollars_estimated=0.0``, and
    ``metadata={"status": "failed"}`` so the cost dashboard sees the
    GPU-seconds spent on failed inferences.
    """
    runner = _load_modal_runner()
    if runner is None:
        raise RuntimeError(
            "BGE embedding requires Modal credentials (MODAL_TOKEN_ID + "
            "MODAL_TOKEN_SECRET) in the environment; got none."
        )

    started = monotonic()
    try:
        payload = await runner.remote.aio(
            list(req.texts),
            req.instruction,
        )
    except Exception as exc:
        elapsed = monotonic() - started
        record_cost(
            "embedding.bge_large",
            embedding_ops=len(req.texts),
            gpu_seconds=elapsed,
            dollars_estimated=0.0,
            metadata={
                "batch_size": len(req.texts),
                "model_version": "bge-large-en-v1.5",
                "instruction_prefix": bool(req.instruction),
                "status": "failed",
                "error": type(exc).__name__,
            },
        )
        raise

    elapsed = monotonic() - started
    response = _normalize_modal_payload(payload, req)
    record_cost(
        "embedding.bge_large",
        embedding_ops=len(req.texts),
        gpu_seconds=elapsed,
        dollars_estimated=response.dollars_estimated,
        metadata={
            "batch_size": len(req.texts),
            "model_version": "bge-large-en-v1.5",
            "instruction_prefix": bool(req.instruction),
            "tokens_consumed": response.tokens_consumed,
            "status": "ok",
        },
    )
    return response


# ──────────────────────────────────────────────────────────────────────
# Internals
# ──────────────────────────────────────────────────────────────────────


def _normalize_modal_payload(
    payload: Any, req: EmbedBatchRequest
) -> EmbedBatchResponse:
    if not isinstance(payload, dict):
        raise ValueError("modal_bge returned a malformed payload (not a dict)")
    raw_embeddings = payload.get("embeddings")
    if not isinstance(raw_embeddings, list) or len(raw_embeddings) != len(req.texts):
        raise ValueError(
            "modal_bge returned an unexpected number of embeddings: "
            f"{len(raw_embeddings) if isinstance(raw_embeddings, list) else 'N/A'} "
            f"vs requested {len(req.texts)}"
        )
    tokens_consumed = int(payload.get("tokens_consumed", 0))
    dollars_estimated = round(
        tokens_consumed * DOLLARS_PER_M_TOKENS / 1_000_000, 9
    )
    embeddings = [
        Embedding(values=list(vec))
        for vec in raw_embeddings
    ]
    return EmbedBatchResponse(
        embeddings=embeddings,
        tokens_consumed=tokens_consumed,
        dollars_estimated=dollars_estimated,
    )
