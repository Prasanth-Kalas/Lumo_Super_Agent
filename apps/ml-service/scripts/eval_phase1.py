from __future__ import annotations

import importlib.util
import json
import math
import sys
from pathlib import Path

from lumo_ml.schemas import (
    AgentDescriptor,
    ClassifyRequest,
    RankAgentsRequest,
    RecallDocument,
    RecallRequest,
    RiskRequest,
)
from lumo_ml.tools import classify, evaluate_agent_risk, rank_agents, recall

ROOT = Path(__file__).resolve().parents[1]
SEED_SPEC = importlib.util.spec_from_file_location(
    "lumo_seed_classify_examples",
    ROOT / "tests" / "test_classify.py",
)
if SEED_SPEC is None or SEED_SPEC.loader is None:
    raise RuntimeError("Could not load tests/test_classify.py seed examples")
seed_module = importlib.util.module_from_spec(SEED_SPEC)
sys.modules[SEED_SPEC.name] = seed_module
SEED_SPEC.loader.exec_module(seed_module)
EXAMPLES = seed_module.EXAMPLES


def main() -> int:
    results: list[dict[str, float | str | bool]] = []
    results.extend(eval_classifier_seed())
    results.append(eval_rank_ndcg())
    results.extend(eval_risk_badges())
    results.append(eval_recall_mrr())
    print(json.dumps({"phase": "phase1-ml-service", "results": results}, indent=2))
    failed = [result["name"] for result in results if not result["pass"]]
    if failed:
        print(f"Phase-1 ML eval failed: {', '.join(str(name) for name in failed)}", file=sys.stderr)
        return 1
    return 0


def eval_classifier_seed() -> list[dict[str, float | str | bool]]:
    labels = [example.lead for example in EXAMPLES]
    response = classify(
        ClassifyRequest(
            classifier="lead",
            items=[example.text for example in EXAMPLES],
            threshold=0.7,
        )
    )
    predictions = [item.above_threshold for item in response.items]
    stats = confusion(labels, predictions)
    return [
        metric("classifier_seed_precision", stats["precision"], 0.85, stats["precision"] >= 0.85),
        metric("classifier_seed_recall", stats["recall"], 0.85, stats["recall"] >= 0.85),
        metric("classifier_seed_f1", stats["f1"], 0.85, stats["f1"] >= 0.85),
    ]


def eval_rank_ndcg() -> dict[str, float | str | bool]:
    response = rank_agents(
        RankAgentsRequest(
            user_intent=(
                "I'm going to Vegas next Saturday for a week. Book flights, "
                "hotels, cabs, food, events, attractions, and EV charging if I drive."
            ),
            agents=agents(),
            installed_agent_ids=["flight"],
            limit=8,
        )
    )
    relevance = {
        "flight": 3,
        "hotel": 3,
        "open-maps": 3,
        "food": 2,
        "open-events": 2,
        "open-attractions": 2,
        "open-ev-charging": 1,
    }
    score = ndcg_at_k([item.agent_id for item in response.ranked_agents], relevance, 7)
    return metric("rank_agents_ndcg_at_7", score, 0.82, score >= 0.82)


def eval_risk_badges() -> list[dict[str, float | str | bool]]:
    badges = [
        evaluate_agent_risk(
            RiskRequest(
                agent=agent,
                requested_scopes=agent.scopes,
                category_peer_scopes=[["read"], ["read", "search"]],
            )
        )
        for agent in risk_agents()
    ]
    coverage = len(badges) / len(risk_agents())
    high = sum(1 for badge in badges if badge.risk_level == "high")
    return [
        metric("risk_badge_coverage", coverage, 1.0, coverage == 1.0),
        metric("risk_badge_high_count", high, 2.0, high >= 2),
    ]


def eval_recall_mrr() -> dict[str, float | str | bool]:
    cases = [
        ("Where did Alex mention Vegas partnership?", "archive_a"),
        ("Who asked about hotel resort fees?", "archive_b"),
        ("Find the EV charging note for Baker.", "archive_c"),
        ("Where is the conference keynote mention?", "archive_d"),
        ("Search for the paid food campaign.", "archive_e"),
    ]
    docs = recall_docs()
    reciprocal_ranks = []
    for query, expected_id in cases:
        response = recall(RecallRequest(query=query, documents=docs, top_k=5))
        rank = next(
            (index + 1 for index, hit in enumerate(response.hits) if hit.id == expected_id),
            0,
        )
        reciprocal_ranks.append(1 / rank if rank else 0)
    mrr = sum(reciprocal_ranks) / len(reciprocal_ranks)
    return metric("recall_mrr_at_5", mrr, 0.8, mrr >= 0.8)


def metric(name: str, value: float, threshold: float, passed: bool) -> dict[str, float | str | bool]:
    return {
        "name": name,
        "value": round(value, 3),
        "threshold": threshold,
        "pass": passed,
    }


def confusion(labels: list[bool], predictions: list[bool]) -> dict[str, float]:
    tp = sum(label and pred for label, pred in zip(labels, predictions, strict=True))
    fp = sum((not label) and pred for label, pred in zip(labels, predictions, strict=True))
    fn = sum(label and (not pred) for label, pred in zip(labels, predictions, strict=True))
    precision = tp / max(tp + fp, 1)
    recall_score = tp / max(tp + fn, 1)
    return {
        "precision": precision,
        "recall": recall_score,
        "f1": 2 * precision * recall_score / max(precision + recall_score, 1e-9),
    }


def ndcg_at_k(ids: list[str], relevance: dict[str, int], k: int) -> float:
    actual = dcg([relevance.get(agent_id, 0) for agent_id in ids[:k]])
    ideal = dcg(sorted(relevance.values(), reverse=True)[:k])
    return actual / ideal if ideal else 0


def dcg(relevance: list[int]) -> float:
    return sum((2**rel - 1) / math.log2(index + 2) for index, rel in enumerate(relevance))


def agents() -> list[AgentDescriptor]:
    return [
        agent("flight", "Lumo Flights", "Travel", ["search_flights"], [], True),
        agent("hotel", "Lumo Hotels", "Travel", ["search_hotels"], [], False),
        agent("open-maps", "Open Maps", "Maps", ["route", "taxi"], [], False),
        agent("food", "Food Delivery", "Food", ["order_food"], ["food:read", "food:orders"], False),
        agent("open-events", "Open Events", "Events", ["events"], [], False),
        agent("open-attractions", "Open Attractions", "Travel", ["attractions"], [], False),
        agent("open-ev-charging", "Open EV Charging", "EV", ["charging"], [], False),
    ]


def risk_agents() -> list[AgentDescriptor]:
    return [
        agent("weather", "Weather", "Weather", ["forecast"], [], False),
        agent("food", "Food Delivery", "Food", ["order_food"], ["food:read", "food:orders", "payment_method:read", "address:read"], False, True, ["address", "phone", "payment_method_id"]),
        agent("flight", "Flight Booking", "Travel", ["book_flight"], ["flight:book", "passport:read", "payment_method:read"], False, True, ["passport", "payment_method_id"]),
        agent("email", "Email", "Productivity", ["email"], ["email:read", "email:send"], False, False, ["email"]),
    ]


def agent(
    agent_id: str,
    display_name: str,
    category: str,
    intents: list[str],
    scopes: list[str],
    installed: bool,
    requires_payment: bool = False,
    pii_scope: list[str] | None = None,
) -> AgentDescriptor:
    return AgentDescriptor(
        agent_id=agent_id,
        display_name=display_name,
        domain=category.lower(),
        category=category,
        intents=intents,
        scopes=scopes,
        installed=installed,
        connect_model="oauth2" if scopes else "none",
        requires_payment=requires_payment,
        pii_scope=pii_scope or [],
    )


def recall_docs() -> list[RecallDocument]:
    return [
        doc("archive_a", "Alex mentioned the Vegas partnership idea in the creator inbox.", "meta"),
        doc("archive_b", "Maya asked about hotel resort fees before Saturday check-in.", "hotel"),
        doc("archive_c", "Driving note: stop for EV charging in Baker before Las Vegas.", "ev"),
        doc("archive_d", "Conference organizer asked about a keynote slot and speaker fee.", "youtube"),
        doc("archive_e", "Brand lead asked for a paid food campaign and media kit.", "food"),
        doc("archive_f", "General engineering sync with no travel context.", "github"),
    ]


def doc(id_: str, text: str, source: str) -> RecallDocument:
    return RecallDocument(id=id_, text=text, source=source, metadata={"endpoint": "eval"})


if __name__ == "__main__":
    raise SystemExit(main())
