from __future__ import annotations

from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field


class LumoToolResponse(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    lumo_summary: str = Field(alias="_lumo_summary")


class AgentDescriptor(BaseModel):
    agent_id: str
    display_name: str | None = None
    domain: str | None = None
    category: str | None = None
    intents: list[str] = Field(default_factory=list)
    scopes: list[str] = Field(default_factory=list)
    installed: bool = False
    connect_model: str | None = None
    requires_payment: bool = False
    pii_scope: list[str] = Field(default_factory=list)


class RankedAgent(BaseModel):
    agent_id: str
    display_name: str
    score: float = Field(ge=0, le=1)
    installed: bool
    reasons: list[str] = Field(default_factory=list)
    missing_scopes: list[str] = Field(default_factory=list)


class RankAgentsRequest(BaseModel):
    user_intent: str = Field(min_length=1, max_length=4000)
    agents: list[AgentDescriptor] = Field(default_factory=list)
    installed_agent_ids: list[str] = Field(default_factory=list)
    limit: int = Field(default=8, ge=1, le=25)


class RankAgentsResponse(LumoToolResponse):
    ranked_agents: list[RankedAgent]
    missing_capabilities: list[str]


class RiskRequest(BaseModel):
    agent: AgentDescriptor
    requested_scopes: list[str] = Field(default_factory=list)
    category_peer_scopes: list[list[str]] = Field(default_factory=list)


class RiskResponse(LumoToolResponse):
    risk_level: Literal["low", "medium", "high"]
    score: float = Field(ge=0, le=1)
    flags: list[str] = Field(default_factory=list)
    mitigations: list[str] = Field(default_factory=list)


class PlanTaskRequest(BaseModel):
    user_intent: str = Field(min_length=1, max_length=4000)
    installed_agents: list[AgentDescriptor] = Field(default_factory=list)
    marketplace_agents: list[AgentDescriptor] = Field(default_factory=list)
    user_context_summary: str | None = Field(default=None, max_length=4000)


class PlanTaskResponse(LumoToolResponse):
    mission_id: str
    intent_summary: str
    required_agents: list[RankedAgent]
    missing_agents: list[RankedAgent]
    user_questions: list[str]
    confirmation_points: list[str]
    rollback_plan: list[str]


class TripStop(BaseModel):
    id: str = Field(min_length=1, max_length=80)
    label: str = Field(min_length=1, max_length=160)
    category: str = Field(min_length=1, max_length=80)
    duration_minutes: int = Field(default=30, ge=0, le=1440)
    earliest_start_minute: int = Field(default=0, ge=0, le=10080)
    latest_end_minute: int = Field(default=10080, ge=0, le=10080)
    priority: int = Field(default=1, ge=0, le=10)


class TripLegEstimate(BaseModel):
    from_id: str = Field(min_length=1, max_length=80)
    to_id: str = Field(min_length=1, max_length=80)
    duration_minutes: int = Field(ge=0, le=10080)
    cost_usd: float = Field(default=0, ge=0, le=1_000_000)
    distance_km: float = Field(default=0, ge=0, le=1_000_000)


class OptimizeTripRequest(BaseModel):
    objective: Literal["balanced", "fastest", "cheapest", "comfort"] = "balanced"
    stops: list[TripStop] = Field(min_length=2, max_length=24)
    legs: list[TripLegEstimate] = Field(default_factory=list, max_length=576)
    start_stop_id: str = Field(min_length=1, max_length=80)
    end_stop_id: str | None = Field(default=None, max_length=80)
    max_solver_seconds: int = Field(default=2, ge=1, le=10)


class OptimizedTripStop(BaseModel):
    id: str
    label: str
    category: str
    sequence: int
    arrival_minute: int
    departure_minute: int
    wait_minutes: int = 0


class OptimizeTripResponse(LumoToolResponse):
    status: Literal["ok", "fallback", "infeasible"]
    objective: Literal["balanced", "fastest", "cheapest", "comfort"]
    route: list[OptimizedTripStop]
    dropped_stop_ids: list[str] = Field(default_factory=list)
    total_duration_minutes: int
    total_cost_usd: float
    total_distance_km: float
    solver: str


class TranscribeRequest(BaseModel):
    audio_url: str = Field(min_length=1, max_length=4000)
    language: str | None = Field(default=None, max_length=16)
    speaker_diarization: bool = False


class TranscriptSegment(BaseModel):
    start: float = Field(ge=0)
    end: float = Field(ge=0)
    text: str
    speaker: str | None = None


class TranscribeResponse(LumoToolResponse):
    status: Literal["ok", "not_configured", "error"]
    transcript: str
    segments: list[TranscriptSegment]
    language: str | None = None
    duration_s: float = Field(ge=0)
    model: str
    diarization: Literal["not_requested", "ok", "not_configured", "error"] = "not_requested"


class ExtractPdfRequest(BaseModel):
    pdf_url: str = Field(min_length=1, max_length=4000)
    source_metadata: dict[str, Any] = Field(default_factory=dict)


class PdfBlock(BaseModel):
    type: Literal["heading", "paragraph", "table", "list"]
    text: str
    bbox: list[float] | None = None


class PdfPage(BaseModel):
    page_number: int = Field(ge=1)
    blocks: list[PdfBlock] = Field(default_factory=list)


class ExtractPdfResponse(LumoToolResponse):
    status: Literal["ok", "not_configured", "error"]
    pages: list[PdfPage]
    total_pages: int = Field(ge=0)
    language: str | None = None


class ImageLabel(BaseModel):
    label: str
    score: float = Field(ge=0, le=1)


class EmbedImageRequest(BaseModel):
    image_url: str = Field(min_length=1, max_length=4000)
    candidate_labels: list[str] = Field(default_factory=list, max_length=64)
    source_metadata: dict[str, Any] = Field(default_factory=dict)


class EmbedImageResponse(LumoToolResponse):
    status: Literal["ok", "not_configured", "error"]
    model: str
    dimensions: int = Field(ge=1)
    embedding: list[float]
    labels: list[ImageLabel]
    summary_text: str
    content_hash: str


class MetricPoint(BaseModel):
    ts: datetime
    value: float = Field(allow_inf_nan=False)
    dimensions: dict[str, Any] = Field(default_factory=dict)


class AnomalyContext(BaseModel):
    lookback_days: int | None = Field(default=None, ge=1, le=3650)
    expected_frequency: Literal["daily", "hourly", "weekly"] = "daily"
    min_points: int = Field(default=14, ge=3, le=1000)


class AnomalyFinding(BaseModel):
    finding_type: Literal["spike", "drop", "level_shift", "pattern_change"]
    anomaly_ts: datetime
    expected_value: float
    actual_value: float
    z_score: float
    confidence: float = Field(ge=0, le=1)


class DetectAnomalyRequest(BaseModel):
    metric_key: str = Field(min_length=1, max_length=200)
    points: list[MetricPoint] = Field(min_length=1, max_length=5000)
    context: AnomalyContext = Field(default_factory=AnomalyContext)


class DetectAnomalyResponse(LumoToolResponse):
    findings: list[AnomalyFinding]
    model: Literal[
        "prophet",
        "isolation_forest",
        "hybrid",
        "seasonal_robust",
        "dimension_pattern",
        "hybrid_fallback",
        "not_configured",
    ]
    model_detail: str | None = None
    points_analyzed: int


class ForecastContext(BaseModel):
    expected_frequency: Literal["daily", "hourly", "weekly"] = "daily"


class ForecastPoint(BaseModel):
    ts: datetime
    predicted_value: float
    lower_bound: float
    upper_bound: float


class ForecastMetricRequest(BaseModel):
    metric_key: str = Field(min_length=1, max_length=200)
    points: list[MetricPoint] = Field(min_length=1, max_length=5000)
    horizon_days: int = Field(ge=1, le=365)
    context: ForecastContext = Field(default_factory=ForecastContext)


class ForecastMetricResponse(LumoToolResponse):
    forecast: list[ForecastPoint]
    model: Literal["prophet", "naive_seasonal", "not_configured"]
    confidence_interval: float = Field(default=0.8, ge=0, le=1)
    points_used: int


class EmbedRequest(BaseModel):
    texts: list[str] = Field(min_length=1, max_length=128)
    source_metadata: dict[str, Any] = Field(default_factory=dict)


class EmbedResponse(LumoToolResponse):
    model: str
    dimensions: int
    embeddings: list[list[float]]
    content_hashes: list[str]


class ClassifyRequest(BaseModel):
    classifier: str = Field(default="lead")
    items: list[str] = Field(min_length=1, max_length=100)
    threshold: float = Field(default=0.7, ge=0, le=1)


class ClassifiedItem(BaseModel):
    label: str
    score: float = Field(ge=0, le=1)
    reasons: list[str] = Field(default_factory=list)
    above_threshold: bool


class ClassifyResponse(LumoToolResponse):
    classifier: str
    items: list[ClassifiedItem]


class RecallDocument(BaseModel):
    id: str
    text: str
    source: str | None = None
    metadata: dict[str, Any] = Field(default_factory=dict)


class RecallRequest(BaseModel):
    query: str = Field(min_length=1, max_length=2000)
    documents: list[RecallDocument] = Field(default_factory=list)
    top_k: int = Field(default=5, ge=1, le=20)


class RecallHit(BaseModel):
    id: str
    score: float = Field(ge=0, le=1)
    snippet: str
    source: str | None = None
    metadata: dict[str, Any] = Field(default_factory=dict)


class RecallResponse(LumoToolResponse):
    hits: list[RecallHit]
    status: Literal["ok", "empty_index", "partial"]


class KgEvidenceItem(BaseModel):
    kind: Literal["node", "edge"]
    node_id: str | None = None
    edge_id: str | None = None
    label: str | None = None
    edge_type: str | None = None
    source_table: str
    source_row_id: str
    source_url: str | None = None
    asserted_at: str | None = None
    text: str | None = None


class KgTraversalItem(BaseModel):
    node_id: str
    label: str
    properties: dict[str, Any] = Field(default_factory=dict)
    depth: int = Field(ge=0, le=3)
    score: float = Field(ge=0, le=1)
    path: list[str] = Field(default_factory=list, max_length=8)
    edge_types: list[str] = Field(default_factory=list, max_length=8)
    evidence: list[KgEvidenceItem] = Field(default_factory=list, max_length=64)


class KgSynthesizeRequest(BaseModel):
    question: str = Field(min_length=1, max_length=2000)
    traversal: list[KgTraversalItem] = Field(default_factory=list, max_length=30)


class KgSynthesizeCitation(BaseModel):
    node_id: str
    label: str
    source_table: str
    source_row_id: str
    source_url: str | None = None
    asserted_at: str | None = None
    text: str


class KgSynthesizeResponse(LumoToolResponse):
    answer: str
    citations: list[KgSynthesizeCitation]
    edge_filter_hint: list[str] = Field(default_factory=list)
    model: Literal["deterministic_kg_synthesizer", "llm_synthesizer"] = "deterministic_kg_synthesizer"


class AnalyzeFileRequest(BaseModel):
    file_ref: str
    task: str = Field(min_length=1, max_length=1000)
    output_schema: dict[str, Any] | None = None


class AnalyzeFileResponse(LumoToolResponse):
    status: Literal["not_configured", "ok"]
    extracted: dict[str, Any] = Field(default_factory=dict)


class GenerateChartRequest(BaseModel):
    chart_intent: str = Field(min_length=1, max_length=1000)
    data: list[dict[str, Any]] = Field(default_factory=list)


class GenerateChartResponse(LumoToolResponse):
    chart_spec: dict[str, Any]


class PythonSandboxRequest(BaseModel):
    code: str = Field(min_length=1, max_length=20000)
    timeout_seconds: int = Field(default=30, ge=1, le=30)
    network_policy: Literal["disabled", "allowlist"] = "disabled"


class PythonSandboxResponse(LumoToolResponse):
    status: Literal["not_configured", "ok", "error", "timeout", "denied"]
    stdout: str = ""
    stderr: str = ""
    duration_ms: int = Field(default=0, ge=0)
    artifacts: list[dict[str, Any]] = Field(default_factory=list)
