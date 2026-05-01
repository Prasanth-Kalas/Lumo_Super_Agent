from __future__ import annotations

from lumo_ml.schemas import KgEvidenceItem, KgSynthesizeRequest, KgTraversalItem
from lumo_ml.tools import kg_synthesize


def test_kg_synthesize_returns_cited_answer_for_blocking_evidence() -> None:
    res = kg_synthesize(
        KgSynthesizeRequest(
            question="Why did Sam pick Vegas over Tahoe?",
            traversal=[
                KgTraversalItem(
                    node_id="storm",
                    label="event",
                    depth=1,
                    score=0.9,
                    path=["tahoe", "storm"],
                    edge_types=["BLOCKED_BY"],
                    evidence=[
                        KgEvidenceItem(
                            kind="node",
                            node_id="tahoe",
                            label="mission",
                            source_table="missions",
                            source_row_id="mission_tahoe",
                            source_url="/missions/mission_tahoe",
                            text="Canceled Tahoe mission",
                        ),
                        KgEvidenceItem(
                            kind="edge",
                            edge_id="edge_storm",
                            edge_type="BLOCKED_BY",
                            source_table="mission_execution_events",
                            source_row_id="event_storm",
                            source_url="/missions/mission_tahoe/events/event_storm",
                            text="BLOCKED_BY",
                        ),
                        KgEvidenceItem(
                            kind="node",
                            node_id="storm",
                            label="event",
                            source_table="calendar_events",
                            source_row_id="storm_dec_13",
                            source_url="/calendar/storm_dec_13",
                            text="Tahoe storm forecast Dec 13-15",
                        ),
                    ],
                )
            ],
        )
    )

    assert res.model == "deterministic_kg_synthesizer"
    assert "Supporting evidence" in res.answer
    assert res.edge_filter_hint[:2] == ["BLOCKED_BY", "LED_TO"]
    assert [citation.node_id for citation in res.citations] == ["tahoe", "storm"]


def test_kg_synthesize_empty_evidence_is_stable() -> None:
    res = kg_synthesize(KgSynthesizeRequest(question="What happened?", traversal=[]))

    assert res.citations == []
    assert "could not find" in res.answer
