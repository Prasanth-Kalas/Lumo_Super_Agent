"""Tests for the BGE-large-en-v1.5 text embedding primitive.

Covers:

* Pydantic schema contract — ``model_version`` Literal, dimensions
  enforcement, whitespace-only rejection, batch cap, instruction
  prefix.
* ``record_cost`` emission on the success path — operation name,
  embedding_ops count, dollars_estimated derived from
  ``DOLLARS_PER_M_TOKENS`` and tokens_consumed, metadata fields.
* ``record_cost`` emission on the failure path — same operation,
  ``dollars_estimated=0.0``, ``metadata.status="failed"``.
* Modal-unavailable path raises ``RuntimeError`` cleanly.
* ``embed_text`` round-trips through ``embed_batch`` (length-1).
* Spans observed via :class:`InMemorySpanExporter` — both
  ``embedding.bge_large.embed_text`` and
  ``embedding.bge_large.embed_batch`` operations.

The Modal runner is mocked via monkeypatch on
:func:`lumo_ml.core.embeddings._load_modal_runner` so tests run
without Modal credentials and without network.
"""

from __future__ import annotations

import asyncio
import os
from typing import Any

os.environ.setdefault("LUMO_ML_SERVICE_JWT_SECRET", "test-secret-with-at-least-thirty-two-bytes")

import pytest  # noqa: E402
from opentelemetry import trace  # noqa: E402
from opentelemetry.sdk.trace import TracerProvider  # noqa: E402
from opentelemetry.sdk.trace.export import SimpleSpanProcessor  # noqa: E402
from opentelemetry.sdk.trace.export.in_memory_span_exporter import (  # noqa: E402
    InMemorySpanExporter,
)
from pydantic import ValidationError  # noqa: E402

from lumo_ml.core import (  # noqa: E402
    DIMENSIONS,
    DOLLARS_PER_M_TOKENS,
    EmbedBatchRequest,
    EmbedBatchResponse,
    Embedding,
    EmbedTextRequest,
    EmbedTextResponse,
    embed_batch,
    embed_text,
    model_dump_for_logs,
)
from lumo_ml.core import embeddings as embeddings_module  # noqa: E402

# ──────────────────────────────────────────────────────────────────────
# Span exporter fixture — same shape as test_observability.py
# ──────────────────────────────────────────────────────────────────────


@pytest.fixture
def captured_spans() -> InMemorySpanExporter:
    provider = trace.get_tracer_provider()
    if not isinstance(provider, TracerProvider):
        provider = TracerProvider()
        trace.set_tracer_provider(provider)
    exporter = InMemorySpanExporter()
    processor = SimpleSpanProcessor(exporter)
    provider.add_span_processor(processor)
    yield exporter
    provider.force_flush()
    exporter.clear()


# ──────────────────────────────────────────────────────────────────────
# Mock Modal runner
# ──────────────────────────────────────────────────────────────────────


class _FakeRemote:
    """Mimics Modal's ``Function.remote`` shape — exposes ``.aio``
    for async-call sites. Records every call for assertions."""

    def __init__(
        self,
        *,
        embeddings: list[list[float]] | None = None,
        tokens: int = 100,
        raise_exc: type[BaseException] | None = None,
    ) -> None:
        self.embeddings = embeddings
        self.tokens = tokens
        self.raise_exc = raise_exc
        self.calls: list[tuple[list[str], str | None]] = []

    async def aio(self, texts: list[str], instruction: str | None) -> dict[str, Any]:
        self.calls.append((list(texts), instruction))
        if self.raise_exc is not None:
            raise self.raise_exc("mock failure")
        embeddings = self.embeddings or [
            [0.0] * (DIMENSIONS - 1) + [1.0] for _ in texts
        ]
        return {
            "embeddings": embeddings,
            "dimensions": DIMENSIONS,
            "model": "BAAI/bge-large-en-v1.5",
            "tokens_consumed": self.tokens,
        }


class _FakeRunner:
    def __init__(self, fake_remote: _FakeRemote) -> None:
        self.remote = fake_remote


def _patch_runner(monkeypatch: pytest.MonkeyPatch, runner: _FakeRunner | None) -> None:
    monkeypatch.setattr(embeddings_module, "_load_modal_runner", lambda: runner)


# ──────────────────────────────────────────────────────────────────────
# Schema contract
# ──────────────────────────────────────────────────────────────────────


def test_embedding_dimensions_enforced_both_directions() -> None:
    short = [0.0] * (DIMENSIONS - 1)
    with pytest.raises(ValidationError):
        Embedding(values=short)
    long = [0.0] * (DIMENSIONS + 1)
    with pytest.raises(ValidationError):
        Embedding(values=long)


def test_embedding_model_version_rejects_unknown_literal() -> None:
    with pytest.raises(ValidationError):
        Embedding(
            values=[0.0] * DIMENSIONS,
            model_version="bge-base-en-v1.5",  # type: ignore[arg-type]
        )


def test_embedding_normalized_field_defaults_true() -> None:
    e = Embedding(values=[0.0] * DIMENSIONS)
    assert e.normalized is True
    assert e.dimensions == DIMENSIONS
    assert e.model_version == "bge-large-en-v1.5"


def test_embed_text_request_rejects_whitespace_only() -> None:
    with pytest.raises(ValidationError):
        EmbedTextRequest(text="   \t\n  ")


def test_embed_text_request_rejects_oversize_input() -> None:
    with pytest.raises(ValidationError):
        EmbedTextRequest(text="x" * 8193)


def test_embed_batch_request_enforces_cap() -> None:
    too_many = ["hello"] * 65
    with pytest.raises(ValidationError):
        EmbedBatchRequest(texts=too_many)


def test_embed_batch_request_rejects_empty_list() -> None:
    with pytest.raises(ValidationError):
        EmbedBatchRequest(texts=[])


def test_embed_batch_request_rejects_whitespace_in_any_item() -> None:
    with pytest.raises(ValidationError):
        EmbedBatchRequest(texts=["valid", "  ", "also valid"])


def test_text_field_is_secret_marked_for_log_redaction() -> None:
    """The ``Annotated[str, Secret]`` marker means
    ``model_dump_for_logs`` redacts the user-input text."""
    req = EmbedTextRequest(text="user query about flights to Tokyo")
    safe = model_dump_for_logs(req)
    assert safe["text"] == "***REDACTED***"
    assert safe["instruction"] is None


# ──────────────────────────────────────────────────────────────────────
# embed_batch — success path
# ──────────────────────────────────────────────────────────────────────


def _run(coro):
    return asyncio.get_event_loop().run_until_complete(coro) if False else asyncio.run(coro)


def test_embed_batch_returns_well_formed_response(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    fake_remote = _FakeRemote(tokens=42)
    _patch_runner(monkeypatch, _FakeRunner(fake_remote))

    resp = _run(embed_batch(EmbedBatchRequest(texts=["a", "b", "c"])))

    assert isinstance(resp, EmbedBatchResponse)
    assert len(resp.embeddings) == 3
    assert all(isinstance(e, Embedding) for e in resp.embeddings)
    assert all(e.dimensions == DIMENSIONS for e in resp.embeddings)
    assert resp.tokens_consumed == 42
    expected_dollars = round(42 * DOLLARS_PER_M_TOKENS / 1_000_000, 9)
    assert resp.dollars_estimated == pytest.approx(expected_dollars)
    assert fake_remote.calls == [(["a", "b", "c"], None)]


def test_embed_batch_passes_instruction_to_runner(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    fake_remote = _FakeRemote()
    _patch_runner(monkeypatch, _FakeRunner(fake_remote))

    instruction = "Represent this sentence for retrieval"
    _run(
        embed_batch(EmbedBatchRequest(texts=["query"], instruction=instruction))
    )

    assert fake_remote.calls == [(["query"], instruction)]


def test_embed_batch_records_cost_on_success(
    monkeypatch: pytest.MonkeyPatch,
    captured_spans: InMemorySpanExporter,
) -> None:
    fake_remote = _FakeRemote(tokens=200)
    _patch_runner(monkeypatch, _FakeRunner(fake_remote))

    _run(
        embed_batch(EmbedBatchRequest(texts=["x", "y"], instruction="ctx"))
    )

    spans = captured_spans.get_finished_spans()
    batch_spans = [s for s in spans if s.name == "embedding.bge_large.embed_batch"]
    assert batch_spans, f"expected an embed_batch span, got {[s.name for s in spans]}"
    span = batch_spans[-1]
    cost_events = [e for e in span.events if e.name == "lumo.cost.record"]
    assert cost_events, f"expected a lumo.cost.record event, got {[e.name for e in span.events]}"
    attrs = dict(cost_events[-1].attributes or {})
    assert attrs["lumo.cost.operation"] == "embedding.bge_large"
    assert attrs["lumo.cost.embedding_ops"] == 2
    assert attrs["lumo.cost.metadata.batch_size"] == 2
    assert attrs["lumo.cost.metadata.model_version"] == "bge-large-en-v1.5"
    assert attrs["lumo.cost.metadata.instruction_prefix"] is True
    assert attrs["lumo.cost.metadata.tokens_consumed"] == 200
    assert attrs["lumo.cost.metadata.status"] == "ok"
    expected_dollars = 200 * DOLLARS_PER_M_TOKENS / 1_000_000
    assert attrs["lumo.cost.dollars_estimated"] == pytest.approx(expected_dollars)


# ──────────────────────────────────────────────────────────────────────
# embed_batch — failure path
# ──────────────────────────────────────────────────────────────────────


def test_embed_batch_records_cost_on_failure_and_re_raises(
    monkeypatch: pytest.MonkeyPatch,
    captured_spans: InMemorySpanExporter,
) -> None:
    fake_remote = _FakeRemote(raise_exc=TimeoutError)
    _patch_runner(monkeypatch, _FakeRunner(fake_remote))

    with pytest.raises(TimeoutError):
        _run(embed_batch(EmbedBatchRequest(texts=["fail-me"])))

    spans = captured_spans.get_finished_spans()
    batch_spans = [s for s in spans if s.name == "embedding.bge_large.embed_batch"]
    assert batch_spans
    span = batch_spans[-1]
    cost_events = [e for e in span.events if e.name == "lumo.cost.record"]
    assert cost_events
    attrs = dict(cost_events[-1].attributes or {})
    assert attrs["lumo.cost.dollars_estimated"] == 0.0
    assert attrs["lumo.cost.metadata.status"] == "failed"
    assert attrs["lumo.cost.metadata.error"] == "TimeoutError"


def test_embed_batch_raises_when_modal_unconfigured(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _patch_runner(monkeypatch, None)
    with pytest.raises(RuntimeError, match="Modal credentials"):
        _run(embed_batch(EmbedBatchRequest(texts=["x"])))


def test_embed_batch_rejects_malformed_modal_payload(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """If Modal returns a payload with the wrong number of vectors, the
    wrapper raises a clear ``ValueError`` rather than letting the bad
    response propagate as an ``IndexError`` at the call site.
    """
    fake_remote = _FakeRemote(embeddings=[[0.0] * DIMENSIONS])  # 1 vec for 2 inputs
    _patch_runner(monkeypatch, _FakeRunner(fake_remote))

    with pytest.raises(ValueError, match="unexpected number of embeddings"):
        _run(embed_batch(EmbedBatchRequest(texts=["a", "b"])))


# ──────────────────────────────────────────────────────────────────────
# embed_text — round-trips through embed_batch
# ──────────────────────────────────────────────────────────────────────


def test_embed_text_routes_through_embed_batch_and_emits_both_spans(
    monkeypatch: pytest.MonkeyPatch,
    captured_spans: InMemorySpanExporter,
) -> None:
    fake_remote = _FakeRemote(tokens=14)
    _patch_runner(monkeypatch, _FakeRunner(fake_remote))

    resp = _run(embed_text(EmbedTextRequest(text="single query")))

    assert isinstance(resp, EmbedTextResponse)
    assert resp.embedding.dimensions == DIMENSIONS
    assert resp.embedding.model_version == "bge-large-en-v1.5"
    assert resp.tokens_consumed == 14
    assert fake_remote.calls == [(["single query"], None)]

    span_names = {s.name for s in captured_spans.get_finished_spans()}
    assert "embedding.bge_large.embed_text" in span_names
    assert "embedding.bge_large.embed_batch" in span_names


def test_embed_text_request_passes_instruction_through(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    fake_remote = _FakeRemote()
    _patch_runner(monkeypatch, _FakeRunner(fake_remote))

    instruction = "for-retrieval"
    _run(embed_text(EmbedTextRequest(text="hi", instruction=instruction)))

    assert fake_remote.calls == [(["hi"], instruction)]
