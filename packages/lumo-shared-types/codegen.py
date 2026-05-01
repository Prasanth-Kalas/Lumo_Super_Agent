"""Generate TypeScript types from Pydantic schemas in apps/ml-service.

This script is the source of truth for the cross-language type pipeline:

    apps/ml-service/lumo_ml/schemas.py   (Pydantic, written by hand)
                       │
                       ▼
            packages/lumo-shared-types/codegen.py   (this file)
                       │
                       ▼
       packages/lumo-shared-types/dist/index.ts     (generated, committed)
                       │
                       ▼
                 apps/web/**.ts                     (consumers)

The generated file is committed so TypeScript consumers don't need a Python
toolchain. ``scripts/check-drift.sh`` re-runs this script and asserts the
generated output is unchanged on the working tree — CI fails the build if a
schema change wasn't paired with a regenerated ``dist/index.ts``.

Requirements (installed via ``apps/ml-service/pyproject.toml`` ``[dev]``):
    - ``pydantic-to-typescript`` (``pydantic2ts`` CLI)
    - ``json-schema-to-typescript`` (``json2ts`` Node CLI; resolved via
      ``packages/lumo-shared-types/node_modules/.bin/json2ts`` after ``npm
      install``)
"""

from __future__ import annotations

import os
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
REPO_ROOT = ROOT.parent.parent
ML_SERVICE = REPO_ROOT / "apps" / "ml-service"
SCHEMAS_MODULE = "lumo_ml.schemas"
OUTPUT = ROOT / "dist" / "index.ts"

HEADER = """\
/**
 * AUTO-GENERATED FROM apps/ml-service/lumo_ml/schemas.py.
 *
 * Do not edit by hand. To update:
 *   cd packages/lumo-shared-types && python3 codegen.py
 *
 * CI runs scripts/check-drift.sh which re-runs codegen and fails the build
 * if dist/index.ts has drifted from the Pydantic source.
 */

"""


def _resolve_pydantic2ts() -> str:
    """Find the ``pydantic2ts`` CLI, preferring the ml-service venv."""

    venv_candidates = [
        ML_SERVICE / ".venv" / "bin" / "pydantic2ts",
        REPO_ROOT / ".venv" / "bin" / "pydantic2ts",
    ]
    for candidate in venv_candidates:
        if candidate.is_file() and os.access(candidate, os.X_OK):
            return str(candidate)
    found = shutil.which("pydantic2ts")
    if found:
        return found
    sys.exit(
        "pydantic2ts not found. Install dev deps:\n"
        "  python3 -m venv apps/ml-service/.venv\n"
        "  apps/ml-service/.venv/bin/pip install -e 'apps/ml-service[dev]'"
    )


def _resolve_json2ts() -> str:
    """Find the ``json2ts`` CLI (``json-schema-to-typescript``)."""

    local_bin = ROOT / "node_modules" / ".bin" / "json2ts"
    if local_bin.is_file() and os.access(local_bin, os.X_OK):
        return str(local_bin)
    workspace_bin = REPO_ROOT / "node_modules" / ".bin" / "json2ts"
    if workspace_bin.is_file() and os.access(workspace_bin, os.X_OK):
        return str(workspace_bin)
    found = shutil.which("json2ts")
    if found:
        return found
    sys.exit(
        "json2ts not found. Install workspace deps:\n"
        "  npm install --workspaces"
    )


def main() -> int:
    pydantic2ts = _resolve_pydantic2ts()
    json2ts = _resolve_json2ts()

    OUTPUT.parent.mkdir(parents=True, exist_ok=True)

    env = os.environ.copy()
    existing = env.get("PYTHONPATH", "")
    env["PYTHONPATH"] = (
        f"{ML_SERVICE}{os.pathsep}{existing}" if existing else str(ML_SERVICE)
    )

    cmd = [
        pydantic2ts,
        "--module",
        SCHEMAS_MODULE,
        "--output",
        str(OUTPUT),
        "--json2ts-cmd",
        json2ts,
    ]
    result = subprocess.run(cmd, env=env, check=False)
    if result.returncode != 0:
        return result.returncode

    body = OUTPUT.read_text(encoding="utf-8")
    if not body.startswith("/**\n * AUTO-GENERATED"):
        OUTPUT.write_text(HEADER + body, encoding="utf-8")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
