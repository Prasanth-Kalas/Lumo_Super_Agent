from __future__ import annotations

from lumo_ml.transcription import _normalize_modal_payload


def test_normalize_modal_payload_preserves_speaker_labels() -> None:
    response = _normalize_modal_payload(
        {
            "transcript": "Hello. Hi back.",
            "segments": [
                {"start": 0, "end": 1.2, "text": "Hello.", "speaker": "SPEAKER_00"},
                {"start": 1.3, "end": 2.4, "text": "Hi back.", "speaker": "SPEAKER_01"},
            ],
            "language": "en",
            "duration_s": 2.5,
            "model": "whisper-large-v3",
            "diarization": "ok",
        },
        requested_language=None,
    )

    assert response.status == "ok"
    assert response.diarization == "ok"
    assert response.segments[0].speaker == "SPEAKER_00"
    assert response.segments[1].speaker == "SPEAKER_01"


def test_normalize_modal_payload_preserves_not_configured_warning() -> None:
    response = _normalize_modal_payload(
        {
            "transcript": "Hello.",
            "segments": [{"start": 0, "end": 1.2, "text": "Hello.", "speaker": None}],
            "language": "en",
            "duration_s": 1.2,
            "model": "whisper-large-v3",
            "diarization": "not_configured",
        },
        requested_language="en",
    )

    assert response.status == "ok"
    assert response.diarization == "not_configured"
    assert response.segments[0].speaker is None
