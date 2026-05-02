"""OpenTelemetry SDK initialization + FastAPI middleware wiring.

Design reference: ``apps/ml-service/docs/designs/observability-
platform.md`` §1, §2, §5. Single public function:
:func:`init_observability` — call once at FastAPI app construction.

When ``LUMO_OTEL_ENDPOINT`` is unset, the SDK is initialized with a
no-op exporter so traces still get created (for in-process span
hierarchy / tests) but nothing leaves the process. This makes local
dev work without Honeycomb credentials and CI runs cheap.

When set, an OTLP HTTP exporter pushes traces to the configured
endpoint (Honeycomb default: ``https://api.honeycomb.io``).
``LUMO_OTEL_HEADERS`` carries vendor-specific auth (Honeycomb's
``x-honeycomb-team`` API key). Both go in the ``lumo-ml-service``
Modal Secret per the bootstrap script.
"""

from __future__ import annotations

import logging
import os
from typing import Any

from fastapi import FastAPI
from opentelemetry import trace
from opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter
from opentelemetry.instrumentation.fastapi import FastAPIInstrumentor
from opentelemetry.sdk.resources import SERVICE_NAME, SERVICE_VERSION, Resource
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import BatchSpanProcessor

from .pii_redaction import StdlibLoggingPiiFilter

_log = logging.getLogger(__name__)

_initialized: bool = False


def init_observability(app: FastAPI, *, service_version: str = "0.1.0") -> None:
    """Initialize OTel SDK + FastAPI auto-instrumentation + Layer-B
    scrubber on the stdlib logger root. Idempotent — safe to call
    twice (subsequent calls no-op).

    Reads ``LUMO_OTEL_ENDPOINT`` and ``LUMO_OTEL_HEADERS`` from env.
    Empty / unset endpoint → SDK initialized with no-op exporter so
    span context still propagates correctly through call sites.
    """
    global _initialized
    if _initialized:
        return

    try:
        _setup_tracer_provider(service_version=service_version)
    except Exception as exc:  # noqa: BLE001
        _log.warning("OTel TracerProvider init failed: %s", exc)
        # Fall through — we still want the FastAPI instrumentation
        # and the stdlib logger filter to attach.

    try:
        FastAPIInstrumentor.instrument_app(app)
    except Exception as exc:  # noqa: BLE001
        _log.warning("FastAPI auto-instrumentation failed: %s", exc)

    _attach_stdlib_logger_filter()
    _initialized = True


def _setup_tracer_provider(*, service_version: str) -> None:
    resource = Resource.create({
        SERVICE_NAME: "lumo-ml-service",
        SERVICE_VERSION: service_version,
        "lumo.service": "ml-service",
    })
    provider = TracerProvider(resource=resource)
    trace.set_tracer_provider(provider)

    endpoint = os.environ.get("LUMO_OTEL_ENDPOINT", "").strip()
    if not endpoint:
        # No exporter wired — spans still created and propagate
        # through context managers; just nothing leaves the process.
        # This is the local-dev / unconfigured-CI mode.
        _log.info("LUMO_OTEL_ENDPOINT unset; OTel exporter is no-op")
        return

    exporter_kwargs: dict[str, Any] = {
        "endpoint": _resolve_traces_endpoint(endpoint),
    }
    headers = _parse_headers_env(os.environ.get("LUMO_OTEL_HEADERS", ""))
    if headers:
        exporter_kwargs["headers"] = headers

    exporter = OTLPSpanExporter(**exporter_kwargs)
    # BatchSpanProcessor batches ~10 spans or 5s of buffering, fire-
    # and-forget. Failures inside the exporter never propagate to
    # the request-handling thread.
    provider.add_span_processor(BatchSpanProcessor(exporter))


def _resolve_traces_endpoint(endpoint: str) -> str:
    """OTel HTTP exporter expects the full path to the traces
    endpoint. Honeycomb publishes ``api.honeycomb.io`` as the base;
    its OTel HTTP path is ``/v1/traces``. If the env already includes
    a path (custom deployment, Tempo, etc.) we trust it."""
    endpoint = endpoint.rstrip("/")
    if endpoint.endswith("/v1/traces"):
        return endpoint
    return f"{endpoint}/v1/traces"


def _parse_headers_env(raw: str) -> dict[str, str]:
    """OTel convention: ``LUMO_OTEL_HEADERS`` is a comma-separated
    list of ``key=value`` pairs. Honeycomb wants
    ``x-honeycomb-team=<api_key>``."""
    headers: dict[str, str] = {}
    for part in raw.split(","):
        part = part.strip()
        if not part or "=" not in part:
            continue
        key, _, value = part.partition("=")
        headers[key.strip()] = value.strip()
    return headers


def _attach_stdlib_logger_filter() -> None:
    """Install :class:`StdlibLoggingPiiFilter` on the root logger so
    every ``logging.getLogger(...)`` call gets Layer-B scrubbing."""
    root = logging.getLogger()
    if any(isinstance(f, StdlibLoggingPiiFilter) for f in root.filters):
        return
    root.addFilter(StdlibLoggingPiiFilter())
