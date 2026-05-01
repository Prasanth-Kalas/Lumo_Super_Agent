#!/usr/bin/env bash
# Fails (non-zero exit) if regenerating @lumo/shared-types produces a diff
# against the committed dist/index.ts. CI runs this so a Pydantic change
# without a paired codegen rerun blocks the build.
set -euo pipefail

PKG_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO_ROOT="$(cd "$PKG_DIR/../.." && pwd)"

cd "$PKG_DIR"
python3 codegen.py

cd "$REPO_ROOT"
if ! git diff --exit-code -- packages/lumo-shared-types/dist/; then
  echo ""
  echo "ERROR: packages/lumo-shared-types/dist/ is out of date." >&2
  echo "Run 'cd packages/lumo-shared-types && python3 codegen.py' and commit the result." >&2
  exit 1
fi
echo "shared-types: no drift."
