from __future__ import annotations

import os
from typing import Any

from .schemas import TranscribeRequest, TranscribeResponse, TranscriptSegment

MODEL_NAME = "whisper-large-v3"


def transcribe_audio(req: TranscribeRequest) -> TranscribeResponse:
    runner = _load_modal_runner()
    if runner is None:
        return TranscribeResponse(
            status="not_configured",
            transcript="",
            segments=[],
            language=req.language,
            duration_s=0,
            model=MODEL_NAME,
            diarization="not_configured" if req.speaker_diarization else "not_requested",
            _lumo_summary="Whisper transcription is scaffolded, but Modal is not configured.",
        )

    try:
        payload = runner.remote(
            req.audio_url,
            language=req.language,
            speaker_diarization=req.speaker_diarization,
        )
        return _normalize_modal_payload(payload, req.language)
    except Exception as exc:  # pragma: no cover - exercised only with live Modal
        return TranscribeResponse(
            status="error",
            transcript="",
            segments=[],
            language=req.language,
            duration_s=0,
            model=MODEL_NAME,
            diarization="error" if req.speaker_diarization else "not_requested",
            _lumo_summary=f"Whisper transcription failed: {str(exc)[:180]}",
        )


def _load_modal_runner() -> Any | None:
    if not (os.getenv("MODAL_TOKEN_ID") and os.getenv("MODAL_TOKEN_SECRET")):
        return None
    try:
        from .modal_whisper import transcribe_audio_url
    except Exception:
        return None
    return transcribe_audio_url


def _normalize_modal_payload(payload: Any, requested_language: str | None) -> TranscribeResponse:
    if not isinstance(payload, dict):
        return TranscribeResponse(
            status="error",
            transcript="",
            segments=[],
            language=requested_language,
            duration_s=0,
            model=MODEL_NAME,
            diarization="error",
            _lumo_summary="Whisper transcription returned a malformed payload.",
        )

    raw_segments = payload.get("segments")
    segments: list[TranscriptSegment] = []
    if isinstance(raw_segments, list):
        for item in raw_segments:
            if not isinstance(item, dict):
                continue
            text = item.get("text")
            if not isinstance(text, str) or not text.strip():
                continue
            start = _float(item.get("start"))
            end = max(start, _float(item.get("end")))
            speaker = item.get("speaker")
            segments.append(
                TranscriptSegment(
                    start=start,
                    end=end,
                    text=text.strip(),
                    speaker=speaker if isinstance(speaker, str) else None,
                )
            )

    transcript = payload.get("transcript")
    if not isinstance(transcript, str):
        transcript = " ".join(segment.text for segment in segments)
    transcript = transcript.strip()

    language = payload.get("language")
    duration_s = _float(payload.get("duration_s"))
    model = payload.get("model")
    diarization = payload.get("diarization")
    if diarization not in {"not_requested", "ok", "not_configured", "error"}:
        diarization = "ok" if any(segment.speaker for segment in segments) else "not_requested"

    return TranscribeResponse(
        status="ok" if transcript else "error",
        transcript=transcript,
        segments=segments,
        language=language if isinstance(language, str) else requested_language,
        duration_s=duration_s,
        model=model if isinstance(model, str) and model else MODEL_NAME,
        diarization=diarization,
        _lumo_summary=(
            _summary(len(segments), diarization)
            if transcript
            else "Whisper transcription returned no transcript text."
        ),
    )


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
