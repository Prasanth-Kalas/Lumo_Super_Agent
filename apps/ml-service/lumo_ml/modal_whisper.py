from __future__ import annotations

import modal

MODEL_NAME = "whisper-large-v3"
MAX_AUDIO_BYTES = 200 * 1024 * 1024

image = (
    modal.Image.debian_slim(python_version="3.11")
    .apt_install("ffmpeg")
    .pip_install("faster-whisper>=1.1.1", "httpx>=0.27.0", "pyannote.audio>=3.3.2")
)

app = modal.App("lumo-whisper")


@app.function(image=image, gpu="T4", timeout=30 * 60, scaledown_window=60)
def transcribe_audio_url(
    audio_url: str,
    language: str | None = None,
    speaker_diarization: bool = False,
) -> dict:
    import os
    import tempfile
    from pathlib import Path

    import httpx
    from faster_whisper import WhisperModel

    suffix = ".audio"
    with tempfile.TemporaryDirectory() as tmp:
        path = Path(tmp) / f"input{suffix}"
        total = 0
        with httpx.stream("GET", audio_url, follow_redirects=True, timeout=120) as response:
            response.raise_for_status()
            with path.open("wb") as fh:
                for chunk in response.iter_bytes():
                    total += len(chunk)
                    if total > MAX_AUDIO_BYTES:
                        raise ValueError("audio file exceeds 200 MB")
                    fh.write(chunk)

        model = WhisperModel("large-v3", device="cuda", compute_type="float16")
        segments_iter, info = model.transcribe(
            str(path),
            language=language,
            vad_filter=True,
            beam_size=5,
        )
        segments = []
        for segment in segments_iter:
            text = (segment.text or "").strip()
            if not text:
                continue
            segments.append(
                {
                    "start": float(segment.start),
                    "end": float(segment.end),
                    "text": text,
                    "speaker": None,
                }
            )

        diarization_status = "not_requested"
        if speaker_diarization:
            token = (
                os.getenv("PYANNOTE_AUTH_TOKEN")
                or os.getenv("HUGGINGFACE_TOKEN")
                or os.getenv("HF_TOKEN")
            )
            if token:
                diarization_status = _assign_speakers(path, segments, token)
            else:
                diarization_status = "not_configured"

        transcript = " ".join(segment["text"] for segment in segments).strip()
        return {
            "transcript": transcript,
            "segments": segments,
            "language": getattr(info, "language", None) or language,
            "duration_s": float(getattr(info, "duration", 0) or 0),
            "model": MODEL_NAME,
            "diarization": diarization_status,
        }


def _assign_speakers(path, segments: list[dict], token: str) -> str:
    if not segments:
        return "not_configured"
    try:
        import torch
        from pyannote.audio import Pipeline
    except Exception:
        return "not_configured"

    try:
        pipeline = Pipeline.from_pretrained(
            "pyannote/speaker-diarization-3.1",
            use_auth_token=token,
        )
        if torch.cuda.is_available():
            pipeline.to(torch.device("cuda"))
        diarization = pipeline(str(path))
    except Exception:
        return "not_configured"

    turns: list[tuple[float, float, str]] = []
    for turn, _track, speaker in diarization.itertracks(yield_label=True):
        turns.append((float(turn.start), float(turn.end), str(speaker)))
    if not turns:
        return "not_configured"

    for segment in segments:
        speaker = _best_speaker_for_segment(
            float(segment.get("start", 0) or 0),
            float(segment.get("end", 0) or 0),
            turns,
        )
        segment["speaker"] = speaker
    return "ok" if any(segment.get("speaker") for segment in segments) else "not_configured"


def _best_speaker_for_segment(
    start: float,
    end: float,
    turns: list[tuple[float, float, str]],
) -> str | None:
    best_speaker: str | None = None
    best_overlap = 0.0
    for turn_start, turn_end, speaker in turns:
        overlap = max(0.0, min(end, turn_end) - max(start, turn_start))
        if overlap > best_overlap:
            best_overlap = overlap
            best_speaker = speaker
    return best_speaker
