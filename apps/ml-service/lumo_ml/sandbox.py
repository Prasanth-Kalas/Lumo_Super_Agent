from __future__ import annotations

import hashlib
import json
import logging
import os
import re
import time
from collections.abc import Callable
from typing import Any

from .auth import AuthContext
from .schemas import PythonSandboxRequest, PythonSandboxResponse

logger = logging.getLogger("lumo_ml.sandbox")

RUNTIME = "e2b-code-interpreter"
NETWORK_BLOCKLIST = re.compile(
    r"\b("
    r"requests|httpx|urllib|socket|aiohttp|ftplib|smtplib|telnetlib|websocket|"
    r"subprocess|os\.system|popen|curl|wget|nc|netcat|ssh|scp"
    r")\b",
    re.IGNORECASE,
)


def sandbox_upstream_health() -> dict[str, str]:
    if not _e2b_api_key():
        return {
            "status": "unconfigured",
            "last_error": "E2B_API_KEY env var not set",
        }
    if not _sdk_available():
        return {
            "status": "degraded",
            "last_error": "e2b-code-interpreter package is not installed",
        }
    return {"status": "ok"}


def run_python_sandbox(
    req: PythonSandboxRequest,
    auth: AuthContext | None = None,
    *,
    sandbox_factory: Callable[[], Any] | None = None,
) -> PythonSandboxResponse:
    started = time.perf_counter()
    code_hash = _sha256(req.code)
    user_id = auth.user_id if auth else "unknown"
    request_id = auth.request_id if auth else "unknown"

    def finish(response: PythonSandboxResponse) -> PythonSandboxResponse:
        _audit_sandbox_invocation(
            {
                "event": "sandbox_invocation",
                "user_id": user_id,
                "request_id": request_id,
                "code_hash": code_hash,
                "file_hashes": [],
                "runtime": RUNTIME,
                "network_policy": req.network_policy,
                "timeout_seconds": req.timeout_seconds,
                "result_status": response.status,
                "duration_ms": response.duration_ms,
            }
        )
        return response

    if not _e2b_api_key():
        return finish(
            PythonSandboxResponse(
                status="not_configured",
                stdout="",
                stderr="E2B_API_KEY not set",
                duration_ms=_elapsed_ms(started),
                artifacts=[],
                _lumo_summary="Python sandbox is not configured yet.",
            )
        )

    if req.network_policy != "disabled":
        return finish(
            PythonSandboxResponse(
                status="denied",
                stdout="",
                stderr="Only network_policy='disabled' is supported for sandbox execution.",
                duration_ms=_elapsed_ms(started),
                artifacts=[],
                _lumo_summary="Python sandbox request was denied because network allowlists are not enabled.",
            )
        )

    blocked = _blocked_network_reference(req.code)
    if blocked:
        return finish(
            PythonSandboxResponse(
                status="denied",
                stdout="",
                stderr=f"Network-capable code is blocked while network_policy='disabled': {blocked}",
                duration_ms=_elapsed_ms(started),
                artifacts=[],
                _lumo_summary="Python sandbox request was denied by the network policy guard.",
            )
        )

    sandbox: Any | None = None
    try:
        factory = sandbox_factory or _create_e2b_sandbox
        sandbox = factory()
        execution = sandbox.run_code(
            req.code,
            timeout=req.timeout_seconds,
            request_timeout=req.timeout_seconds + 5,
        )
        stdout = _execution_stdout(execution)
        stderr = _execution_stderr(execution)
        error = getattr(execution, "error", None)
        if error is not None:
            stderr = _join_nonempty([stderr, _execution_error_text(error)])
        status = "error" if error is not None else "ok"
        return finish(
            PythonSandboxResponse(
                status=status,
                stdout=_cap(stdout),
                stderr=_cap(stderr),
                duration_ms=_elapsed_ms(started),
                artifacts=_execution_artifacts(execution),
                _lumo_summary=(
                    "Python sandbox finished with an error."
                    if status == "error"
                    else "Python sandbox finished successfully."
                ),
            )
        )
    except Exception as exc:  # noqa: BLE001 - SDK errors vary by version.
        status = "timeout" if _looks_like_timeout(exc) else "error"
        return finish(
            PythonSandboxResponse(
                status=status,
                stdout="",
                stderr=str(exc),
                duration_ms=_elapsed_ms(started),
                artifacts=[],
                _lumo_summary=(
                    "Python sandbox timed out."
                    if status == "timeout"
                    else "Python sandbox execution failed."
                ),
            )
        )
    finally:
        _close_sandbox(sandbox)


def _create_e2b_sandbox() -> Any:
    from e2b_code_interpreter import Sandbox

    return Sandbox.create()


def _e2b_api_key() -> str | None:
    value = os.getenv("E2B_API_KEY")
    return value if value and value.strip() else None


def _sdk_available() -> bool:
    try:
        import e2b_code_interpreter  # noqa: F401
    except Exception:
        return False
    return True


def _blocked_network_reference(code: str) -> str | None:
    match = NETWORK_BLOCKLIST.search(code)
    return match.group(1) if match else None


def _execution_stdout(execution: Any) -> str:
    logs = getattr(execution, "logs", None)
    stdout = getattr(logs, "stdout", None)
    return _lines_to_text(stdout)


def _execution_stderr(execution: Any) -> str:
    logs = getattr(execution, "logs", None)
    stderr = getattr(logs, "stderr", None)
    return _lines_to_text(stderr)


def _execution_error_text(error: Any) -> str:
    name = getattr(error, "name", None)
    value = getattr(error, "value", None)
    traceback = getattr(error, "traceback", None)
    parts = [str(part) for part in [name, value] if part]
    if traceback:
        if isinstance(traceback, list):
            parts.append("\n".join(str(line) for line in traceback))
        else:
            parts.append(str(traceback))
    return "\n".join(parts) if parts else str(error)


def _execution_artifacts(execution: Any) -> list[dict[str, Any]]:
    artifacts: list[dict[str, Any]] = []
    results = getattr(execution, "results", None) or []
    for index, result in enumerate(results):
        formats = _result_formats(result)
        if not formats:
            text = getattr(execution, "text", None)
            if text:
                formats = ["text/plain"]
        artifacts.append(
            {
                "index": index,
                "type": "execution_result",
                "formats": formats,
            }
        )
    return artifacts


def _result_formats(result: Any) -> list[str]:
    formats = getattr(result, "formats", None)
    if callable(formats):
        try:
            return [str(item) for item in formats()]
        except Exception:
            return []
    if isinstance(formats, (list, tuple, set)):
        return [str(item) for item in formats]
    return []


def _lines_to_text(lines: Any) -> str:
    if lines is None:
        return ""
    if isinstance(lines, str):
        return lines
    if isinstance(lines, (list, tuple)):
        return "\n".join(str(line).rstrip("\n") for line in lines if line is not None)
    return str(lines)


def _join_nonempty(parts: list[str]) -> str:
    return "\n".join(part for part in parts if part)


def _looks_like_timeout(exc: Exception) -> bool:
    text = f"{type(exc).__name__}: {exc}".lower()
    return "timeout" in text or "timed out" in text


def _close_sandbox(sandbox: Any | None) -> None:
    if sandbox is None:
        return
    for method_name in ("kill", "close"):
        method = getattr(sandbox, method_name, None)
        if not callable(method):
            continue
        try:
            method()
            return
        except Exception:
            logger.debug("sandbox close method failed", exc_info=True)


def _audit_sandbox_invocation(event: dict[str, Any]) -> None:
    logger.info("lumo_sandbox_audit %s", json.dumps(event, sort_keys=True))


def _sha256(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def _elapsed_ms(started: float) -> int:
    return max(0, round((time.perf_counter() - started) * 1000))


def _cap(value: str, limit: int = 20000) -> str:
    if len(value) <= limit:
        return value
    return value[:limit] + "\n[truncated]"
