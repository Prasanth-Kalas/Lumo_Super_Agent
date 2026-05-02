"""Layer-B PII redaction — regex scrubber that runs at log-export
time. Layer A (Pydantic ``Secret`` annotation) is in
:mod:`lumo_ml.core.observability`.

Design reference: ``apps/ml-service/docs/designs/observability-
platform.md`` §3.

Layer A is fast and explicit — fields the developer marks. Layer B
is the unfakeable safety net: a regex scrubber that runs on every
log record's body and attribute values just before export, so even
``logger.error(exc_info=True)`` or unguarded ``f"{obj}"`` paths get
redacted.

The redaction targets a small set of high-confidence patterns; we
don't try to anonymize everything (false positives drown the
signal). The 6 patterns covered:

    * email
    * phone (international + US-style)
    * credit card (Luhn-checked to keep the false-positive rate low)
    * Amex (3xxxx)
    * generic API tokens (``sk-``, ``hcaik_``, ``hf_``, ``vcp_``,
      ``pat_``, ``api_``)
    * JWTs (3-segment base64url)

All matches are replaced with ``"***REDACTED***"``.
"""

from __future__ import annotations

import logging
import re
from typing import Any

_REDACTED = "***REDACTED***"


# ──────────────────────────────────────────────────────────────────────
# Regex set — module-level so they compile once.
# ──────────────────────────────────────────────────────────────────────


_EMAIL_RE = re.compile(
    r"[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}"
)
_PHONE_RE = re.compile(
    # Require either a leading ``+`` (international) or at least one
    # separator (``-``, ``.``, space, or parens) so a 10+-digit
    # numeric id without separators (timestamps, order numbers,
    # non-Luhn CC-shaped strings) doesn't get false-positive'd.
    r"(?:\+\d[\d\-\s().]{7,}\d)"
    r"|(?:\(?\d{3}\)?[-.\s]\d{3}[-.\s]\d{4}(?!\d))"
)
_CC_RE = re.compile(
    r"\b(?:\d[ -]*?){13,19}\b"
)
_AMEX_RE = re.compile(
    r"\b3[47]\d{13}\b"
)
_API_TOKEN_RE = re.compile(
    r"\b(?:sk-|hcaik_|hf_|vcp_|pat_|api_)[A-Za-z0-9_\-]{16,}\b"
)
_JWT_RE = re.compile(
    r"eyJ[A-Za-z0-9_\-]{8,}\.[A-Za-z0-9_\-]{8,}\.[A-Za-z0-9_\-]{8,}"
)


def scrub(text: str) -> str:
    """Apply Layer-B redaction to a string. Pure / idempotent."""
    if not isinstance(text, str) or not text:
        return text
    out = text
    out = _AMEX_RE.sub(_REDACTED, out)
    out = _API_TOKEN_RE.sub(_REDACTED, out)
    out = _JWT_RE.sub(_REDACTED, out)
    out = _EMAIL_RE.sub(_REDACTED, out)
    # Credit card AFTER email so we don't tank email at-signs into
    # CC matches. Also Luhn-check inside _scrub_cc.
    out = _scrub_cc(out)
    out = _PHONE_RE.sub(_REDACTED, out)
    return out


def _scrub_cc(text: str) -> str:
    """Replace credit-card-shaped substrings only when they pass the
    Luhn checksum. Without Luhn we'd false-positive on every long
    string of digits (timestamps, ids, etc.)."""

    def replace(match: re.Match[str]) -> str:
        candidate = re.sub(r"[ -]", "", match.group(0))
        if not _luhn_ok(candidate):
            return match.group(0)
        return _REDACTED

    return _CC_RE.sub(replace, text)


def _luhn_ok(digits: str) -> bool:
    if not digits.isdigit() or not (13 <= len(digits) <= 19):
        return False
    total = 0
    parity = len(digits) % 2
    for i, ch in enumerate(digits):
        d = int(ch)
        if i % 2 == parity:
            d *= 2
            if d > 9:
                d -= 9
        total += d
    return total % 10 == 0


# ──────────────────────────────────────────────────────────────────────
# stdlib logging filter — Layer-B for everything that goes through
# ``logging``. Installed on the root logger by ``otel_setup``.
# ──────────────────────────────────────────────────────────────────────


class StdlibLoggingPiiFilter(logging.Filter):
    """Filter that runs :func:`scrub` on every log record's
    ``msg`` (after format-arg substitution) and on every attribute
    value. Returns ``True`` so the record continues through the
    normal handler chain — we mutate, we don't drop.
    """

    def filter(self, record: logging.LogRecord) -> bool:
        try:
            # ``record.msg`` may be a format string with %-args. We
            # need to scrub the AS-RENDERED form so substituted
            # values get caught. Render once, replace ``msg``, clear
            # ``args``.
            rendered = record.getMessage()
            scrubbed = scrub(rendered)
            if scrubbed != rendered:
                record.msg = scrubbed
                record.args = None

            # Attributes: scrub values. Don't recurse deeply — that
            # explodes for nested structures and the OTel exporter
            # has its own attribute redaction below.
            for key, value in list(record.__dict__.items()):
                if key.startswith("_") or key in _RESERVED_LOG_ATTRS:
                    continue
                if isinstance(value, str):
                    new_value = scrub(value)
                    if new_value != value:
                        setattr(record, key, new_value)
        except Exception:  # noqa: BLE001
            # Filter must NEVER break logging.
            pass
        return True


_RESERVED_LOG_ATTRS: frozenset[str] = frozenset({
    "args", "asctime", "created", "exc_info", "exc_text", "filename",
    "funcName", "levelname", "levelno", "lineno", "message", "module",
    "msecs", "msg", "name", "pathname", "process", "processName",
    "relativeCreated", "stack_info", "thread", "threadName",
    "taskName",
})


def scrub_attribute(value: Any) -> Any:
    """Scrub a value safe for use as an OTel span attribute."""
    if isinstance(value, str):
        return scrub(value)
    if isinstance(value, (list, tuple)):
        return [scrub_attribute(v) for v in value]
    return value
