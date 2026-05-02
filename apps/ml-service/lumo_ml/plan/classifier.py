"""Anchor-based zero-shot intent classifier for ``POST /api/tools/plan``.

Replaces the Phase 0 stub with a real bucket assignment that mirrors the
TS reference (``apps/web/lib/perf/intent-classifier.ts``):

    * fast_path: simple Q&A, status, rewrite, greeting; no private data,
      no purchases, no multi-step planning.
    * tool_path: 1–3 tool / installed-agent calls; light reasoning.
    * reasoning_path: money movement, travel booking, compound plans,
      ambiguous / high-stakes; permission/card confirmations; low
      confidence.

Approach
--------

A small set of *anchor sentences* per bucket is embedded once at
container start-up (singleton). At classify time, the user message is
embedded and scored against each anchor set by mean cosine similarity;
the bucket with the highest mean wins, the gap to the runner-up is
the confidence proxy. Below ``MIN_CONFIDENCE`` we default to
``reasoning_path`` — same conservative fallback the TS classifier
applies.

Before the embedding step we run a *deterministic flight-search guard*
that ports ``looksLikeFlightOfferRequest`` from the TS reference. The
guard upgrades any flight-search-shaped message to ``tool_path``
regardless of similarity scores — this matches the
``DUFFEL-DISPATCH-REGRESSION-DIAG-1`` behaviour.

Why anchor-based and not LLM-call: the TS classifier hits Groq/Cerebras
on every turn; this brain runs on Modal CPU and would pay a 200-500 ms
hop per call. A local sentence-encoder is < 50 ms per inference on
``all-MiniLM-L6-v2`` and gives codex's parallel-write a deterministic
baseline they can compare directly against the LLM output.
"""

from __future__ import annotations

import os
import re
import threading
from typing import TYPE_CHECKING, ClassVar, Literal

from pydantic import BaseModel, Field

if TYPE_CHECKING:
    import numpy as np
    from numpy.typing import NDArray
    from sentence_transformers import SentenceTransformer


Bucket = Literal["fast_path", "tool_path", "reasoning_path"]
DEFAULT_MODEL = "sentence-transformers/all-MiniLM-L6-v2"
# Empirically, mean-cosine of a normalized message embedding against an
# in-bucket anchor set sits in [0.10, 0.45]; out-of-bucket sits in
# [0.00, 0.20]. We treat ``top_score < MIN_TOP_SCORE`` as "no bucket
# matched well enough" and fall back to reasoning_path; otherwise the
# top bucket wins regardless of the gap to the runner-up. The runner-
# up gap is folded into the *reported* confidence but doesn't change
# the routing decision unless the top score is itself weak.
MIN_TOP_SCORE = 0.08

# ──────────────────────────────────────────────────────────────────────
# Anchors — calibrated against the eval harness in
# tests/test_intent_classifier_eval.py. Tighten / widen here, never in
# the route code.
# ──────────────────────────────────────────────────────────────────────

FAST_PATH_ANCHORS: tuple[str, ...] = (
    "hi",
    "hello",
    "thanks",
    "what time is it",
    "what is the capital of France",
    "explain photosynthesis briefly",
    "rewrite this sentence to be shorter",
    "how do you spell accommodation",
    "summarize this paragraph",
    "translate hello to Spanish",
    "what does API stand for",
    "convert 100 USD to EUR",
)

TOOL_PATH_ANCHORS: tuple[str, ...] = (
    "show me my unread emails",
    "find a sushi restaurant near me",
    "book me a flight to Vegas",
    "what's the weather in Chicago tomorrow",
    "send a message to my landlord",
    "play my workout playlist",
    "set a reminder for 5pm",
    "search my notes for the partnership idea",
    "find an EV charger nearby",
    "look up flights from SFO to JFK next Friday",
    "show events near me this weekend",
    "find me a hotel in Vegas",
)

REASONING_PATH_ANCHORS: tuple[str, ...] = (
    "plan a Vegas weekend with flight and hotel and dinner reservations",
    "plan a 4-day Tokyo trip combining flights, hotel, sushi, and museums",
    "plan a multi-stop travel itinerary covering three cities with budget constraints",
    "should I refinance my mortgage given current rates",
    "help me decide which of these five apartments to rent",
    "compare these three job offers and recommend one",
    "design a two-week travel itinerary across Europe with a $3000 budget",
    "should I sell my Apple stock this quarter",
    "help me draft a multi-step launch plan for my product",
    "review this contract and flag risky clauses",
    "I want to buy a house — walk me through the offer process",
    "evaluate whether I should take this job in another city",
    "plan my retirement portfolio rebalance",
    "given my receipts this year, build me a budget for next year",
    "coordinate a multi-vendor event with venue, catering, and entertainment",
)

ANCHORS: dict[Bucket, tuple[str, ...]] = {
    "fast_path": FAST_PATH_ANCHORS,
    "tool_path": TOOL_PATH_ANCHORS,
    "reasoning_path": REASONING_PATH_ANCHORS,
}


# ──────────────────────────────────────────────────────────────────────
# Deterministic flight-search guard — ported from TS reference.
# ──────────────────────────────────────────────────────────────────────

_FLIGHT_RE = re.compile(
    r"\b(flight|flights|fly|airfare|fare|fares|airline|airlines|airport|airports)\b",
    re.IGNORECASE,
)
_SEARCH_VERB_RE = re.compile(
    r"\b(find|look|lookup|search|show|get|book|need|want|compare|price|prices|"
    r"option|options)\b",
    re.IGNORECASE,
)
_ROUTE_RE = re.compile(
    r"\b(from|to|between|depart|leav(?:e|ing)|arriv(?:e|ing)|"
    r"ord|mdw|chicago|las|vegas|nyc|jfk|lga|ewr|sfo|lax|mia)\b",
    re.IGNORECASE,
)


def looks_like_flight_offer_request(message: str) -> bool:
    """Port of ``looksLikeFlightOfferRequest`` from
    ``apps/web/lib/perf/intent-classifier.ts``. Returns True iff the
    message has a flight word, a search/booking verb, AND a route hint
    — same precondition order as the TS guard so codex's parallel-write
    sees identical regex behaviour for this fast path.
    """
    if not message.strip():
        return False
    if not _FLIGHT_RE.search(message):
        return False
    return bool(_SEARCH_VERB_RE.search(message) and _ROUTE_RE.search(message))


# ──────────────────────────────────────────────────────────────────────
# Result schema (NOT in lumo_ml.plan.schemas — internal to the classifier
# module; the wire-level PlanResponse.intent_bucket consumes only the
# bucket field).
# ──────────────────────────────────────────────────────────────────────


class IntentClassification(BaseModel):
    bucket: Bucket
    confidence: float = Field(ge=0, le=1)
    reasoning: str = Field(max_length=240)
    # ``top_score`` and ``gap`` are the raw similarity signals the
    # router lifts into ``X-Lumo-Plan-*`` response headers so codex's
    # parallel-write ``agent_plan_compare`` capture has first-class
    # telemetry fields instead of regex-parsing the reasoning string.
    # Both are ``None`` when the deterministic flight-search guard
    # short-circuits the embedding step (the guard is a binary signal,
    # not a score-based decision).
    top_score: float | None = Field(default=None, ge=0, le=1)
    gap: float | None = Field(default=None, ge=0, le=1)


# ──────────────────────────────────────────────────────────────────────
# Classifier
# ──────────────────────────────────────────────────────────────────────


class IntentClassifier:
    """Singleton anchor-based classifier. Loads the sentence-encoder
    once per process; subsequent ``classify()`` calls only re-encode
    the user message (~5–50 ms on CPU depending on model size).
    """

    _instance: ClassVar["IntentClassifier | None"] = None
    _instance_lock: ClassVar[threading.Lock] = threading.Lock()

    def __init__(self, model_name: str = DEFAULT_MODEL, cache_dir: str | None = None):
        self.model_name = model_name
        # cache_dir: None → sentence-transformers default (~/.cache/...).
        # On Modal we set it to /models (mounted Volume) so weights
        # survive container restarts and cold starts skip the HF download.
        self.cache_dir = cache_dir or os.environ.get("LUMO_ML_MODEL_CACHE")
        self._model: SentenceTransformer | None = None
        self._anchor_embeddings: dict[Bucket, NDArray[np.floating]] | None = None
        self._load_lock = threading.Lock()

    @classmethod
    def get_instance(cls) -> "IntentClassifier":
        if cls._instance is None:
            with cls._instance_lock:
                if cls._instance is None:
                    cls._instance = cls()
        return cls._instance

    def _ensure_loaded(self) -> None:
        if self._model is not None:
            return
        with self._load_lock:
            if self._model is not None:
                return
            from sentence_transformers import SentenceTransformer

            kwargs: dict[str, str] = {}
            if self.cache_dir:
                kwargs["cache_folder"] = self.cache_dir
            model = SentenceTransformer(self.model_name, **kwargs)
            anchor_embeddings: dict[Bucket, NDArray[np.floating]] = {}
            for bucket, anchors in ANCHORS.items():
                anchor_embeddings[bucket] = model.encode(
                    list(anchors),
                    normalize_embeddings=True,
                    convert_to_numpy=True,
                )
            self._model = model
            self._anchor_embeddings = anchor_embeddings

    def warmup(self) -> None:
        """Force-load the model + anchors. Useful at container start so
        the first real classify() call doesn't pay the load cost."""
        self._ensure_loaded()

    def classify(self, user_message: str, history: list[object] | None = None) -> IntentClassification:
        # ``history`` is accepted for forward-compat with the brief's
        # signature but ignored in this Phase 1 implementation — the TS
        # reference also classifies on the latest user turn only (see
        # ``buildClassifierFeatures`` last_user_message).
        del history

        message = user_message.strip()

        if looks_like_flight_offer_request(message):
            return IntentClassification(
                bucket="tool_path",
                confidence=1.0,
                reasoning="matched flight-search guard (regex)",
            )

        if not message:
            return IntentClassification(
                bucket="reasoning_path",
                confidence=1.0,
                reasoning="empty message; defaulted to reasoning_path",
            )

        self._ensure_loaded()
        assert self._model is not None and self._anchor_embeddings is not None

        import numpy as np

        msg_embedding: NDArray[np.floating] = self._model.encode(
            message,
            normalize_embeddings=True,
            convert_to_numpy=True,
        )

        scores: dict[Bucket, float] = {}
        for bucket, anchors in self._anchor_embeddings.items():
            sims = anchors @ msg_embedding
            scores[bucket] = float(np.mean(sims))

        ranked = sorted(scores.items(), key=lambda kv: kv[1], reverse=True)
        top_bucket, top_score = ranked[0]
        second_score = ranked[1][1]
        gap = top_score - second_score

        # Reported confidence: blends absolute top score with the gap
        # to the runner-up. Both signals matter — a high top with a
        # small gap is "soft pick", a moderate top with a large gap
        # is "clear winner". Calibrated empirically against the eval
        # harness; doesn't gate routing.
        confidence = max(0.0, min(1.0, top_score * 2 + gap * 2))
        # Clamp the raw signals to [0, 1] for the IntentClassification
        # contract — anchor cosine means are bounded but can dip
        # slightly negative on adversarial inputs.
        top_score_clamped = max(0.0, min(1.0, top_score))
        gap_clamped = max(0.0, min(1.0, gap))

        if top_score < MIN_TOP_SCORE:
            return IntentClassification(
                bucket="reasoning_path",
                confidence=confidence,
                reasoning=(
                    f"weak top match {top_bucket} (top={top_score:.3f} "
                    f"< {MIN_TOP_SCORE}); defaulted to reasoning_path"
                ),
                top_score=top_score_clamped,
                gap=gap_clamped,
            )

        return IntentClassification(
            bucket=top_bucket,
            confidence=confidence,
            reasoning=f"anchor-similarity {top_bucket} (top={top_score:.3f}, gap={gap:.3f})",
            top_score=top_score_clamped,
            gap=gap_clamped,
        )
