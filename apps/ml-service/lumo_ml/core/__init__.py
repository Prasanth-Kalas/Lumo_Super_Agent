"""Cross-cutting infrastructure imported by every ``lumo_ml`` module.

Public surface:

- :func:`traced` — decorator that wraps any sync or async function
  with OpenTelemetry span creation. The only tracing primitive new
  lanes need to learn.
- :func:`record_cost` — emit a cost-record event on the active span.
  Codex's plan-client logger reads these and persists rows in
  ``agent_cost_records``.
- :data:`Secret` — Pydantic ``Annotated`` marker that redacts a
  field's value in :func:`model_dump_for_logs`.
- :func:`model_dump_for_logs` — Pydantic-aware serializer that
  replaces every ``Secret``-annotated field with ``"***REDACTED***"``.
- :func:`init_observability` — one-shot SDK + middleware
  initialization called from :mod:`lumo_ml.main`.

See ``apps/ml-service/docs/designs/observability-platform.md`` for
the full design and ``apps/ml-service/CONTRIBUTING.md`` for the
discipline rule (every public function gets ``@traced``; every
LLM/embedding/GPU call records cost).
"""

from .embeddings import (
    DIMENSIONS,
    DOLLARS_PER_M_TOKENS,
    EmbedBatchRequest,
    EmbedBatchResponse,
    Embedding,
    EmbedTextRequest,
    EmbedTextResponse,
    ModelVersion,
    embed_batch,
    embed_text,
)
from .observability import (
    Secret,
    model_dump_for_logs,
    record_cost,
    traced,
)
from .otel_setup import init_observability

__all__ = [
    "DIMENSIONS",
    "DOLLARS_PER_M_TOKENS",
    "EmbedBatchRequest",
    "EmbedBatchResponse",
    "EmbedTextRequest",
    "EmbedTextResponse",
    "Embedding",
    "ModelVersion",
    "Secret",
    "embed_batch",
    "embed_text",
    "init_observability",
    "model_dump_for_logs",
    "record_cost",
    "traced",
]
