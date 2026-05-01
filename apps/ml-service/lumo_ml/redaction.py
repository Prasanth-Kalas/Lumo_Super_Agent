from __future__ import annotations

import re
from dataclasses import dataclass
from functools import lru_cache
from typing import Any

COUNT_KEYS = ("email", "phone", "credit_card", "ssn", "secret")


@dataclass(frozen=True)
class RedactionResult:
    text: str
    counts: dict[str, int]


def redact_for_embedding(text: str) -> RedactionResult:
    """Redact PII before text is embedded, classified, or reranked.

    Regex redaction is the always-on fast path. Presidio runs as a lazy
    best-effort second pass when its runtime dependencies are available.
    """

    regex_result = _regex_redact(text)
    presidio_result = _presidio_redact(regex_result.text)
    if presidio_result is None:
        return regex_result
    return RedactionResult(
        text=presidio_result.text,
        counts=_merge_counts(regex_result.counts, presidio_result.counts),
    )


def _empty_counts() -> dict[str, int]:
    return {key: 0 for key in COUNT_KEYS}


def _regex_redact(text: str) -> RedactionResult:
    counts = _empty_counts()

    def redact_email(_match: re.Match[str]) -> str:
        counts["email"] += 1
        return "[EMAIL]"

    def redact_ssn(_match: re.Match[str]) -> str:
        counts["ssn"] += 1
        return "[SSN]"

    def redact_context_secret(match: re.Match[str]) -> str:
        counts["secret"] += 1
        return f"{match.group(1)}[SECRET]"

    def redact_secret_assignment(match: re.Match[str]) -> str:
        counts["secret"] += 1
        key = re.split(r"[:=]", match.group(0), maxsplit=1)[0].strip()
        return f"{key}=[SECRET]"

    def redact_secret_token(_match: re.Match[str]) -> str:
        counts["secret"] += 1
        return "[SECRET]"

    def redact_card(match: re.Match[str]) -> str:
        candidate = match.group(0)
        digits = re.sub(r"\D", "", candidate)
        if not _passes_luhn(digits):
            return candidate
        counts["credit_card"] += 1
        return "[CREDIT_CARD]"

    def redact_phone(match: re.Match[str]) -> str:
        candidate = match.group(0)
        digits = re.sub(r"\D", "", candidate)
        if len(digits) < 10 or len(digits) > 15 or _passes_luhn(digits):
            return candidate
        counts["phone"] += 1
        return "[PHONE]"

    text = re.sub(
        r"\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b",
        redact_email,
        text,
        flags=re.I,
    )
    text = re.sub(
        r"(^|[^\w])((?:aadhaar|आधार)\s*[:：#-]?\s*\d{4}\s?\d{4}\s?\d{4})(?!\w)",
        redact_context_secret,
        text,
        flags=re.I,
    )
    text = re.sub(
        r"(^|[^\w])((?:passport|passeport|pasaporte|पासपोर्ट)\s*[:：#-]?\s*"
        r"[A-Z0-9][A-Z0-9 -]{5,14}[A-Z0-9])(?!\w)",
        redact_context_secret,
        text,
        flags=re.I,
    )
    text = re.sub(
        r"\b[A-Z]{2}\d{2}(?:[ -]?[A-Z0-9]){11,30}\b",
        redact_secret_token,
        text,
    )
    text = re.sub(r"\b\d{3}-\d{2}-\d{4}\b", redact_ssn, text)
    text = re.sub(
        r"\b(?:access_token|refresh_token|id_token|api_key|client_secret|password|authorization)"
        r"\b\s*[:=]\s*[\"']?[^\"',}\s]+",
        redact_secret_assignment,
        text,
        flags=re.I,
    )
    text = re.sub(
        r"\b(?:github_pat|ghp|xox[baprs])[_A-Za-z0-9-]{16,}\b"
        r"|\b(?:sk|pk)_(?:live|test)_[A-Za-z0-9]{16,}\b",
        redact_secret_token,
        text,
    )
    text = re.sub(r"\b(?:\d[ -]*?){13,19}\b", redact_card, text)
    text = re.sub(
        r"(?<![A-Za-z0-9])(?:\+?\d[\d\s().-]{7,}\d)(?![A-Za-z0-9])",
        redact_phone,
        text,
    )
    return RedactionResult(text=text, counts=counts)


PRESIDIO_ENTITY_TOKENS: dict[str, tuple[str, str]] = {
    "EMAIL_ADDRESS": ("email", "[EMAIL]"),
    "PHONE_NUMBER": ("phone", "[PHONE]"),
    "CREDIT_CARD": ("credit_card", "[CREDIT_CARD]"),
    "US_SSN": ("ssn", "[SSN]"),
}

PRESIDIO_SECRET_ENTITIES = {
    "AU_ABN",
    "AU_ACN",
    "AU_MEDICARE",
    "AU_TFN",
    "CRYPTO",
    "DATE_TIME",
    "ES_NIF",
    "IBAN_CODE",
    "IN_AADHAAR",
    "IN_PAN",
    "IP_ADDRESS",
    "LOCATION",
    "MEDICAL_LICENSE",
    "NRP",
    "PERSON",
    "SG_NRIC_FIN",
    "UK_NHS",
    "US_BANK_NUMBER",
    "US_DRIVER_LICENSE",
    "US_ITIN",
    "US_PASSPORT",
}


def _presidio_redact(text: str) -> RedactionResult | None:
    if not text:
        return RedactionResult(text=text, counts=_empty_counts())
    engines = _presidio_engines()
    if engines is None:
        return None
    analyzer, anonymizer, operator_config = engines
    try:
        results = analyzer.analyze(text=text, language="en", score_threshold=0.35)
    except Exception:
        return None
    filtered = [
        result
        for result in results
        if result.entity_type in PRESIDIO_ENTITY_TOKENS
        or result.entity_type in PRESIDIO_SECRET_ENTITIES
    ]
    if not filtered:
        return RedactionResult(text=text, counts=_empty_counts())

    counts = _empty_counts()
    operators: dict[str, Any] = {}
    for result in filtered:
        count_key, token = PRESIDIO_ENTITY_TOKENS.get(result.entity_type, ("secret", "[SECRET]"))
        counts[count_key] += 1
        operators[result.entity_type] = operator_config("replace", {"new_value": token})

    try:
        anonymized = anonymizer.anonymize(text=text, analyzer_results=filtered, operators=operators)
    except Exception:
        return None
    return RedactionResult(text=anonymized.text, counts=counts)


@lru_cache(maxsize=1)
def _presidio_engines() -> tuple[Any, Any, Any] | None:
    try:
        from presidio_analyzer import AnalyzerEngine
        from presidio_analyzer.nlp_engine import NlpEngineProvider
        from presidio_anonymizer import AnonymizerEngine
        from presidio_anonymizer.entities import OperatorConfig

        nlp_engine = NlpEngineProvider(
            nlp_configuration={
                "nlp_engine_name": "spacy",
                "models": [{"lang_code": "en", "model_name": "en_core_web_sm"}],
            }
        ).create_engine()
        return AnalyzerEngine(nlp_engine=nlp_engine), AnonymizerEngine(), OperatorConfig
    except Exception:
        return None


def _merge_counts(first: dict[str, int], second: dict[str, int]) -> dict[str, int]:
    return {key: first.get(key, 0) + second.get(key, 0) for key in COUNT_KEYS}


def _passes_luhn(digits: str) -> bool:
    if not re.fullmatch(r"\d{13,19}", digits):
        return False
    total = 0
    alternate = False
    for char in reversed(digits):
        value = int(char)
        if alternate:
            value *= 2
            if value > 9:
                value -= 9
        total += value
        alternate = not alternate
    return total % 10 == 0
