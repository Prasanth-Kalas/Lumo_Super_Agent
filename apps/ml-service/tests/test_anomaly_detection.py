from __future__ import annotations

from datetime import datetime, timedelta, timezone

from lumo_ml.anomaly_detection import detect_anomaly
from lumo_ml.schemas import AnomalyContext, DetectAnomalyRequest, MetricPoint


def test_detect_anomaly_finds_known_revenue_spike() -> None:
    start = datetime(2026, 1, 1, tzinfo=timezone.utc)
    points = []
    for day in range(60):
        baseline = 1000 + (day % 7) * 20
        value = baseline + ((day % 5) - 2) * 8
        if day == 35:
            value = baseline + 260
        points.append(MetricPoint(ts=start + timedelta(days=day), value=value))

    res = detect_anomaly(
        DetectAnomalyRequest(
            metric_key="stripe.revenue",
            points=points,
            context=AnomalyContext(expected_frequency="daily", min_points=14),
        )
    )

    spikes = [finding for finding in res.findings if finding.finding_type == "spike"]
    assert res.model in {"prophet", "seasonal_robust"}
    assert res.model_detail in {"prophet", "seasonal_robust"}
    assert res.points_analyzed == 60
    assert spikes
    assert spikes[0].anomaly_ts == start + timedelta(days=35)
    assert spikes[0].confidence > 0.9
    assert spikes[0].actual_value > spikes[0].expected_value


def test_detect_anomaly_ignores_noisy_series_without_real_outliers() -> None:
    start = datetime(2026, 1, 1, tzinfo=timezone.utc)
    points = [
        MetricPoint(
            ts=start + timedelta(days=day),
            value=500 + (day % 7) * 4 + ((day * 13) % 9) - 4,
        )
        for day in range(90)
    ]

    res = detect_anomaly(
        DetectAnomalyRequest(
            metric_key="workspace.signups",
            points=points,
            context=AnomalyContext(expected_frequency="daily", min_points=14),
        )
    )

    assert res.points_analyzed == 90
    assert res.findings == []


def test_detect_anomaly_uses_dimension_aware_model_label() -> None:
    start = datetime(2026, 1, 1, tzinfo=timezone.utc)
    points = [
        MetricPoint(
            ts=start + timedelta(days=day),
            value=100 + (day % 3),
            dimensions={"plan": "pro" if day % 2 else "free"},
        )
        for day in range(30)
    ]

    res = detect_anomaly(
        DetectAnomalyRequest(
            metric_key="checkout.conversion",
            points=points,
            context=AnomalyContext(expected_frequency="daily", min_points=14),
        )
    )

    assert res.model in {"hybrid", "hybrid_fallback"}
    assert res.model_detail is not None
    assert "+" in res.model_detail
    assert res.points_analyzed == 30
