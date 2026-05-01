from __future__ import annotations

from lumo_ml.redaction import COUNT_KEYS, redact_for_embedding


def test_redacts_french_contact_and_bank_identifiers() -> None:
    redacted = redact_for_embedding(
        "Bonjour, contactez elise.dupont@example.fr ou +33 6 12 34 56 78. "
        "IBAN FR76 3000 6000 0112 3456 7890 189."
    )

    assert set(redacted.counts) == set(COUNT_KEYS)
    assert "[EMAIL]" in redacted.text
    assert "[PHONE]" in redacted.text
    assert "[SECRET]" in redacted.text
    assert "example.fr" not in redacted.text
    assert "FR76" not in redacted.text
    assert redacted.counts["email"] == 1
    assert redacted.counts["phone"] == 1
    assert redacted.counts["secret"] >= 1


def test_redacts_spanish_contact_and_passport_identifiers() -> None:
    redacted = redact_for_embedding(
        "Telefono +34 612 345 678, correo ana.garcia@example.es, pasaporte X1234567."
    )

    assert "[EMAIL]" in redacted.text
    assert "[PHONE]" in redacted.text
    assert "[SECRET]" in redacted.text
    assert "example.es" not in redacted.text
    assert "X1234567" not in redacted.text
    assert redacted.counts["email"] == 1
    assert redacted.counts["phone"] == 1
    assert redacted.counts["secret"] >= 1


def test_redacts_hindi_contact_and_aadhaar_identifiers() -> None:
    redacted = redact_for_embedding(
        "ईमेल ravi.kumar@example.in और फोन +91 98765 43210. आधार 1234 5678 9012."
    )

    assert "[EMAIL]" in redacted.text
    assert "[PHONE]" in redacted.text
    assert "[SECRET]" in redacted.text
    assert "example.in" not in redacted.text
    assert "1234 5678 9012" not in redacted.text
    assert redacted.counts["email"] == 1
    assert redacted.counts["phone"] == 1
    assert redacted.counts["secret"] >= 1
