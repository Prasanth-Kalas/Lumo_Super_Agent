from __future__ import annotations

from datetime import datetime, timedelta, timezone

from lumo_ml.forecasting import forecast_metric
from lumo_ml.schemas import ForecastContext, ForecastMetricRequest, MetricPoint


def test_forecast_metric_tracks_weekly_pattern_with_naive_fallback() -> None:
    start = datetime(2026, 1, 1, tzinfo=timezone.utc)
    weekly_pattern = [100, 120, 140, 160, 180, 220, 200]
    points = [
        MetricPoint(
            ts=start + timedelta(days=day),
            value=weekly_pattern[day % 7] * (1 + 0.002 * (day // 7)),
        )
        for day in range(90)
    ]

    res = forecast_metric(
        ForecastMetricRequest(
            metric_key="hotel.price",
            points=points,
            horizon_days=14,
            context=ForecastContext(expected_frequency="daily"),
        )
    )

    assert res.model in {"prophet", "naive_seasonal"}
    assert len(res.forecast) == 14
    expected = [points[-7 + (index % 7)].value for index in range(14)]
    mape = sum(
        abs(point.predicted_value - expected_value) / expected_value
        for point, expected_value in zip(res.forecast, expected)
    ) / len(expected)
    assert mape < 0.15


def test_forecast_metric_confidence_intervals_do_not_collapse_on_flat_noise() -> None:
    start = datetime(2026, 1, 1, tzinfo=timezone.utc)
    points = [
        MetricPoint(
            ts=start + timedelta(days=day),
            value=1000 + ((day * 11) % 13) - 6,
        )
        for day in range(45)
    ]

    res = forecast_metric(
        ForecastMetricRequest(
            metric_key="stripe.revenue",
            points=points,
            horizon_days=7,
            context=ForecastContext(expected_frequency="daily"),
        )
    )

    assert len(res.forecast) == 7
    for point in res.forecast:
        assert point.lower_bound < point.predicted_value < point.upper_bound
        assert point.upper_bound - point.lower_bound > 0.01


def test_forecast_metric_returns_not_configured_when_too_sparse() -> None:
    start = datetime(2026, 1, 1, tzinfo=timezone.utc)
    res = forecast_metric(
        ForecastMetricRequest(
            metric_key="ev.price",
            points=[MetricPoint(ts=start, value=42)],
            horizon_days=3,
        )
    )

    assert res.model == "not_configured"
    assert res.forecast == []
