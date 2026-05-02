from __future__ import annotations

import time
from typing import Annotated

from fastapi import Depends, FastAPI, Request

from . import tools
from .auth import AuthContext, require_lumo_jwt
from .config import get_settings
from .plan.router import router as plan_router
from .sandbox import sandbox_upstream_health
from .schemas import (
    AnalyzeFileRequest,
    AnalyzeFileResponse,
    ClassifyRequest,
    ClassifyResponse,
    DetectAnomalyRequest,
    DetectAnomalyResponse,
    EmbedImageRequest,
    EmbedImageResponse,
    EmbedRequest,
    EmbedResponse,
    ExtractPdfRequest,
    ExtractPdfResponse,
    ForecastMetricRequest,
    ForecastMetricResponse,
    GenerateChartRequest,
    GenerateChartResponse,
    KgSynthesizeRequest,
    KgSynthesizeResponse,
    OptimizeTripRequest,
    OptimizeTripResponse,
    PlanTaskRequest,
    PlanTaskResponse,
    PythonSandboxRequest,
    PythonSandboxResponse,
    RankAgentsRequest,
    RankAgentsResponse,
    RecallRequest,
    RecallResponse,
    RiskRequest,
    RiskResponse,
    TranscribeRequest,
    TranscribeResponse,
)

settings = get_settings()

app = FastAPI(
    title="Lumo Intelligence Layer",
    version=settings.version,
    description="First-party Lumo system agent for planning, recall, marketplace ranking, risk scoring, and scoped Python computation.",
)


@app.get("/.well-known/agent.json", include_in_schema=False)
def agent_manifest(request: Request) -> dict:
    base_url = _base_url(request)
    return {
        "agent_id": settings.agent_id,
        "version": settings.version,
        "domain": "intelligence",
        "display_name": settings.display_name,
        "one_liner": "Planning, recall, marketplace ranking, risk scoring, and safe computation for Lumo.",
        "intents": [
            "plan",
            "plan_task",
            "rank_agents",
            "evaluate_agent_risk",
            "optimize_trip",
            "transcribe",
            "extract_pdf",
            "embed_image",
            "detect_anomaly",
            "forecast_metric",
            "kg_synthesize",
            "recall",
            "classify",
            "embed",
            "analyze_file",
            "generate_chart",
            "run_python_sandbox",
        ],
        "example_utterances": [
            "Plan my Vegas trip and tell me which agents I need.",
            "Find where Alex mentioned the partnership idea.",
            "Is this marketplace agent asking for too many permissions?",
            "Run a safe calculation over this receipt.",
            "Optimize the order of stops for my Vegas trip.",
            "Transcribe this meeting audio and make it searchable.",
            "Extract layout-aware text from this PDF.",
            "Embed this image and make the visual labels searchable.",
            "Tell me whether revenue dropped abnormally this week.",
            "Forecast booking prices for the next two weeks.",
            "Synthesize cited knowledge graph evidence for why a decision happened.",
        ],
        "openapi_url": f"{base_url}/openapi.json",
        "health_url": f"{base_url}/api/health",
        "ui": {"components": []},
        "sla": {
            "p50_latency_ms": 150,
            "p95_latency_ms": 500,
            "availability_target": 0.995,
        },
        "pii_scope": ["name", "email", "address", "traveler_profile"],
        "requires_payment": False,
        "supported_regions": ["US"],
        "capabilities": {
            "sdk_version": "0.4.0",
            "supports_compound_bookings": False,
            "implements_cancellation": False,
        },
        "connect": {"model": "none"},
        "listing": {
            "category": "System",
            "pricing_note": "Included with Lumo",
            "privacy_policy_url": "https://lumo.rentals/privacy",
            "terms_url": "https://lumo.rentals/terms",
            "about_paragraphs": [
                "Lumo's first-party Intelligence Layer plans multi-agent missions, ranks marketplace agents, evaluates permission risk, and provides recall over approved user data.",
            ],
        },
        "owner_team": "Lumo",
    }


@app.get("/api/health")
def health() -> dict:
    auth_configured = bool(get_settings().service_jwt_secret)
    return {
        "status": "ok" if auth_configured else "degraded",
        "agent_id": settings.agent_id,
        "version": settings.version,
        "checked_at": int(time.time() * 1000),
        "p95_latency_ms": 0,
        "error_rate": 0,
        "upstream": {
            "service_jwt": {
                "status": "ok" if auth_configured else "degraded",
                **({} if auth_configured else {"last_error": "LUMO_ML_SERVICE_JWT_SECRET is not set"}),
            },
            "sandbox": sandbox_upstream_health(),
            "deepgram_transcription": {
                "status": "ok"
                if _deepgram_configured()
                else "degraded",
                **(
                    {}
                    if _deepgram_configured()
                    else {"last_error": "LUMO_DEEPGRAM_API_KEY is not set"}
                ),
            },
            "pdf_extraction": {
                "status": "ok" if _pdf_extraction_available() else "degraded",
                **(
                    {}
                    if _pdf_extraction_available()
                    else {"last_error": "unstructured PDF partitioner is not installed"}
                ),
            },
            "modal_clip": {
                "status": "ok"
                if _modal_credentials_configured()
                else "degraded",
                **(
                    {}
                    if _modal_credentials_configured()
                    else {"last_error": "MODAL_TOKEN_ID and MODAL_TOKEN_SECRET are not set"}
                ),
            },
            "analytics_models": {
                "status": "ok" if _analytics_models_available() else "degraded",
                **(
                    {}
                    if _analytics_models_available()
                    else {"last_error": "Prophet and scikit-learn are not installed; using statistical fallback"}
                ),
            },
        },
    }


def _tool_extra(cost_tier: str, tags: list[str]) -> dict:
    return {
        "x-lumo-tool": True,
        "x-lumo-cost-tier": cost_tier,
        "x-lumo-requires-confirmation": False,
        "x-lumo-intent-tags": tags,
    }


Auth = Annotated[AuthContext, Depends(require_lumo_jwt)]


@app.post(
    "/api/tools/plan_task",
    operation_id="lumo_plan_task",
    response_model=PlanTaskResponse,
    openapi_extra=_tool_extra("free", ["planning", "mission", "agents"]),
)
def route_plan_task(req: PlanTaskRequest, _auth: Auth) -> PlanTaskResponse:
    return tools.plan_task(req)


@app.post(
    "/api/tools/rank_agents",
    operation_id="lumo_rank_agents",
    response_model=RankAgentsResponse,
    openapi_extra=_tool_extra("free", ["marketplace", "agents", "routing"]),
)
def route_rank_agents(req: RankAgentsRequest, _auth: Auth) -> RankAgentsResponse:
    return tools.rank_agents(req)


@app.post(
    "/api/tools/evaluate_agent_risk",
    operation_id="lumo_evaluate_agent_risk",
    response_model=RiskResponse,
    openapi_extra=_tool_extra("free", ["marketplace", "security", "permissions"]),
)
def route_evaluate_agent_risk(req: RiskRequest, _auth: Auth) -> RiskResponse:
    return tools.evaluate_agent_risk(req)


@app.post(
    "/api/tools/optimize_trip",
    operation_id="lumo_optimize_trip",
    response_model=OptimizeTripResponse,
    openapi_extra=_tool_extra("free", ["planning", "optimization", "travel"]),
)
def route_optimize_trip(req: OptimizeTripRequest, _auth: Auth) -> OptimizeTripResponse:
    return tools.optimize_trip(req)


@app.post(
    "/api/tools/transcribe",
    operation_id="lumo_transcribe",
    response_model=TranscribeResponse,
    openapi_extra=_tool_extra("metered", ["audio", "transcription", "recall"]),
)
def route_transcribe(req: TranscribeRequest, _auth: Auth) -> TranscribeResponse:
    return tools.transcribe(req)


@app.post(
    "/api/tools/extract_pdf",
    operation_id="lumo_extract_pdf",
    response_model=ExtractPdfResponse,
    openapi_extra=_tool_extra("metered", ["pdf", "documents", "layout", "recall"]),
)
def route_extract_pdf(req: ExtractPdfRequest, _auth: Auth) -> ExtractPdfResponse:
    return tools.extract_pdf(req)


@app.post(
    "/api/tools/embed_image",
    operation_id="lumo_embed_image",
    response_model=EmbedImageResponse,
    openapi_extra=_tool_extra("metered", ["image", "clip", "embeddings", "recall"]),
)
def route_embed_image(req: EmbedImageRequest, _auth: Auth) -> EmbedImageResponse:
    return tools.embed_image_tool(req)


@app.post(
    "/api/tools/detect_anomaly",
    operation_id="lumo_detect_anomaly",
    response_model=DetectAnomalyResponse,
    openapi_extra=_tool_extra("metered", ["analytics", "anomaly-detection", "proactive"]),
)
def route_detect_anomaly(req: DetectAnomalyRequest, _auth: Auth) -> DetectAnomalyResponse:
    return tools.detect_anomaly(req)


@app.post(
    "/api/tools/forecast_metric",
    operation_id="lumo_forecast_metric",
    response_model=ForecastMetricResponse,
    openapi_extra=_tool_extra("metered", ["analytics", "forecasting", "proactive"]),
)
def route_forecast_metric(req: ForecastMetricRequest, _auth: Auth) -> ForecastMetricResponse:
    return tools.forecast_metric(req)


@app.post(
    "/api/tools/embed",
    operation_id="lumo_embed",
    response_model=EmbedResponse,
    openapi_extra=_tool_extra("metered", ["embeddings", "recall"]),
)
def route_embed(req: EmbedRequest, _auth: Auth) -> EmbedResponse:
    return tools.embed(req)


@app.post(
    "/api/tools/classify",
    operation_id="lumo_classify",
    response_model=ClassifyResponse,
    openapi_extra=_tool_extra("free", ["classification", "lead-scoring"]),
)
def route_classify(req: ClassifyRequest, _auth: Auth) -> ClassifyResponse:
    return tools.classify(req)


@app.post(
    "/api/tools/recall",
    operation_id="lumo_recall",
    response_model=RecallResponse,
    openapi_extra=_tool_extra("free", ["recall", "memory", "search"]),
)
def route_recall(req: RecallRequest, _auth: Auth) -> RecallResponse:
    return tools.recall(req)


@app.post(
    "/api/kg/synthesize",
    operation_id="lumo_kg_synthesize",
    response_model=KgSynthesizeResponse,
    openapi_extra=_tool_extra("metered", ["knowledge-graph", "synthesis", "citations"]),
)
def route_kg_synthesize(req: KgSynthesizeRequest, _auth: Auth) -> KgSynthesizeResponse:
    return tools.kg_synthesize(req)


@app.post(
    "/api/tools/analyze_file",
    operation_id="lumo_analyze_file",
    response_model=AnalyzeFileResponse,
    openapi_extra=_tool_extra("metered", ["files", "analysis"]),
)
def route_analyze_file(req: AnalyzeFileRequest, _auth: Auth) -> AnalyzeFileResponse:
    return tools.analyze_file(req)


@app.post(
    "/api/tools/generate_chart",
    operation_id="lumo_generate_chart",
    response_model=GenerateChartResponse,
    openapi_extra=_tool_extra("free", ["charts", "analysis"]),
)
def route_generate_chart(req: GenerateChartRequest, _auth: Auth) -> GenerateChartResponse:
    return tools.generate_chart(req)


@app.post(
    "/api/tools/run_python_sandbox",
    operation_id="lumo_run_python_sandbox",
    response_model=PythonSandboxResponse,
    openapi_extra=_tool_extra("metered", ["python", "sandbox", "computation"]),
)
def route_run_python_sandbox(req: PythonSandboxRequest, _auth: Auth) -> PythonSandboxResponse:
    return tools.run_python_sandbox(req, _auth)


# Pre-LLM planning surface — stubbed in Phase 0; real classifier ships
# in Phase 1 (INTENT-CLASSIFIER-MIGRATE-PYTHON-1).
app.include_router(plan_router)


def _base_url(request: Request) -> str:
    configured = get_settings().public_base_url
    if configured:
        return configured.rstrip("/")
    return str(request.base_url).rstrip("/")


def _modal_credentials_configured() -> bool:
    import os

    return bool(os.getenv("MODAL_TOKEN_ID") and os.getenv("MODAL_TOKEN_SECRET"))


def _deepgram_configured() -> bool:
    import os

    return bool(os.getenv("LUMO_DEEPGRAM_API_KEY"))


def _pdf_extraction_available() -> bool:
    import importlib.util

    try:
        return importlib.util.find_spec("unstructured.partition.pdf") is not None
    except ModuleNotFoundError:
        return False


def _analytics_models_available() -> bool:
    import importlib.util

    return bool(importlib.util.find_spec("prophet") or importlib.util.find_spec("sklearn"))
