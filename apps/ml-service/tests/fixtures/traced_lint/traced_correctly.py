"""Fixture: every qualifying public function is traced or has a valid
opt-out. The lint must report zero violations for this file.

Covers each accepted shape so test failures here pinpoint which detector
regressed:

* ``@traced`` — bare decorator
* ``@traced("op.name")`` — call form with positional arg
* ``@traced("op.name", model="x")`` — call form with kwargs
* ``# noqa: TRC001 — <reason>`` opt-out
* ``@property`` / Pydantic validator exemption
* ``_private`` and dunder skipping
"""

from __future__ import annotations

from lumo_ml.core import traced


@traced
def bare_traced() -> None:
    return None


@traced("fixture.simple")
def call_form_positional() -> None:
    return None


@traced("fixture.kwargs", model="all-MiniLM-L6-v2")
def call_form_kwargs() -> None:
    return None


def opt_out_with_reason() -> None:  # noqa: TRC001 — fixture: documented opt-out path used by the lint's self-test.
    return None


def _private_helper(x: int) -> int:
    """Underscore-prefixed → not in scope."""
    return x


def __init_subclass_hook__() -> None:  # noqa: N807
    """Dunder names are private by the same rule."""


class Service:
    """Class-level decorator coverage."""

    @traced("fixture.method")
    def traced_method(self) -> None:
        return None

    @classmethod
    def classmethod_with_traced(cls) -> None:  # noqa: TRC001 — fixture: classmethods qualify; opt-out path covered.
        return None

    @staticmethod
    def staticmethod_with_traced() -> None:  # noqa: TRC001 — fixture: staticmethods qualify; opt-out path covered.
        return None

    @property
    def value(self) -> int:
        """@property exempts."""
        return 42

    def _internal(self) -> None:
        return None


class _PrivateService:
    """A class can be private; its methods inherit nothing from that —
    the function name is still what the lint checks. Methods here are
    underscore-prefixed defensively."""

    def _internal(self) -> None:
        return None


# Pydantic validator exemption — emulate the decorator pattern without
# importing pydantic so the fixture stays import-cheap. The lint walks
# only ``def``/``async def`` AST nodes, so module-level assignments
# stay invisible to it. ``field_validator`` and ``model_validator``
# below are bound to lambdas (no FunctionDef nodes); the
# ``ValidatorOwner`` methods that *use* them as decorators are the
# real exemption test.

field_validator = lambda *_a, **_kw: (lambda fn: fn)  # noqa: E731 — fixture stub
model_validator = lambda *_a, **_kw: (lambda fn: fn)  # noqa: E731 — fixture stub


class ValidatorOwner:
    @field_validator("foo")
    def check_foo(self, v: int) -> int:
        return v

    @model_validator(mode="after")
    def check_model(self) -> "ValidatorOwner":
        return self
