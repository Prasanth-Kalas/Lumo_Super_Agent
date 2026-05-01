#!/usr/bin/env bash
# Build-config sanity check for IOS-DEV-BYPASS-GATE-1.
#
# App Review will reject any production binary that ships a "skip auth"
# affordance visible to users. The dev-bypass button on the welcome
# screen is wrapped in `#if DEBUG` and the Release build configuration
# omits the DEBUG compilation condition, so the button is stripped from
# TestFlight + App Store binaries.
#
# This script asserts both halves of that contract so a future change
# can't silently leak the bypass into Release:
#   1. The bypass string only appears inside `#if DEBUG / #endif` in
#      every Swift source file.
#   2. The Release build configuration in apps/ios/project.yml does NOT
#      set SWIFT_ACTIVE_COMPILATION_CONDITIONS to DEBUG.
#
# Run from repo root:
#   scripts/verify-release-bypass-stripped.sh
#
# Exit codes:
#   0 — both invariants hold
#   1 — at least one invariant violated; failure messages on stderr
set -euo pipefail

repo_root=$(cd "$(dirname "$0")/.." && pwd)
cd "$repo_root"

failures=0

# Invariant 1: the bypass label string only appears inside #if DEBUG.
# We run a small awk over every Swift source file; the awk maintains an
# in_debug counter so we correctly handle nested conditional compilation.
# (Pre-bash-4 / macOS-default-shell: avoid `mapfile`; loop with find -print0.)
while IFS= read -r -d '' f; do
    if ! grep -q "Continue without signing in" "$f"; then
        continue
    fi
    bad=$(awk '
        # awk uses POSIX ERE which has no \b, so we match `#if DEBUG`
        # with a trailing whitespace-or-eol pattern instead. This still
        # admits trailing comments like `#if DEBUG // comment`.
        /^[[:space:]]*#if[[:space:]]+DEBUG([[:space:]]|$)/ { depth++; next }
        /^[[:space:]]*#endif([[:space:]]|$)/              { if (depth > 0) depth--; next }
        # Skip Swift comments — the bypass string is allowed in /// or //
        # documentation lines (the compiler strips them anyway).
        /^[[:space:]]*\/\//                                { next }
        /Continue without signing in/        { if (depth == 0) print FILENAME ":" NR ": " $0 }
    ' "$f")
    if [[ -n "$bad" ]]; then
        echo "FAIL: dev-bypass label found outside #if DEBUG block:" >&2
        echo "$bad" >&2
        failures=$((failures + 1))
    fi
done < <(find apps/ios/Lumo -name '*.swift' -type f -print0)

# Invariant 2: project.yml Release config must not set DEBUG.
# We use awk to find the Release: block under the Lumo target's configs
# and verify SWIFT_ACTIVE_COMPILATION_CONDITIONS isn't DEBUG within it.
release_debug=$(awk '
    /^[[:space:]]+configs:[[:space:]]*$/ { in_configs = 1; next }
    in_configs && /^[[:space:]]+Release:[[:space:]]*$/ { in_release = 1; release_indent = match($0, /[^ ]/); next }
    in_release && /^[[:space:]]+SWIFT_ACTIVE_COMPILATION_CONDITIONS:[[:space:]]+DEBUG/ {
        print FILENAME ":" NR ": " $0
        in_release = 0
    }
    in_release && /^[[:space:]]+[A-Za-z]+:[[:space:]]*$/ {
        cur_indent = match($0, /[^ ]/)
        if (cur_indent <= release_indent) { in_release = 0 }
    }
' apps/ios/project.yml)

if [[ -n "$release_debug" ]]; then
    echo "FAIL: Release config sets SWIFT_ACTIVE_COMPILATION_CONDITIONS to DEBUG:" >&2
    echo "$release_debug" >&2
    failures=$((failures + 1))
fi

if [[ "$failures" -gt 0 ]]; then
    echo "" >&2
    echo "verify-release-bypass-stripped: $failures invariant(s) violated." >&2
    exit 1
fi

echo "verify-release-bypass-stripped: OK"
echo "  · dev-bypass label only appears inside #if DEBUG"
echo "  · Release config does not set SWIFT_ACTIVE_COMPILATION_CONDITIONS=DEBUG"
