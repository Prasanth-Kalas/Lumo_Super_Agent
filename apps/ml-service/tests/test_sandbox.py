from __future__ import annotations

from types import SimpleNamespace

from lumo_ml.auth import AuthContext
from lumo_ml.sandbox import run_python_sandbox, sandbox_upstream_health
from lumo_ml.schemas import PythonSandboxRequest


def test_run_python_sandbox_returns_not_configured_without_e2b_key(monkeypatch) -> None:
    monkeypatch.delenv("E2B_API_KEY", raising=False)

    res = run_python_sandbox(
        PythonSandboxRequest(code='print("hello")'),
        AuthContext(user_id="user_123", request_id="req_123", scope="lumo.sandbox.run"),
    )

    assert res.status == "not_configured"
    assert res.stdout == ""
    assert res.stderr == "E2B_API_KEY not set"
    assert res.duration_ms >= 0
    assert sandbox_upstream_health()["status"] == "unconfigured"


def test_run_python_sandbox_uses_e2b_sdk_when_configured(monkeypatch) -> None:
    monkeypatch.setenv("E2B_API_KEY", "test-key")
    fake = FakeSandbox()

    res = run_python_sandbox(
        PythonSandboxRequest(code='print("hello")', timeout_seconds=12),
        AuthContext(user_id="user_123", request_id="req_123", scope="lumo.sandbox.run"),
        sandbox_factory=lambda: fake,
    )

    assert res.status == "ok"
    assert res.stdout == "hello"
    assert res.stderr == ""
    assert res.duration_ms >= 0
    assert fake.calls == [
        {
            "code": 'print("hello")',
            "timeout": 12,
            "request_timeout": 17,
        }
    ]
    assert fake.closed is True


def test_run_python_sandbox_blocks_network_code_when_disabled(monkeypatch) -> None:
    monkeypatch.setenv("E2B_API_KEY", "test-key")

    res = run_python_sandbox(
        PythonSandboxRequest(code="import requests\nrequests.get('https://example.com')"),
        AuthContext(user_id="user_123", request_id="req_123", scope="lumo.sandbox.run"),
        sandbox_factory=lambda: FakeSandbox(),
    )

    assert res.status == "denied"
    assert "Network-capable code is blocked" in res.stderr


class FakeSandbox:
    def __init__(self) -> None:
        self.calls: list[dict[str, object]] = []
        self.closed = False

    def run_code(self, code: str, *, timeout: float, request_timeout: float):
        self.calls.append(
            {
                "code": code,
                "timeout": timeout,
                "request_timeout": request_timeout,
            }
        )
        return SimpleNamespace(
            logs=SimpleNamespace(stdout=["hello"], stderr=[]),
            error=None,
            results=[FakeResult()],
        )

    def kill(self) -> None:
        self.closed = True


class FakeResult:
    def formats(self) -> list[str]:
        return ["text/plain"]
