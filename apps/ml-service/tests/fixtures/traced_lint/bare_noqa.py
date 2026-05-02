"""Fixture: ``# noqa: TRC001`` with no reason after the marker.

The lint must reject this — the opt-out requires an explanation so a
reviewer can judge the call without grep-spelunking. The error message
distinguishes ``bare-noqa`` from ``missing`` so authors immediately see
they need to add a reason, not a decorator.
"""

from __future__ import annotations


def bare_noqa_violator() -> int:  # noqa: TRC001
    return 0


def trailing_whitespace_only() -> int:  # noqa: TRC001
    return 0
