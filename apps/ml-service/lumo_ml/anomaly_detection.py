from __future__ import annotations

import math
import statistics
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Any

from .schemas import (
    AnomalyFinding,
    DetectAnomalyRequest,
    DetectAnomalyResponse,
    MetricPoint,
)

MAX_FINDINGS = 12
ZSCORE_THRESHOLD = 3.5
AnomalyModelName = str


@dataclass(frozen=True)
class _SeriesPoint:
    ts: datetime
    value: float
    dimensions: dict[str, Any]


def detect_anomaly(req: DetectAnomalyRequest) -> DetectAnomalyResponse:
    points = _prepare_points(req.points, req.context.lookback_days)
    if len(points) < req.context.min_points:
        return DetectAnomalyResponse(
            findings=[],
            model="not_configured",
            points_analyzed=len(points),
            _lumo_summary=(
                f"Need at least {req.context.min_points} points for anomaly detection; "
                f"received {len(points)}."
            ),
        )

    has_dimensions = any(point.dimensions for point in points)
    findings, trend_model = _prophet_findings(points, req.context.expected_frequency)
    model_detail = trend_model
    if has_dimensions:
        dimension_findings, dimension_model = _isolation_forest_findings(points)
        findings.extend(dimension_findings)
        model_detail = f"{trend_model}+{dimension_model}"
        model_name = (
            "hybrid"
            if trend_model == "prophet" and dimension_model == "isolation_forest"
            else "hybrid_fallback"
        )
    else:
        model_name = trend_model

    deduped = _dedupe_findings(findings)
    summary = (
        f"Detected {len(deduped)} anomal"
        f"{'y' if len(deduped) == 1 else 'ies'} in {len(points)} {req.metric_key} point"
        f"{'s' if len(points) != 1 else ''}."
    )
    return DetectAnomalyResponse(
        findings=deduped,
        model=model_name,
        model_detail=model_detail,
        points_analyzed=len(points),
        _lumo_summary=summary,
    )


def _prepare_points(points: list[MetricPoint], lookback_days: int | None) -> list[_SeriesPoint]:
    cleaned = [
        _SeriesPoint(ts=_normalize_ts(point.ts), value=float(point.value), dimensions=point.dimensions)
        for point in points
        if math.isfinite(float(point.value))
    ]
    cleaned.sort(key=lambda point: point.ts)
    if lookback_days and cleaned:
        cutoff = cleaned[-1].ts - timedelta(days=lookback_days)
        cleaned = [point for point in cleaned if point.ts >= cutoff]
    return cleaned


def _prophet_findings(
    points: list[_SeriesPoint],
    frequency: str,
) -> tuple[list[AnomalyFinding], AnomalyModelName]:
    external = _try_prophet_findings(points, frequency)
    if external is not None:
        return external, "prophet"
    return _seasonal_robust_findings(points, frequency), "seasonal_robust"


def _try_prophet_findings(points: list[_SeriesPoint], frequency: str) -> list[AnomalyFinding] | None:
    try:
        import pandas as pd
        from prophet import Prophet
    except Exception:
        return None

    try:
        df = pd.DataFrame({"ds": [point.ts for point in points], "y": [point.value for point in points]})
        model = Prophet(
            daily_seasonality=frequency == "hourly",
            weekly_seasonality=frequency in {"daily", "hourly"},
            yearly_seasonality=False,
        )
        model.fit(df)
        forecast = model.predict(df[["ds"]])
        residuals = [float(actual) - float(expected) for actual, expected in zip(df["y"], forecast["yhat"])]
        scale = _robust_scale(residuals) or _std(residuals) or 1.0
        findings: list[AnomalyFinding] = []
        for point, expected, residual in zip(points, forecast["yhat"], residuals):
            z_score = residual / scale
            if abs(z_score) >= ZSCORE_THRESHOLD:
                findings.append(
                    _finding(
                        point=point,
                        expected_value=float(expected),
                        z_score=z_score,
                        finding_type="spike" if z_score > 0 else "drop",
                    )
                )
        return findings
    except Exception:
        return None


def _seasonal_robust_findings(points: list[_SeriesPoint], frequency: str) -> list[AnomalyFinding]:
    findings: list[AnomalyFinding] = []
    values = [point.value for point in points]
    for index, point in enumerate(points):
        baseline_values = _seasonal_baseline_values(points, index, frequency)
        if len(baseline_values) < 3:
            baseline_values = values[:index] + values[index + 1 :]
        if len(baseline_values) < 3:
            continue
        expected = statistics.median(baseline_values)
        scale = _robust_scale([value - expected for value in baseline_values])
        if scale <= 0:
            scale = _std(baseline_values)
        if scale <= 0:
            continue
        z_score = (point.value - expected) / scale
        if abs(z_score) >= ZSCORE_THRESHOLD:
            findings.append(
                _finding(
                    point=point,
                    expected_value=expected,
                    z_score=z_score,
                    finding_type="spike" if z_score > 0 else "drop",
                )
            )

    findings.extend(_level_shift_findings(points))
    return findings


def _isolation_forest_findings(points: list[_SeriesPoint]) -> tuple[list[AnomalyFinding], AnomalyModelName]:
    external = _try_isolation_forest_findings(points)
    if external is not None:
        return external, "isolation_forest"
    return _dimension_pattern_findings(points), "dimension_pattern"


def _try_isolation_forest_findings(points: list[_SeriesPoint]) -> list[AnomalyFinding] | None:
    try:
        import numpy as np
        from sklearn.ensemble import IsolationForest
    except Exception:
        return None

    try:
        keys = sorted({key for point in points for key in point.dimensions.keys()})
        features = []
        for point in points:
            row = [point.value]
            for key in keys:
                row.append(_dimension_value(point.dimensions.get(key)))
            features.append(row)
        matrix = np.array(features, dtype=float)
        model = IsolationForest(contamination="auto", random_state=17)
        predictions = model.fit_predict(matrix)
        scores = model.score_samples(matrix)
        threshold = statistics.quantiles([float(score) for score in scores], n=10)[0]
        findings: list[AnomalyFinding] = []
        center = statistics.median(point.value for point in points)
        scale = _robust_scale([point.value - center for point in points]) or _std(
            [point.value for point in points]
        ) or 1.0
        for point, prediction, score in zip(points, predictions, scores):
            if prediction != -1 or float(score) > threshold:
                continue
            z_score = (point.value - center) / scale
            findings.append(
                _finding(
                    point=point,
                    expected_value=center,
                    z_score=z_score,
                    finding_type="pattern_change",
                    confidence=min(0.99, max(0.55, 1.0 - abs(float(score) - threshold))),
                )
            )
        return findings
    except Exception:
        return None


def _dimension_pattern_findings(points: list[_SeriesPoint]) -> list[AnomalyFinding]:
    if not any(point.dimensions for point in points):
        return []
    center = statistics.median(point.value for point in points)
    scale = _robust_scale([point.value - center for point in points]) or _std(
        [point.value for point in points]
    )
    if scale <= 0:
        return []
    findings = []
    for point in points:
        z_score = (point.value - center) / scale
        if abs(z_score) >= ZSCORE_THRESHOLD + 0.5:
            findings.append(
                _finding(
                    point=point,
                    expected_value=center,
                    z_score=z_score,
                    finding_type="pattern_change",
                )
            )
    return findings


def _level_shift_findings(points: list[_SeriesPoint]) -> list[AnomalyFinding]:
    if len(points) < 28:
        return []
    window = max(7, min(14, len(points) // 5))
    values = [point.value for point in points]
    global_scale = _robust_scale([value - statistics.median(values) for value in values]) or _std(values)
    if global_scale <= 0:
        return []
    findings: list[AnomalyFinding] = []
    for index in range(window, len(points) - window):
        before = values[index - window : index]
        after = values[index : index + window]
        before_median = statistics.median(before)
        after_median = statistics.median(after)
        z_score = (after_median - before_median) / global_scale
        if abs(z_score) >= ZSCORE_THRESHOLD:
            findings.append(
                _finding(
                    point=points[index],
                    expected_value=before_median,
                    z_score=z_score,
                    finding_type="level_shift",
                    actual_value=after_median,
                )
            )
    return findings


def _seasonal_baseline_values(
    points: list[_SeriesPoint],
    index: int,
    frequency: str,
) -> list[float]:
    point = points[index]
    if frequency == "daily" and len(points) >= 28:
        same_bucket = [
            other.value
            for other_index, other in enumerate(points)
            if other_index != index and other.ts.weekday() == point.ts.weekday()
        ]
        if len(same_bucket) >= 4:
            return same_bucket
    if frequency == "hourly" and len(points) >= 48:
        same_bucket = [
            other.value
            for other_index, other in enumerate(points)
            if other_index != index and other.ts.hour == point.ts.hour
        ]
        if len(same_bucket) >= 4:
            return same_bucket
    return []


def _finding(
    *,
    point: _SeriesPoint,
    expected_value: float,
    z_score: float,
    finding_type: str,
    confidence: float | None = None,
    actual_value: float | None = None,
) -> AnomalyFinding:
    magnitude = abs(z_score)
    if confidence is None:
        confidence = 1.0 - math.exp(-max(0.0, magnitude - 1.8) / 1.1)
    return AnomalyFinding(
        finding_type=finding_type,  # type: ignore[arg-type]
        anomaly_ts=point.ts,
        expected_value=round(expected_value, 4),
        actual_value=round(point.value if actual_value is None else actual_value, 4),
        z_score=round(z_score, 4),
        confidence=round(max(0.0, min(0.99, confidence)), 4),
    )


def _dedupe_findings(findings: list[AnomalyFinding]) -> list[AnomalyFinding]:
    findings.sort(key=lambda item: (item.confidence, abs(item.z_score)), reverse=True)
    selected: list[AnomalyFinding] = []
    seen: set[tuple[datetime, str]] = set()
    for finding in findings:
        key = (finding.anomaly_ts, finding.finding_type)
        if key in seen:
            continue
        seen.add(key)
        selected.append(finding)
        if len(selected) >= MAX_FINDINGS:
            break
    selected.sort(key=lambda item: item.anomaly_ts)
    return selected


def _normalize_ts(value: datetime) -> datetime:
    if value.tzinfo is None:
        return value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc)


def _robust_scale(values: list[float]) -> float:
    if not values:
        return 0.0
    median = statistics.median(values)
    deviations = [abs(value - median) for value in values]
    mad = statistics.median(deviations)
    return 1.4826 * mad


def _std(values: list[float]) -> float:
    if len(values) < 2:
        return 0.0
    return statistics.pstdev(values)


def _dimension_value(value: Any) -> float:
    if isinstance(value, bool):
        return 1.0 if value else 0.0
    try:
        number = float(value)
    except (TypeError, ValueError):
        encoded = str(value)
        return float(sum(ord(char) for char in encoded[:32]) % 997)
    return number if math.isfinite(number) else 0.0
