from __future__ import annotations

from lumo_ml.transcription import _normalize_deepgram_payload


def test_normalize_deepgram_payload_preserves_speaker_labels() -> None:
    response = _normalize_deepgram_payload(
        {
            "metadata": {"duration": 2.5, "model_info": {"x": {"name": "nova-3"}}},
            "results": {
                "channels": [
                    {
                        "alternatives": [
                            {
                                "transcript": "Hello. Hi back.",
                                "detected_language": "en",
                                "words": [
                                    {
                                        "start": 0,
                                        "end": 1.2,
                                        "punctuated_word": "Hello.",
                                        "speaker": 0,
                                    },
                                    {
                                        "start": 1.3,
                                        "end": 2.4,
                                        "punctuated_word": "Hi back.",
                                        "speaker": 1,
                                    },
                                ],
                            }
                        ]
                    }
                ]
            },
        },
        requested_language=None,
        speaker_diarization=True,
    )

    assert response.status == "ok"
    assert response.diarization == "ok"
    assert response.segments[0].speaker == "SPEAKER_00"
    assert response.segments[1].speaker == "SPEAKER_01"


def test_normalize_deepgram_payload_preserves_not_configured_warning() -> None:
    response = _normalize_deepgram_payload(
        {
            "metadata": {"duration": 1.2},
            "results": {
                "channels": [
                    {
                        "alternatives": [
                            {
                                "transcript": "Hello.",
                                "detected_language": "en",
                                "words": [
                                    {
                                        "start": 0,
                                        "end": 1.2,
                                        "punctuated_word": "Hello.",
                                    }
                                ],
                            }
                        ]
                    }
                ]
            },
        },
        requested_language="en",
        speaker_diarization=True,
    )

    assert response.status == "ok"
    assert response.diarization == "not_configured"
    assert response.segments[0].speaker is None
