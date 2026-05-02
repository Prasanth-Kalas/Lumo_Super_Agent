from __future__ import annotations

import os
from typing import Any

import httpx

from .schemas import TranscribeRequest, TranscribeResponse, TranscriptSegment

MODEL_NAME = "nova-3"
DEEPGRAM_LISTEN_URL = "https://api.deepgram.com/v1/listen"
REQUEST_TIMEOUT_S = 45.0


def transcribe_audio(req: TranscribeRequest) -> TranscribeResponse:
    api_key = os.getenv("LUMO_DEEPGRAM_API_KEY")
    if not api_key:
        return TranscribeResponse(
            status="not_configured",
            transcript="",
            segments=[],
            language=req.language,
            duration_s=0,
            model=MODEL_NAME,
            diarization="not_configured" if req.speaker_diarization else "not_requested",
            _lumo_summary="Deepgram transcription is scaffolded, but LUMO_DEEPGRAM_API_KEY is not configured.",
        )

    try:
        payload = _call_deepgram(api_key, req)
        return _normalize_deepgram_payload(payload, req.language, req.speaker_diarization)
    except Exception as exc:  # pragma: no cover - exercised only with live provider
        return TranscribeResponse(
            status="error",
            transcript="",
            segments=[],
            language=req.language,
            duration_s=0,
            model=MODEL_NAME,
            diarization="error" if req.speaker_diarization else "not_requested",
            _lumo_summary=f"Deepgram transcription failed: {str(exc)[:180]}",
        )


def _call_deepgram(api_key: str, req: TranscribeRequest) -> dict[str, Any]:
    params: dict[str, str] = {
        "model": MODEL_NAME,
        "smart_format": "true",
    }
    if req.language:
        params["language"] = req.language
    if req.speaker_diarization:
        params["diarize"] = "true"
    with httpx.Client(timeout=REQUEST_TIMEOUT_S) as client:
        response = client.post(
            DEEPGRAM_LISTEN_URL,
            params=params,
            headers={
                "Authorization": f"Token {api_key}",
                "Content-Type": "application/json",
            },
            json={"url": req.audio_url},
        )
        response.raise_for_status()
        payload = response.json()
    if not isinstance(payload, dict):
        raise ValueError("Deepgram returned a malformed payload")
    return payload


def _normalize_deepgram_payload(
    payload: Any,
    requested_language: str | None,
    speaker_diarization: bool = False,
) -> TranscribeResponse:
    if not isinstance(payload, dict):
        return TranscribeResponse(
            status="error",
            transcript="",
            segments=[],
            language=requested_language,
            duration_s=0,
            model=MODEL_NAME,
            diarization="error",
            _lumo_summary="Deepgram transcription returned a malformed payload.",
        )

    alternative = _first_alternative(payload)
    transcript = ""
    language = requested_language
    segments: list[TranscriptSegment] = []
    if alternative:
        transcript = str(alternative.get("transcript") or "").strip()
        language_value = alternative.get("detected_language") or requested_language
        language = language_value if isinstance(language_value, str) else requested_language
        segments = _segments_from_words(alternative.get("words"))

    metadata = payload.get("metadata")
    duration_s = _float(metadata.get("duration") if isinstance(metadata, dict) else None)
    model = MODEL_NAME
    if isinstance(metadata, dict):
        model_info = metadata.get("model_info")
        if isinstance(model_info, dict):
            first = next(iter(model_info.values()), None)
            if isinstance(first, dict) and isinstance(first.get("name"), str):
                model = first["name"]
    diarization = "not_requested"
    if speaker_diarization:
        diarization = "ok" if any(segment.speaker for segment in segments) else "not_configured"

    return TranscribeResponse(
        status="ok" if transcript else "error",
        transcript=transcript,
        segments=segments,
        language=language,
        duration_s=duration_s,
        model=model if isinstance(model, str) and model else MODEL_NAME,
        diarization=diarization,
        _lumo_summary=(
            _summary(len(segments), diarization)
            if transcript
            else "Deepgram transcription returned no transcript text."
        ),
    )


def _first_alternative(payload: dict[str, Any]) -> dict[str, Any] | None:
    results = payload.get("results")
    if not isinstance(results, dict):
        return None
    channels = results.get("channels")
    if not isinstance(channels, list) or not channels:
        return None
    first_channel = channels[0]
    if not isinstance(first_channel, dict):
        return None
    alternatives = first_channel.get("alternatives")
    if not isinstance(alternatives, list) or not alternatives:
        return None
    alternative = alternatives[0]
    return alternative if isinstance(alternative, dict) else None


def _segments_from_words(words: Any) -> list[TranscriptSegment]:
    if not isinstance(words, list):
        return []
    segments: list[TranscriptSegment] = []
    current: dict[str, Any] | None = None
    for raw in words:
        if not isinstance(raw, dict):
            continue
        word = raw.get("punctuated_word") or raw.get("word")
        if not isinstance(word, str) or not word.strip():
            continue
        speaker = raw.get("speaker")
        # Match the SPEAKER_NN zero-padded convention asserted by
        # tests/test_transcription.py (also matches pyannote / whisper-
        # diarization output). Caught by SUGGESTIONS-MIGRATE-PYTHON-1's
        # CI; the DEEPGRAM-MIGRATION-1 lane shipped without padding.
        speaker_label = f"SPEAKER_{speaker:02d}" if isinstance(speaker, int) else None
        if current is None or current["speaker"] != speaker_label:
            if current is not None:
                segments.append(_segment_from_current(current))
            current = {
                "speaker": speaker_label,
                "start": _float(raw.get("start")),
                "end": _float(raw.get("end")),
                "text": [word.strip()],
            }
        else:
            current["end"] = max(_float(raw.get("end")), float(current["end"]))
            current["text"].append(word.strip())
    if current is not None:
        segments.append(_segment_from_current(current))
    return segments


def _segment_from_current(current: dict[str, Any]) -> TranscriptSegment:
    return TranscriptSegment(
        start=float(current["start"]),
        end=max(float(current["start"]), float(current["end"])),
        text=" ".join(current["text"]).strip(),
        speaker=current["speaker"],
    )


# Backwards-compatible test hook name retained for callers that still import it.
def _normalize_modal_payload(payload: Any, requested_language: str | None) -> TranscribeResponse:
    return _normalize_deepgram_payload(payload, requested_language)


def _float(value: Any) -> float:
    try:
        n = float(value)
    except (TypeError, ValueError):
        return 0.0
    return max(0.0, n)


def _summary(segment_count: int, diarization: str) -> str:
    base = f"Transcribed {segment_count} audio segment{'s' if segment_count != 1 else ''}."
    if diarization == "ok":
        return f"{base} Speaker diarization labels are included."
    if diarization == "not_configured":
        return f"{base} Speaker diarization is not configured; speaker labels are null."
    if diarization == "error":
        return f"{base} Speaker diarization failed; speaker labels are null."
    return base
