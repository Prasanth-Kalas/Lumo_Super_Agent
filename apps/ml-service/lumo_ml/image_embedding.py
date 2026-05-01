from __future__ import annotations

import hashlib
import os
from typing import Any

from .schemas import EmbedImageRequest, EmbedImageResponse, ImageLabel

MODEL_NAME = "openai/clip-vit-base-patch32"
CLIP_DIMENSIONS = 512


def embed_image(req: EmbedImageRequest) -> EmbedImageResponse:
    runner = _load_modal_runner()
    if runner is None:
        return EmbedImageResponse(
            status="not_configured",
            model=MODEL_NAME,
            dimensions=CLIP_DIMENSIONS,
            embedding=[],
            labels=[],
            summary_text="",
            content_hash="",
            _lumo_summary="CLIP image embedding is scaffolded, but Modal is not configured.",
        )

    try:
        payload = runner.remote(
            req.image_url,
            candidate_labels=req.candidate_labels or None,
        )
        return _normalize_clip_payload(payload)
    except Exception as exc:  # pragma: no cover - exercised only with live Modal
        return EmbedImageResponse(
            status="error",
            model=MODEL_NAME,
            dimensions=CLIP_DIMENSIONS,
            embedding=[],
            labels=[],
            summary_text="",
            content_hash="",
            _lumo_summary=f"CLIP image embedding failed: {str(exc)[:180]}",
        )


def _load_modal_runner() -> Any | None:
    if not (os.getenv("MODAL_TOKEN_ID") and os.getenv("MODAL_TOKEN_SECRET")):
        return None
    try:
        from .modal_clip import embed_image_url
    except Exception:
        return None
    return embed_image_url


def _normalize_clip_payload(payload: Any) -> EmbedImageResponse:
    if not isinstance(payload, dict):
        return _malformed("CLIP image embedding returned a malformed payload.")

    embedding = _normalize_embedding(payload.get("embedding"))
    if not embedding:
        return _malformed("CLIP image embedding returned no vector.")

    labels = _normalize_labels(payload.get("labels"))
    summary_text = payload.get("summary_text")
    if not isinstance(summary_text, str) or not summary_text.strip():
        summary_text = _summary_from_labels(labels)

    content_hash = payload.get("content_hash")
    if not isinstance(content_hash, str) or not content_hash:
        content_hash = hashlib.sha256(summary_text.encode("utf-8")).hexdigest()

    model = payload.get("model")
    dimensions = _int(payload.get("dimensions")) or len(embedding)
    return EmbedImageResponse(
        status="ok",
        model=model if isinstance(model, str) and model else MODEL_NAME,
        dimensions=dimensions,
        embedding=embedding,
        labels=labels,
        summary_text=summary_text.strip(),
        content_hash=content_hash,
        _lumo_summary=(
            f"Embedded image with {len(labels)} label"
            f"{'s' if len(labels) != 1 else ''}."
        ),
    )


def _malformed(summary: str) -> EmbedImageResponse:
    return EmbedImageResponse(
        status="error",
        model=MODEL_NAME,
        dimensions=CLIP_DIMENSIONS,
        embedding=[],
        labels=[],
        summary_text="",
        content_hash="",
        _lumo_summary=summary,
    )


def _normalize_embedding(value: Any) -> list[float]:
    if not isinstance(value, list):
        return []
    out: list[float] = []
    for item in value:
        try:
            number = float(item)
        except (TypeError, ValueError):
            return []
        out.append(round(number, 8))
    return out


def _normalize_labels(value: Any) -> list[ImageLabel]:
    if not isinstance(value, list):
        return []
    out: list[ImageLabel] = []
    for raw in value[:12]:
        if not isinstance(raw, dict):
            continue
        label = raw.get("label")
        if not isinstance(label, str) or not label.strip():
            continue
        score = _float(raw.get("score"))
        out.append(ImageLabel(label=label.strip()[:120], score=max(0.0, min(1.0, score))))
    return out


def _summary_from_labels(labels: list[ImageLabel]) -> str:
    if not labels:
        return "Image embedding generated without labels."
    return "Image appears to contain: " + ", ".join(label.label for label in labels[:3]) + "."


def _float(value: Any) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        return 0.0


def _int(value: Any) -> int:
    try:
        n = int(value)
    except (TypeError, ValueError):
        return 0
    return max(0, n)
