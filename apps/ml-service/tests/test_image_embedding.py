from __future__ import annotations

from lumo_ml.image_embedding import _normalize_clip_payload


def test_normalize_clip_payload_preserves_embedding_and_labels() -> None:
    result = _normalize_clip_payload(
        {
            "model": "openai/clip-vit-base-patch32",
            "dimensions": 3,
            "embedding": [0.1, "0.2", -0.3],
            "labels": [
                {"label": "receipt", "score": 0.8},
                {"label": "hotel room", "score": 0.1},
            ],
            "summary_text": "Image appears to contain: receipt.",
            "content_hash": "abc123",
        }
    )

    assert result.status == "ok"
    assert result.dimensions == 3
    assert result.embedding == [0.1, 0.2, -0.3]
    assert result.labels[0].label == "receipt"
    assert result.content_hash == "abc123"


def test_normalize_clip_payload_malformed_vector_degrades() -> None:
    result = _normalize_clip_payload({"embedding": "broken"})

    assert result.status == "error"
    assert result.embedding == []
