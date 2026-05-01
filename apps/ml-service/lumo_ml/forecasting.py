from __future__ import annotations

import math
import statistics
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone

from .schemas import ForecastMetricRequest, ForecastMetricResponse, ForecastPoint, MetricPoint

CONFIDENCE_INTERVAL = 0.8


@dataclass(frozen=True)
class _SeriesPoint:
    ts: datetime
    value: float


def forecast_metric(req: ForecastMetricRequest) -> ForecastMetricResponse:
    points = _prepare_points(req.points)
    if len(points) < 2:
        return _not_configured(req.metric_key, len(points), "Need at least two points to forecast.")

    prophet_forecast = _try_prophet_forecast(points, req.horizon_days, req.context.expected_frequency)
    if prophet_forecast is not None:
        return ForecastMetricResponse(
            forecast=prophet_forecast,
            model="prophet",
            confidence_interval=CONFIDENCE_INTERVAL,
            points_used=len(points),
            _lumo_summary=(
                f"Forecasted {len(prophet_forecast)} {req.metric_key} point"
                f"{'s' if len(prophet_forecast) != 1 else ''} with Prophet."
            ),
        )

    fallback = _naive_seasonal_forecast(points, req.horizon_days, req.context.expected_frequency)
    if not fallback:
        return _not_configured(
            req.metric_key,
            len(points),
            "Forecasting could not produce a stable fallback from the supplied points.",
        )

    return ForecastMetricResponse(
        forecast=fallback,
        model="naive_seasonal",
        confidence_interval=CONFIDENCE_INTERVAL,
        points_used=len(points),
        _lumo_summary=(
            f"Forecasted {len(fallback)} {req.metric_key} point"
            f"{'s' if len(fallback) != 1 else ''} with naive seasonal fallback."
        ),
    )


def _prepare_points(points: list[MetricPoint]) -> list[_SeriesPoint]:
    cleaned = [
        _SeriesPoint(ts=_normalize_ts(point.ts), value=float(point.value))
        for point in points
        if math.isfinite(float(point.value))
    ]
    cleaned.sort(key=lambda point: point.ts)
    return cleaned


def _try_prophet_forecast(
    points: list[_SeriesPoint],
    horizon_days: int,
    frequency: str,
) -> list[ForecastPoint] | None:
    if not _enough_points_for_prophet(points, frequency):
        return None
    try:
        import pandas as pd
        from prophet import Prophet
    except Exception:
        return None

    try:
        df = pd.DataFrame({"ds": [point.ts for point in points], "y": [point.value for point in points]})
        model = Prophet(
            interval_width=CONFIDENCE_INTERVAL,
            daily_seasonality=frequency == "hourly",
            weekly_seasonality=frequency in {"daily", "hourly"},
            yearly_seasonality=False,
        )
        model.fit(df)
        periods = _period_count(horizon_days, frequency)
        future = model.make_future_dataframe(periods=periods, freq=_pandas_frequency(frequency))
        forecast = model.predict(future).tail(periods)
        return [
            ForecastPoint(
                ts=_normalize_ts(row.ds.to_pydatetime()),
                predicted_value=round(float(row.yhat), 4),
                lower_bound=round(float(row.yhat_lower), 4),
                upper_bound=round(float(row.yhat_upper), 4),
            )
            for row in forecast.itertuples(index=False)
        ]
    except Exception:
        return None


def _naive_seasonal_forecast(
    points: list[_SeriesPoint],
    horizon_days: int,
    frequency: str,
) -> list[ForecastPoint]:
    periods = _period_count(horizon_days, frequency)
    if periods <= 0:
        return []
    step = _step_delta(frequency)
    seasonal_period = _seasonal_period(frequency)
    values = [point.value for point in points]
    residual_scale = _residual_scale(values, seasonal_period)
    fallback_scale = statistics.pstdev(values) if len(values) > 1 else 0.0
    interval_scale = max(residual_scale, fallback_scale * 0.35, 1e-6)
    last_ts = points[-1].ts

    forecast: list[ForecastPoint] = []
    for offset in range(1, periods + 1):
        predicted = _seasonal_value(values, seasonal_period, offset)
        width = max(interval_scale * 1.28155, abs(predicted) * 0.02, 0.01)
        forecast.append(
            ForecastPoint(
                ts=last_ts + step * offset,
                predicted_value=round(predicted, 4),
                lower_bound=round(predicted - width, 4),
                upper_bound=round(predicted + width, 4),
            )
        )
    return forecast


def _seasonal_value(values: list[float], seasonal_period: int, offset: int) -> float:
    if len(values) >= seasonal_period:
        index = len(values) - seasonal_period + ((offset - 1) % seasonal_period)
        return values[index]
    return statistics.median(values)


def _residual_scale(values: list[float], seasonal_period: int) -> float:
    if len(values) <= seasonal_period:
        return 0.0
    residuals = [
        values[index] - values[index - seasonal_period]
        for index in range(seasonal_period, len(values))
    ]
    if not residuals:
        return 0.0
    median = statistics.median(residuals)
    mad = statistics.median(abs(value - median) for value in residuals)
    robust = 1.4826 * mad
    return robust if robust > 0 else statistics.pstdev(residuals)


def _period_count(horizon_days: int, frequency: str) -> int:
    if frequency == "hourly":
        return min(horizon_days * 24, 24 * 31)
    if frequency == "weekly":
        return max(1, math.ceil(horizon_days / 7))
    return horizon_days


def _seasonal_period(frequency: str) -> int:
    if frequency == "hourly":
        return 24
    if frequency == "weekly":
        return 52
    return 7


def _step_delta(frequency: str) -> timedelta:
    if frequency == "hourly":
        return timedelta(hours=1)
    if frequency == "weekly":
        return timedelta(days=7)
    return timedelta(days=1)


def _pandas_frequency(frequency: str) -> str:
    if frequency == "hourly":
        return "h"
    if frequency == "weekly":
        return "W"
    return "D"


def _enough_points_for_prophet(points: list[_SeriesPoint], frequency: str) -> bool:
    if frequency == "weekly":
        return len(points) >= 14
    return len(points) >= 14


def _normalize_ts(value: datetime) -> datetime:
    if value.tzinfo is None:
        return value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc)


def _not_configured(metric_key: str, points_used: int, summary: str) -> ForecastMetricResponse:
    return ForecastMetricResponse(
        forecast=[],
        model="not_configured",
        confidence_interval=CONFIDENCE_INTERVAL,
        points_used=points_used,
        _lumo_summary=f"{metric_key} forecast unavailable: {summary}",
    )
