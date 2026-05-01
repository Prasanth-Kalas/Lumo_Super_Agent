from __future__ import annotations

import modal

MODEL_NAME = "openai/clip-vit-base-patch32"
MAX_IMAGE_BYTES = 25 * 1024 * 1024

image = (
    modal.Image.debian_slim(python_version="3.11")
    .pip_install("httpx>=0.27.0", "pillow>=10.0.0", "torch>=2.2.0", "transformers>=4.44.0")
)

app = modal.App("lumo-clip")

DEFAULT_LABELS = [
    "travel document",
    "receipt",
    "restaurant food",
    "hotel room",
    "flight itinerary",
    "event ticket",
    "tourist attraction",
    "map or route",
    "electric vehicle charger",
    "calendar screenshot",
    "business chart",
    "contract document",
    "product photo",
    "landmark",
]


@app.function(image=image, gpu="T4", timeout=10 * 60, scaledown_window=60)
def embed_image_url(
    image_url: str,
    candidate_labels: list[str] | None = None,
) -> dict:
    import io

    import httpx
    import torch
    from PIL import Image
    from transformers import CLIPModel, CLIPProcessor

    labels = _clean_labels(candidate_labels or DEFAULT_LABELS)
    with httpx.stream("GET", image_url, follow_redirects=True, timeout=120) as response:
        response.raise_for_status()
        content_type = response.headers.get("content-type", "")
        if content_type and not content_type.lower().startswith("image/"):
            raise ValueError(f"URL did not return an image content type: {content_type[:80]}")
        total = 0
        chunks: list[bytes] = []
        for chunk in response.iter_bytes():
            total += len(chunk)
            if total > MAX_IMAGE_BYTES:
                raise ValueError("image file exceeds 25 MB")
            chunks.append(chunk)

    raw = b"".join(chunks)
    pil_image = Image.open(io.BytesIO(raw)).convert("RGB")
    device = "cuda" if torch.cuda.is_available() else "cpu"
    model = CLIPModel.from_pretrained(MODEL_NAME).to(device)
    processor = CLIPProcessor.from_pretrained(MODEL_NAME)

    image_inputs = processor(images=pil_image, return_tensors="pt").to(device)
    with torch.no_grad():
        image_features = model.get_image_features(**image_inputs)
        image_features = image_features / image_features.norm(dim=-1, keepdim=True)

    scored_labels = []
    if labels:
        text_inputs = processor(
            text=[f"a photo of {label}" for label in labels],
            images=pil_image,
            return_tensors="pt",
            padding=True,
        ).to(device)
        with torch.no_grad():
            outputs = model(**text_inputs)
            probs = outputs.logits_per_image.softmax(dim=1)[0].detach().cpu().tolist()
        scored_labels = sorted(
            [{"label": label, "score": float(score)} for label, score in zip(labels, probs)],
            key=lambda item: item["score"],
            reverse=True,
        )[:8]

    top = [item["label"] for item in scored_labels[:3]]
    summary = (
        "Image appears to contain: " + ", ".join(top) + "."
        if top
        else "Image embedding generated without label candidates."
    )
    return {
        "model": MODEL_NAME,
        "dimensions": int(image_features.shape[-1]),
        "embedding": [float(v) for v in image_features[0].detach().cpu().tolist()],
        "labels": scored_labels,
        "summary_text": summary,
        "content_hash": __import__("hashlib").sha256(raw).hexdigest(),
    }


def _clean_labels(values: list[str]) -> list[str]:
    out: list[str] = []
    seen: set[str] = set()
    for value in values[:64]:
        label = str(value).strip().lower()[:80]
        if not label or label in seen:
            continue
        seen.add(label)
        out.append(label)
    return out
