"""Self-tests for ``scripts/lint-traced-coverage.py``.

The lint's whole job is to fail PRs missing ``@traced``. If the lint
itself silently passes everything, the discipline rule rots without
anyone noticing. These tests pin the failure-path and pass-path
behaviour against fixtures under :mod:`tests.fixtures.traced_lint`:

* ``missing_traced.py`` → 2 violations expected
* ``traced_correctly.py`` → 0 violations expected
* ``bare_noqa.py`` → 2 ``bare-noqa`` violations expected
* The real ``lumo_ml/plan/`` tree → 0 violations (regression guard for
  the production codebase)

The lint script is loaded by path (it has a hyphen in the filename, so
``import`` doesn't work); :func:`_load_lint_module` does the
``importlib.util`` dance once per session.
"""

from __future__ import annotations

import importlib.util
import sys
from pathlib import Path
from types import ModuleType

import pytest

REPO_ROOT = Path(__file__).resolve().parents[1]
LINT_SCRIPT = REPO_ROOT / "scripts" / "lint-traced-coverage.py"
FIXTURE_ROOT = Path(__file__).resolve().parent / "fixtures" / "traced_lint"


def _load_lint_module() -> ModuleType:
    spec = importlib.util.spec_from_file_location(
        "lint_traced_coverage", LINT_SCRIPT,
    )
    assert spec is not None and spec.loader is not None
    mod = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = mod
    spec.loader.exec_module(mod)
    return mod


@pytest.fixture(scope="module")
def lint() -> ModuleType:
    return _load_lint_module()


# ──────────────────────────────────────────────────────────────────────
# Fixture-driven tests — failure path
# ──────────────────────────────────────────────────────────────────────


def test_missing_traced_fixture_reports_violations(lint: ModuleType) -> None:
    violations = lint._scan_file(FIXTURE_ROOT / "missing_traced.py")
    names = sorted(v.function_name for v in violations)
    assert names == [
        "public_method_without_traced",
        "public_operation_without_traced",
    ]
    assert all(v.kind == "missing" for v in violations)


def test_bare_noqa_fixture_reports_bare_noqa_kind(lint: ModuleType) -> None:
    violations = lint._scan_file(FIXTURE_ROOT / "bare_noqa.py")
    assert len(violations) == 2
    assert all(v.kind == "bare-noqa" for v in violations)
    # The error message must mention the reason requirement so authors
    # don't reach for ``@traced`` when the actual fix is "add a why".
    rendered = [v.render() for v in violations]
    assert all("requires a reason" in r for r in rendered)


# ──────────────────────────────────────────────────────────────────────
# Fixture-driven tests — pass path
# ──────────────────────────────────────────────────────────────────────


def test_traced_correctly_fixture_clean(lint: ModuleType) -> None:
    violations = lint._scan_file(FIXTURE_ROOT / "traced_correctly.py")
    assert violations == [], (
        "traced_correctly fixture must be clean; found "
        f"{[v.render() for v in violations]}"
    )


def test_real_plan_tree_clean(lint: ModuleType) -> None:
    """Regression guard: production ``lumo_ml/plan/`` tree must remain
    clean. If a future lane lands a public function without ``@traced``
    or a documented opt-out, this test pins the shape of the failure.
    """
    plan_dir = REPO_ROOT / "lumo_ml" / "plan"
    # Use the public iter helper so the SCOPE_FILE_EXCLUDES set is
    # respected exactly as in the CI invocation.
    lint.REPO_ROOT = REPO_ROOT  # for the path-relative helper inside Violation.render
    files = list(lint._iter_target_files([plan_dir]))
    assert files, "expected at least one plan file in scope"
    violations = []
    for path in files:
        violations.extend(lint._scan_file(path))
    assert violations == [], (
        f"plan tree regressed: {[v.render() for v in violations]}"
    )


def test_real_core_tree_clean(lint: ModuleType) -> None:
    """Regression guard: production ``lumo_ml/core/`` tree must remain
    clean. Pinned by PYTHON-EMBEDDING-SERVICE-1 — the directory is in
    scope by default; the named tracing-infra files are exempt via
    :data:`SCOPE_FILE_EXCLUDES`. Domain primitives in core/
    (``embeddings.py``, ``vector_store.py``, ...) must carry @traced.

    The ``files`` list may be empty at the moment the lint-scope
    inversion lands (before any domain primitive ships into ``core/``);
    in that state the regression guard is trivially clean. Once
    ``core/embeddings.py`` lands in the same lane, the list grows.
    """
    core_dir = REPO_ROOT / "lumo_ml" / "core"
    lint.REPO_ROOT = REPO_ROOT
    files = list(lint._iter_target_files([core_dir]))
    violations = []
    for path in files:
        violations.extend(lint._scan_file(path))
    assert violations == [], (
        f"core tree regressed: {[v.render() for v in violations]}"
    )


def test_core_tracing_infra_files_are_excluded(lint: ModuleType) -> None:
    """The three tracing-infrastructure files in ``lumo_ml/core/`` must
    stay exempt; if someone removes one from :data:`SCOPE_FILE_EXCLUDES`
    by accident, this test fails distinctly so the cause is obvious.
    """
    expected_excluded = {
        "lumo_ml/core/__init__.py",
        "lumo_ml/core/observability.py",
        "lumo_ml/core/otel_setup.py",
        "lumo_ml/core/pii_redaction.py",
    }
    missing = expected_excluded - lint.SCOPE_FILE_EXCLUDES
    assert not missing, (
        f"tracing-infra files dropped from SCOPE_FILE_EXCLUDES: {sorted(missing)}"
    )


def test_core_domain_files_are_not_excluded(lint: ModuleType) -> None:
    """Sanity guard: future domain primitives in ``core/`` must not
    accidentally land in :data:`SCOPE_FILE_EXCLUDES`. If they do, the
    discipline rule is silently disabled for them.
    """
    forbidden_excludes = {
        "lumo_ml/core/embeddings.py",
        "lumo_ml/core/vector_store.py",
    }
    leaked = forbidden_excludes & lint.SCOPE_FILE_EXCLUDES
    assert not leaked, (
        f"domain primitive(s) wrongly added to SCOPE_FILE_EXCLUDES: {sorted(leaked)}"
    )


def test_core_default_target_includes_core(lint: ModuleType) -> None:
    """Pin the directory inclusion at the constant level so a
    well-meaning revert of the scope inversion is caught."""
    assert "lumo_ml/core" in lint.DEFAULT_TARGETS, (
        "lumo_ml/core dropped from DEFAULT_TARGETS — scope inversion reverted"
    )


# ──────────────────────────────────────────────────────────────────────
# CLI-level tests — exit codes
# ──────────────────────────────────────────────────────────────────────


def test_main_exit_zero_on_clean_target(
    lint: ModuleType, capsys: pytest.CaptureFixture[str]
) -> None:
    rc = lint.main(
        [
            "--repo-root",
            str(REPO_ROOT),
            "--target",
            "tests/fixtures/traced_lint/traced_correctly.py",
        ]
    )
    assert rc == 0
    out = capsys.readouterr()
    assert "OK" in out.out


def test_main_exit_one_on_missing_target(
    lint: ModuleType, capsys: pytest.CaptureFixture[str]
) -> None:
    rc = lint.main(
        [
            "--repo-root",
            str(REPO_ROOT),
            "--target",
            "tests/fixtures/traced_lint/missing_traced.py",
        ]
    )
    assert rc == 1
    err = capsys.readouterr().err
    assert "missing_traced.py" in err
    assert "is not @traced" in err


def test_main_exit_one_on_bare_noqa(
    lint: ModuleType, capsys: pytest.CaptureFixture[str]
) -> None:
    rc = lint.main(
        [
            "--repo-root",
            str(REPO_ROOT),
            "--target",
            "tests/fixtures/traced_lint/bare_noqa.py",
        ]
    )
    assert rc == 1
    err = capsys.readouterr().err
    assert "requires a reason" in err


def test_main_exit_two_on_unknown_target(
    lint: ModuleType, capsys: pytest.CaptureFixture[str]
) -> None:
    rc = lint.main(
        [
            "--repo-root",
            str(REPO_ROOT),
            "--target",
            "lumo_ml/does/not/exist",
        ]
    )
    assert rc == 2
    err = capsys.readouterr().err
    assert "target not found" in err


def test_main_default_target_passes(
    lint: ModuleType, capsys: pytest.CaptureFixture[str]
) -> None:
    """Smoke test: with no ``--target`` argument the lint runs against
    the default ``DEFAULT_TARGETS`` list and exits clean. This is the
    exact invocation CI uses, so a regression here is the same as a
    CI break."""
    rc = lint.main(["--repo-root", str(REPO_ROOT)])
    assert rc == 0


# ──────────────────────────────────────────────────────────────────────
# Decorator-recognition unit tests
# ──────────────────────────────────────────────────────────────────────


def test_decorator_simple_name_handles_call_and_attribute(
    lint: ModuleType,
) -> None:
    import ast

    cases = {
        "@traced\ndef f(): ...": "traced",
        "@traced('x')\ndef f(): ...": "traced",
        "@traced('x', model='y')\ndef f(): ...": "traced",
        "@core.traced('x')\ndef f(): ...": "core.traced",
        "@functools.cached_property\ndef f(self): ...": "functools.cached_property",
    }
    for src, expected in cases.items():
        tree = ast.parse(src)
        fn = tree.body[0]
        assert isinstance(fn, (ast.FunctionDef, ast.AsyncFunctionDef))
        names = lint._decorator_names(fn.decorator_list)
        assert expected in names, f"{src!r} → {names!r}, want {expected!r}"


def test_traced_match_rejects_aliases(lint: ModuleType) -> None:
    """If a future lane imports ``traced`` under a different alias, the
    discipline rule says the canonical name should appear in source.
    This pins that aliases are rejected at the AST level so
    ``@t`` (where ``t = traced``) flags as missing.
    """
    import ast

    tree = ast.parse("@t\ndef f(): ...")
    fn = tree.body[0]
    assert isinstance(fn, (ast.FunctionDef, ast.AsyncFunctionDef))
    assert lint._has_traced(fn.decorator_list) is False


def test_traced_match_accepts_module_qualified(lint: ModuleType) -> None:
    """``@core.traced`` and ``@lumo_ml.core.traced`` must count too —
    some call sites prefer the qualified form for explicitness."""
    import ast

    for src in ("@core.traced\ndef f(): ...", "@lumo_ml.core.traced\ndef f(): ..."):
        tree = ast.parse(src)
        fn = tree.body[0]
        assert isinstance(fn, (ast.FunctionDef, ast.AsyncFunctionDef))
        assert lint._has_traced(fn.decorator_list) is True


# ──────────────────────────────────────────────────────────────────────
# Async-function and nested-class coverage
# ──────────────────────────────────────────────────────────────────────


def test_async_function_qualifies(lint: ModuleType, tmp_path: Path) -> None:
    src = tmp_path / "async_missing.py"
    src.write_text(
        "from __future__ import annotations\n"
        "async def public_async() -> None:\n"
        "    return None\n"
    )
    violations = lint._scan_file(src)
    assert [v.function_name for v in violations] == ["public_async"]


def test_nested_class_methods_walked(lint: ModuleType, tmp_path: Path) -> None:
    src = tmp_path / "nested.py"
    src.write_text(
        "class Outer:\n"
        "    class Inner:\n"
        "        def deep_method(self) -> None:\n"
        "            return None\n"
    )
    violations = lint._scan_file(src)
    assert [v.function_name for v in violations] == ["deep_method"]


def test_multiline_signature_noqa_accepted(
    lint: ModuleType, tmp_path: Path
) -> None:
    """The opt-out must work when the def spans multiple physical lines
    and the comment lands on the closing ``):`` line."""
    src = tmp_path / "multiline.py"
    src.write_text(
        "def long_signature(\n"
        "    a: int,\n"
        "    b: int,\n"
        ") -> int:  # noqa: TRC001 — multi-line signature opt-out is supported\n"
        "    return a + b\n"
    )
    violations = lint._scan_file(src)
    assert violations == []
