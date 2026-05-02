#!/usr/bin/env python3
"""Lint that breaks PRs shipping a public function without ``@traced``.

Discipline rule (``apps/ml-service/CONTRIBUTING.md`` §1):

    Every public function (one called from a route handler, another
    module, or by a Modal ``@app.function()``) MUST be wrapped with
    ``@traced("operation.name")``.

This lint enforces it at the AST level so missing decorators fail CI
instead of being caught months later by a "where did this latency come
from?" investigation.

Scope ratchet
-------------
The default targets are ``lumo_ml/plan/`` and ``lumo_ml/core/``.
``plan/`` is the module surface PYTHON-OBSERVABILITY-1 wired
``@traced`` across. ``core/`` was widened in by
PYTHON-EMBEDDING-SERVICE-1: cross-cutting domain primitives that land
there (``embeddings.py``, ``vector_store.py``, ...) MUST honor the
discipline. The named tracing-infrastructure files inside ``core/``
(``observability.py``, ``otel_setup.py``, ``pii_redaction.py``) remain
exempt via :data:`SCOPE_FILE_EXCLUDES` — tracing the tracer is
circular noise.

Other modules (``lumo_ml/auth.py``, ``tools.py``, ``transcription.py``,
etc.) will join the lint scope lane-by-lane as their public functions
get traced.

Add a path to the scope by passing ``--target`` on the command line or
extending :data:`DEFAULT_TARGETS`. The intent is that the scope
*ratchets up* — never down. CI invokes the script with no arguments so
extending the constant is the durable change.

Qualifying functions
--------------------
A function in scope must have ``@traced`` (or ``@traced(...)``) iff:

* It is module-level OR a method of a class.
* Its name does not start with ``_`` (private + dunders skipped).
* It is not decorated with ``@property`` / ``@cached_property`` /
  ``@field_validator`` / ``@model_validator`` / ``@validator`` /
  ``@root_validator`` (Pydantic v1 + v2 covered).
* It is not a Pydantic ``model_config`` / ``Config`` nested-class
  member (those classes carry data, not operations).

Note: ``@classmethod`` and ``@staticmethod`` *do* qualify — singleton
factories, alternative constructors etc. either need ``@traced`` or an
opt-out. The brief flagged classmethods specifically as in-scope.

Opt-out
-------
Legitimate exclusions opt out with a same-line comment::

    def get_instance(cls):  # noqa: TRC001 — singleton accessor; tracing
                            #   the cache lookup is noise

The opt-out requires *some* explanation after ``TRC001`` — bare
``# noqa: TRC001`` is rejected so the reviewer always sees a reason.
Comments may continue on the next physical line as long as the
``noqa`` itself appears on the def line (or the closing ``):`` line of
a multi-line signature).

Exit codes
----------
* 0 — every qualifying function has ``@traced`` or a valid opt-out
* 1 — at least one missing or malformed
* 2 — invocation error (missing path, etc.)
"""

from __future__ import annotations

import argparse
import ast
import re
import sys
from pathlib import Path
from typing import Iterable, NamedTuple

# ──────────────────────────────────────────────────────────────────────
# Scope
# ──────────────────────────────────────────────────────────────────────

REPO_ROOT = Path(__file__).resolve().parents[1]
"""``apps/ml-service/`` — the Python brain root. All target paths are
resolved relative to this so the script can be invoked from any cwd."""

DEFAULT_TARGETS: tuple[str, ...] = (
    "lumo_ml/plan",
    "lumo_ml/core",
)
"""Default scope. ``lumo_ml/plan/`` is the surface PYTHON-OBSERVABILITY-1
wired ``@traced`` across. ``lumo_ml/core/`` was widened in by
PYTHON-EMBEDDING-SERVICE-1: cross-cutting domain primitives that land
in ``core/`` (``embeddings.py``, ``vector_store.py``, ...) MUST honor
the discipline. The named tracing-infrastructure files inside ``core/``
(``observability.py``, ``otel_setup.py``, ``pii_redaction.py``) remain
exempt via :data:`SCOPE_FILE_EXCLUDES` — tracing the tracer is circular
noise."""

# Files within targets that don't carry public operations (constants,
# Pydantic schemas, package re-export shims, tracing infrastructure
# itself). Listed explicitly so we don't accidentally widen scope to a
# pure-data module — and so the named tracing-infra files in
# ``lumo_ml/core/`` stay exempt while the rest of ``core/`` is in scope.
SCOPE_FILE_EXCLUDES: frozenset[str] = frozenset(
    {
        # plan/ — pure-data + re-export shims.
        "lumo_ml/plan/__init__.py",
        "lumo_ml/plan/schemas.py",
        "lumo_ml/plan/voice_format.py",
        # core/ — tracing infrastructure + re-export shim.
        # Domain primitives in core/ (embeddings.py, vector_store.py,
        # ...) are NOT exempt — they go through @traced like any other
        # public surface.
        "lumo_ml/core/__init__.py",
        "lumo_ml/core/observability.py",
        "lumo_ml/core/otel_setup.py",
        "lumo_ml/core/pii_redaction.py",
    }
)


# ──────────────────────────────────────────────────────────────────────
# Decorator name handling
# ──────────────────────────────────────────────────────────────────────

EXEMPTING_DECORATORS: frozenset[str] = frozenset(
    {
        "property",
        "cached_property",
        "functools.cached_property",
        "field_validator",
        "model_validator",
        "validator",  # pydantic v1 (legacy)
        "root_validator",  # pydantic v1 (legacy)
        "pydantic.field_validator",
        "pydantic.model_validator",
    }
)
"""Decorators that mark the function as a non-operation (data-shape
helpers attached to Pydantic models / property accessors). Functions
carrying any of these are skipped — neither the rule nor the lint
applies."""

TRACED_NAMES: frozenset[str] = frozenset({"traced"})
"""The simple decorator name we accept as the @traced marker. Aliasing
(``from lumo_ml.core import traced as t``) is intentionally *not*
recognized — the discipline rule expects the canonical name to read
clearly at the call site."""


def _decorator_simple_name(node: ast.expr) -> str:
    """Return the dotted simple name of a decorator expression.

    ``@foo`` → ``foo``; ``@foo.bar`` → ``foo.bar``;
    ``@foo(arg)`` → ``foo``; ``@foo.bar(arg)`` → ``foo.bar``;
    Anything else (subscripts, lambdas, unusual shapes) → ``""``.
    """
    expr = node.func if isinstance(node, ast.Call) else node
    parts: list[str] = []
    while isinstance(expr, ast.Attribute):
        parts.append(expr.attr)
        expr = expr.value
    if isinstance(expr, ast.Name):
        parts.append(expr.id)
        return ".".join(reversed(parts))
    return ""


def _decorator_names(decorator_list: list[ast.expr]) -> list[str]:
    return [_decorator_simple_name(d) for d in decorator_list]


def _has_traced(decorator_list: list[ast.expr]) -> bool:
    for name in _decorator_names(decorator_list):
        if name in TRACED_NAMES or name.endswith(".traced"):
            return True
    return False


def _has_exempting_decorator(decorator_list: list[ast.expr]) -> bool:
    for name in _decorator_names(decorator_list):
        if name in EXEMPTING_DECORATORS:
            return True
    return False


# ──────────────────────────────────────────────────────────────────────
# Opt-out: # noqa: TRC001 — <reason>
# ──────────────────────────────────────────────────────────────────────

# Anchored at TRC001 so opt-outs for other rules (TRC002 etc.) don't
# match. Group 1 captures everything after TRC001 on the same line —
# non-empty whitespace-trimmed contents pass; empty fails. A trailing
# `noqa: TRC001` with nothing after is the explicit failure case.
_NOQA_RE = re.compile(r"#\s*noqa:\s*TRC001\b(.*)$")


class NoqaResult(NamedTuple):
    has_marker: bool
    reason: str  # empty when missing or malformed


def _check_noqa(source_lines: list[str], start: int, end: int) -> NoqaResult:
    """Look for ``# noqa: TRC001`` on the def's signature lines.

    ``start`` and ``end`` are 1-indexed inclusive line numbers in the
    source file (``ast.FunctionDef.lineno`` / ``end_lineno`` semantics).
    We scan every line from start to end so multi-line signatures with
    the comment on the closing ``):`` line are accepted.
    """
    for line_no in range(start, end + 1):
        if line_no < 1 or line_no > len(source_lines):
            continue
        match = _NOQA_RE.search(source_lines[line_no - 1])
        if match is None:
            continue
        tail = match.group(1).strip()
        # Reject the bare form (no reason after the code). Accept any
        # non-whitespace tail; we don't enforce a particular punctuation
        # style ("—", "-", ":", etc. all read fine in code review).
        if not tail:
            return NoqaResult(has_marker=True, reason="")
        return NoqaResult(has_marker=True, reason=tail)
    return NoqaResult(has_marker=False, reason="")


# ──────────────────────────────────────────────────────────────────────
# Walker
# ──────────────────────────────────────────────────────────────────────


class Violation(NamedTuple):
    path: Path
    line: int
    function_name: str
    kind: str  # "missing" | "bare-noqa"

    def render(self) -> str:
        rel = self.path.relative_to(REPO_ROOT)
        if self.kind == "bare-noqa":
            return (
                f"{rel}:{self.line}: {self.function_name}: "
                f'# noqa: TRC001 requires a reason — write '
                f'``# noqa: TRC001 — <why this function should not be traced>``'
            )
        return (
            f"{rel}:{self.line}: {self.function_name} is not @traced — "
            f'add ``@traced("operation.name")`` or '
            f'``# noqa: TRC001 — <reason>`` if intentionally excluded'
        )


def _function_qualifies(
    fn: ast.FunctionDef | ast.AsyncFunctionDef,
) -> bool:
    if fn.name.startswith("_"):
        return False
    if fn.name.startswith("test_"):
        return False
    if _has_exempting_decorator(fn.decorator_list):
        return False
    return True


def _scan_file(path: Path) -> list[Violation]:
    source = path.read_text(encoding="utf-8")
    source_lines = source.splitlines()
    try:
        tree = ast.parse(source, filename=str(path))
    except SyntaxError as exc:
        # A syntactically broken file is itself a CI break; surface as
        # a violation rather than crashing the lint.
        return [
            Violation(
                path=path,
                line=exc.lineno or 0,
                function_name=f"<parse error: {exc.msg}>",
                kind="missing",
            )
        ]

    violations: list[Violation] = []

    def visit(node: ast.AST) -> None:
        for child in ast.iter_child_nodes(node):
            if isinstance(child, (ast.FunctionDef, ast.AsyncFunctionDef)):
                if _function_qualifies(child) and not _has_traced(
                    child.decorator_list
                ):
                    end = child.end_lineno or child.lineno
                    noqa = _check_noqa(source_lines, child.lineno, end)
                    if noqa.has_marker and not noqa.reason:
                        violations.append(
                            Violation(
                                path=path,
                                line=child.lineno,
                                function_name=child.name,
                                kind="bare-noqa",
                            )
                        )
                    elif not noqa.has_marker:
                        violations.append(
                            Violation(
                                path=path,
                                line=child.lineno,
                                function_name=child.name,
                                kind="missing",
                            )
                        )
                # Recurse into nested defs / classes inside this fn's
                # body — closures and inner classes still apply.
                visit(child)
            elif isinstance(child, ast.ClassDef):
                visit(child)
            else:
                visit(child)

    visit(tree)
    return violations


def _iter_target_files(targets: Iterable[Path]) -> Iterable[Path]:
    for root in targets:
        if root.is_file() and root.suffix == ".py":
            yield root
            continue
        if not root.is_dir():
            continue
        for path in sorted(root.rglob("*.py")):
            rel = path.relative_to(REPO_ROOT).as_posix()
            if rel in SCOPE_FILE_EXCLUDES:
                continue
            yield path


# ──────────────────────────────────────────────────────────────────────
# CLI
# ──────────────────────────────────────────────────────────────────────


def main(argv: list[str] | None = None) -> int:
    global REPO_ROOT
    parser = argparse.ArgumentParser(
        prog="lint-traced-coverage",
        description=__doc__,
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument(
        "--target",
        action="append",
        default=None,
        help=(
            "Path (file or directory) to scan, relative to "
            "apps/ml-service/. Repeatable. Defaults to "
            f"{list(DEFAULT_TARGETS)}."
        ),
    )
    parser.add_argument(
        "--repo-root",
        type=Path,
        default=REPO_ROOT,
        help=argparse.SUPPRESS,  # tests override this
    )
    args = parser.parse_args(argv)

    repo_root: Path = args.repo_root.resolve()
    # Rebind module-level REPO_ROOT so Violation.render and the
    # rglob walker resolve against the caller-provided root (tests
    # use this to point at a tmp tree).
    REPO_ROOT = repo_root

    targets_raw = args.target or list(DEFAULT_TARGETS)
    targets: list[Path] = []
    for t in targets_raw:
        resolved = (repo_root / t).resolve()
        if not resolved.exists():
            print(
                f"lint-traced-coverage: target not found: {t}",
                file=sys.stderr,
            )
            return 2
        targets.append(resolved)

    files = list(_iter_target_files(targets))
    violations: list[Violation] = []
    for path in files:
        violations.extend(_scan_file(path))

    if not violations:
        print(
            f"lint-traced-coverage: OK — scanned {len(files)} file(s) under "
            f"{', '.join(str(t.relative_to(repo_root)) for t in targets)}",
        )
        return 0

    print(
        f"lint-traced-coverage: {len(violations)} violation(s) "
        f"across {len(files)} file(s) scanned",
        file=sys.stderr,
    )
    for v in sorted(violations, key=lambda v: (str(v.path), v.line)):
        print(v.render(), file=sys.stderr)
    print(
        "\nFix: add ``@traced(\"operation.name\")`` to the function, OR "
        "add a same-line ``# noqa: TRC001 — <reason>`` if it is "
        "intentionally not an operation (singleton accessor, init "
        "helper, pure-data transform).",
        file=sys.stderr,
    )
    return 1


if __name__ == "__main__":
    sys.exit(main())
