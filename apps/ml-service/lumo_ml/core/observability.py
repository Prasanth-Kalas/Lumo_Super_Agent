"""Tracing + cost-record + Secret-marker primitives.

Public API surface (re-exported from :mod:`lumo_ml.core`):

- :func:`traced` — decorator wrapping any sync or async function
  with span creation. The only tracing primitive most lanes need.
- :func:`record_cost` — emits a cost-record event on the active
  span. Codex's plan-client logger reads these and persists rows
  in ``agent_cost_records``.
- :data:`Secret` — Pydantic ``Annotated`` marker; presence in
  field metadata tells :func:`model_dump_for_logs` to redact.
- :func:`model_dump_for_logs` — Pydantic-aware serializer that
  walks model fields and replaces every ``Secret``-annotated value
  with ``"***REDACTED***"``.

Design reference: ``apps/ml-service/docs/designs/observability-
platform.md`` §1, §3, §6.

The OTel SDK is initialized in :mod:`lumo_ml.core.otel_setup`
during FastAPI app construction. Until then ``trace.get_tracer``
returns the no-op tracer; ``@traced`` works on the no-op too, so
unit tests don't need a real exporter.
"""

from __future__ import annotations

import functools
import inspect
import logging
import re
from typing import Any, Callable, ClassVar, TypeVar, cast

from opentelemetry import trace
from opentelemetry.trace import Span, Status, StatusCode
from pydantic import BaseModel

_log = logging.getLogger(__name__)

_REDACTED = "***REDACTED***"

F = TypeVar("F", bound=Callable[..., Any])


# ──────────────────────────────────────────────────────────────────────
# Secret marker — Layer A redaction
# ──────────────────────────────────────────────────────────────────────


class _SecretMarker:
    """Sentinel placed in a Pydantic field's ``Annotated`` metadata.

    A field declared as ``Annotated[str, Secret]`` retains its full
    value during normal Pydantic operation (validation, model_dump,
    JSON serialization to the wire). Only :func:`model_dump_for_logs`
    walks the schema and replaces ``Secret``-annotated values with
    ``"***REDACTED***"`` — the result is intended exclusively for
    log lines and span attributes.

    This is Layer A of the redaction stack. Layer B (regex scrubber
    in the OTel export pipeline) catches everything Layer A misses
    — see :mod:`lumo_ml.core.pii_redaction`.
    """

    _instance: ClassVar["_SecretMarker | None"] = None

    def __new__(cls) -> "_SecretMarker":
        if cls._instance is None:
            cls._instance = super().__new__(cls)
        return cls._instance

    def __repr__(self) -> str:
        return "Secret"


Secret = _SecretMarker()


def _is_secret_annotated(field_info: Any) -> bool:
    """Return ``True`` iff a Pydantic ``FieldInfo`` carries the
    ``Secret`` marker in its metadata. Pydantic v2 stores
    ``Annotated`` extras in ``field_info.metadata``."""
    metadata = getattr(field_info, "metadata", None) or ()
    for entry in metadata:
        if entry is Secret or isinstance(entry, _SecretMarker):
            return True
    return False


def model_dump_for_logs(model: BaseModel) -> dict[str, Any]:
    """Return a dict suitable for embedding in a log message or span
    attribute. ``Secret``-annotated fields are replaced with
    ``"***REDACTED***"``; nested ``BaseModel`` instances are
    recursively walked; lists/dicts are walked element-wise.

    Use this anywhere you'd otherwise pass a ``BaseModel`` to a
    logger or stuff it into a span. ``f"{model}"`` and
    ``logger.info(model)`` both bypass this and rely on Layer B —
    don't depend on that.
    """
    return _walk(model)


def _walk(obj: Any, *, parent_field_secret: bool = False) -> Any:
    if parent_field_secret:
        return _REDACTED if obj is not None else None
    if isinstance(obj, BaseModel):
        out: dict[str, Any] = {}
        for name, field_info in obj.__class__.model_fields.items():
            value = getattr(obj, name)
            field_secret = _is_secret_annotated(field_info)
            out[name] = _walk(value, parent_field_secret=field_secret)
        return out
    if isinstance(obj, dict):
        return {k: _walk(v) for k, v in obj.items()}
    if isinstance(obj, (list, tuple, set)):
        return [_walk(v) for v in obj]
    return obj


# ──────────────────────────────────────────────────────────────────────
# @traced decorator
# ──────────────────────────────────────────────────────────────────────


def traced(operation_name: str, **default_attrs: Any) -> Callable[[F], F]:
    """Decorator that wraps a function in an OTel span.

    Usage::

        @traced("classifier.classify", model="all-MiniLM-L6-v2")
        def classify(self, msg: str) -> IntentClassification:
            ...

    Behaviour:

    - Creates a child span of the current trace context. If no
      context is active, starts a fresh trace.
    - Span name is ``operation_name``. ``default_attrs`` are set on
      the span at start time; runtime ``record_cost`` calls add
      additional attributes.
    - On exception, span status is set to ``ERROR`` and the
      exception is recorded; the exception still propagates to the
      caller.
    - SDK errors at span-start are swallowed and the wrapped
      function still runs untraced (per design Q11.11). Tracing
      must never break business logic.
    - Sync and async functions both supported; the wrapper picks
      the right shape via :func:`inspect.iscoroutinefunction`.
    """

    def decorator(fn: F) -> F:
        attrs = {"lumo.operation": operation_name, **default_attrs}

        if inspect.iscoroutinefunction(fn):

            @functools.wraps(fn)
            async def async_wrapper(*args: Any, **kwargs: Any) -> Any:
                tracer = trace.get_tracer(__name__)
                try:
                    span_cm = tracer.start_as_current_span(
                        operation_name, attributes=attrs,
                    )
                except Exception as exc:  # noqa: BLE001
                    _log.warning("traced(%s) start failed: %s", operation_name, exc)
                    return await fn(*args, **kwargs)

                with span_cm as span:
                    try:
                        return await fn(*args, **kwargs)
                    except Exception as exc:
                        _mark_span_error(span, exc)
                        raise

            return cast(F, async_wrapper)

        @functools.wraps(fn)
        def sync_wrapper(*args: Any, **kwargs: Any) -> Any:
            tracer = trace.get_tracer(__name__)
            try:
                span_cm = tracer.start_as_current_span(
                    operation_name, attributes=attrs,
                )
            except Exception as exc:  # noqa: BLE001
                _log.warning("traced(%s) start failed: %s", operation_name, exc)
                return fn(*args, **kwargs)

            with span_cm as span:
                try:
                    return fn(*args, **kwargs)
                except Exception as exc:
                    _mark_span_error(span, exc)
                    raise

        return cast(F, sync_wrapper)

    return decorator


def _mark_span_error(span: Span, exc: BaseException) -> None:
    try:
        span.set_status(Status(StatusCode.ERROR, type(exc).__name__))
        # ``record_exception`` captures the traceback; the Layer-B
        # scrubber runs on its body before export.
        span.record_exception(exc)
    except Exception:  # noqa: BLE001
        # Tracing must never break business logic.
        pass




# ──────────────────────────────────────────────────────────────────────
# record_cost — span-attached cost event
# ──────────────────────────────────────────────────────────────────────


def record_cost(
    operation: str,
    *,
    tokens_in: int = 0,
    tokens_out: int = 0,
    embedding_ops: int = 0,
    gpu_seconds: float = 0.0,
    dollars_estimated: float = 0.0,
    metadata: dict[str, Any] | None = None,
) -> None:
    """Emit a cost record on the active span.

    The values are attached as span attributes (``lumo.cost.*``) and
    also as a structured event ``lumo.cost.record`` so codex's plan-
    client logger can consume them and write rows to
    ``agent_cost_records``.

    Brief: every LLM/embedding/GPU call site MUST call this. CI lint
    will eventually enforce it (filed as ``OBSERVABILITY-LINT-COST-
    COVERAGE-1``).
    """
    if not _is_valid_operation(operation):
        _log.warning("record_cost: invalid operation %r", operation)
        return

    span = trace.get_current_span()
    if span is None or not span.is_recording():
        # No active span (called outside a traced function) — drop
        # silently. Caller has no recovery path, and falsifying a
        # parent span would mask the bug.
        return

    try:
        span.set_attribute(f"lumo.cost.{operation}.tokens_in", int(tokens_in))
        span.set_attribute(f"lumo.cost.{operation}.tokens_out", int(tokens_out))
        span.set_attribute(f"lumo.cost.{operation}.embedding_ops", int(embedding_ops))
        span.set_attribute(f"lumo.cost.{operation}.gpu_seconds", float(gpu_seconds))
        span.set_attribute(
            f"lumo.cost.{operation}.dollars_estimated", float(dollars_estimated),
        )
        event_attrs: dict[str, Any] = {
            "lumo.cost.operation": operation,
            "lumo.cost.tokens_in": int(tokens_in),
            "lumo.cost.tokens_out": int(tokens_out),
            "lumo.cost.embedding_ops": int(embedding_ops),
            "lumo.cost.gpu_seconds": float(gpu_seconds),
            "lumo.cost.dollars_estimated": float(dollars_estimated),
        }
        if metadata:
            for key, value in metadata.items():
                event_attrs[f"lumo.cost.metadata.{key}"] = value
        span.add_event("lumo.cost.record", attributes=event_attrs)
    except Exception as exc:  # noqa: BLE001
        _log.warning("record_cost(%s) emit failed: %s", operation, exc)


_OPERATION_RE = re.compile(r"^[a-z][a-z0-9_.]{2,79}$")


def _is_valid_operation(operation: str) -> bool:
    return bool(_OPERATION_RE.match(operation))
