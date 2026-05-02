"""Modal app for BGE-large-en-v1.5 text embeddings.

Mirrors the shape of :mod:`lumo_ml.modal_clip` and
:mod:`lumo_ml.modal_whisper`: one Modal ``App`` per model, GPU-resident,
called from a thin local wrapper at :mod:`lumo_ml.core.embeddings` that
handles auth, telemetry, and Pydantic validation.

Design reference: ``apps/ml-service/docs/designs/embedding-service.md``
§2 (Modal serving) and §10 (implementation plan, item 3).

Cold-start budget ~10–15 s per container (model load from
``/weights`` Modal Volume after first cold start ever pulls weights
from HuggingFace into the Volume). Warm latency budget per the design
doc table — single-text ~40 ms, batch=32 ~6 ms/text.

Volume name ``lumo-bge-weights`` is shared across containers; weights
download once per Volume lifetime, not per container. ``HF_TOKEN`` is
not required (BGE-large-en-v1.5 is publicly downloadable) but the
Modal Secret already exists for other models and is harmless to attach.
"""

from __future__ import annotations

import modal

MODEL_NAME = "BAAI/bge-large-en-v1.5"
DIMENSIONS = 1024
MAX_BATCH = 64
MAX_INPUT_CHARS = 8192

image = (
    modal.Image.debian_slim(python_version="3.11")
    .pip_install("sentence-transformers>=3.2.0", "torch>=2.2.0")
)

app = modal.App("lumo-bge-large")
weights_volume = modal.Volume.from_name("lumo-bge-weights", create_if_missing=True)


@app.function(
    image=image,
    gpu="T4",
    timeout=2 * 60,
    scaledown_window=120,
    volumes={"/weights": weights_volume},
)
def embed_batch_remote(
    texts: list[str],
    instruction: str | None = None,
) -> dict:
    """Encode ``texts`` as BGE-large-en-v1.5 embeddings (1024-d, L2-normed).

    Returns a dict with ``embeddings`` (list of 1024-float lists),
    ``dimensions`` (always 1024), ``model`` (the HF id), and
    ``tokens_consumed`` (sum of tokenizer-reported token counts across
    inputs — the source of truth for cost calculation upstream).

    Raises ``ValueError`` if ``texts`` is empty, exceeds the batch
    cap, or contains an item exceeding the per-input character cap.
    """
    if not texts:
        raise ValueError("texts must contain at least one entry")
    if len(texts) > MAX_BATCH:
        raise ValueError(f"batch size {len(texts)} exceeds cap {MAX_BATCH}")
    for idx, text in enumerate(texts):
        if not isinstance(text, str):
            raise ValueError(f"texts[{idx}] is not a string")
        if not text.strip():
            raise ValueError(f"texts[{idx}] is empty/whitespace-only")
        if len(text) > MAX_INPUT_CHARS:
            raise ValueError(
                f"texts[{idx}] length {len(text)} exceeds {MAX_INPUT_CHARS}"
            )

    import torch
    from sentence_transformers import SentenceTransformer

    model = SentenceTransformer(MODEL_NAME, cache_folder="/weights")
    tokenizer = model.tokenizer

    if instruction:
        prefixed = [f"{instruction}: {text}" for text in texts]
    else:
        prefixed = list(texts)

    tokens_consumed = sum(
        len(tokenizer(prefix, add_special_tokens=True)["input_ids"])
        for prefix in prefixed
    )

    with torch.no_grad():
        vectors = model.encode(
            prefixed,
            normalize_embeddings=True,
            convert_to_numpy=True,
        )
    return {
        "embeddings": [vec.tolist() for vec in vectors],
        "dimensions": DIMENSIONS,
        "model": MODEL_NAME,
        "tokens_consumed": int(tokens_consumed),
    }
