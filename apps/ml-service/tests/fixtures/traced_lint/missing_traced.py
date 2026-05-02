"""Fixture for ``test_lint_traced_coverage``: a public function that
deliberately omits ``@traced``. The lint must flag this as a violation.

Do not import this from production code. The directory it lives in is
*not* part of the lint's default scope; tests point the lint at it via
``--target`` to assert the failure path.
"""

from __future__ import annotations


def public_operation_without_traced(x: int) -> int:
    """Top-level public function without @traced — a violation."""
    return x + 1


class Service:
    def public_method_without_traced(self, x: int) -> int:
        """Public method without @traced — a violation."""
        return x + 2
