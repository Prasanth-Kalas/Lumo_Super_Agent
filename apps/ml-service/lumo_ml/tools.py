from __future__ import annotations

import hashlib
import math
import re
import uuid
from collections import Counter

from .anomaly_detection import detect_anomaly as detect_anomaly_tool
from .auth import AuthContext
from .forecasting import forecast_metric as forecast_metric_tool
from .image_embedding import embed_image
from .pdf_extraction import extract_pdf_document
from .redaction import redact_for_embedding
from .sandbox import run_python_sandbox as run_python_sandbox_tool
from .schemas import (
    AgentDescriptor,
    AnalyzeFileRequest,
    AnalyzeFileResponse,
    ClassifiedItem,
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
    KgEvidenceItem,
    KgSynthesizeCitation,
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
    RankedAgent,
    RecallHit,
    RecallRequest,
    RecallResponse,
    RiskRequest,
    RiskResponse,
    TranscribeRequest,
    TranscribeResponse,
)
from .transcription import transcribe_audio
from .trip_optimizer import optimize_trip as _optimize_trip_impl

CAPABILITY_KEYWORDS: dict[str, set[str]] = {
    "flight": {"flight", "flights", "airline", "airport", "return", "round trip", "las", "sfo"},
    "hotel": {"hotel", "stay", "room", "check in", "check-in", "vegas"},
    "maps": {"cab", "cabs", "taxi", "route", "drive", "directions", "car", "transport"},
    "food": {"food", "order", "restaurant", "dinner", "lunch", "breakfast", "doordash"},
    "events": {"event", "events", "show", "concert", "conference", "tonight"},
    "attractions": {"attraction", "attractions", "things to do", "museum", "tour"},
    "ev": {"ev", "charging", "charger", "electric"},
}

SENSITIVE_SCOPE_TERMS = {
    "payment": 0.28,
    "payment_method": 0.28,
    "card": 0.24,
    "write": 0.16,
    "send": 0.18,
    "book": 0.18,
    "message": 0.18,
    "email": 0.12,
    "location": 0.1,
    "address": 0.12,
    "passport": 0.28,
}

LEAD_KEYWORDS: list[tuple[re.Pattern[str], str, float]] = [
    (re.compile(r"\b(partner(ship)?s?|collab(oration)?|joint (project|video|campaign))\b", re.I), "partnership", 0.4),
    (re.compile(r"\b(sponsor(ed|ship)?|advertis(e|ing|ement)|paid (campaign|integration|placement|guest))\b", re.I), "sponsorship", 0.44),
    (re.compile(r"\b(brand deal|paid promo|paid post|ambassador|affiliate|media kit)\b", re.I), "brand-deal", 0.42),
    (re.compile(r"\b(podcast|interview|guest on|on your show|on my show)\b", re.I), "podcast/interview", 0.34),
    (re.compile(r"\b(speak(er|ing)?|keynote|panel|webinar|summit|conference|founder event)\b", re.I), "speaker-invite", 0.4),
    (re.compile(r"\b(hire|hiring|join (your|our) team|career|role|position|recruit(ing)?)\b", re.I), "hiring", 0.36),
    (re.compile(r"\b(consult(ing|ant)?|advis(e|ory|or)|fractional|coach(ing)?|workshop|training)\b", re.I), "consulting", 0.34),
    (re.compile(r"\b(proposal|quote|pricing|rates?|fee( sheet)?|budget|invoice|contract|retainer|scope of work|procurement)\b", re.I), "commercial-intent", 0.38),
    (re.compile(r"\b(work with you|book a call|schedule a call|calendar link|intro call|sales call)\b", re.I), "meeting-request", 0.34),
    (re.compile(r"\b(licens(e|ing)|permission to use|white[- ]label|distribution|resell|enterprise|business development|client campaign|client looking)\b", re.I), "business-development", 0.36),
    (re.compile(r"\b(reach out|email me|dm me|message me|contact me|get in touch|business email|what email|best email|send details)\b", re.I), "contact-request", 0.24),
    (re.compile(r"@?[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}|\[EMAIL\]", re.I), "email-shared", 0.28),
]

LEAD_NEGATIVE_KEYWORDS: list[tuple[re.Pattern[str], str, float]] = [
    (re.compile(r"\b(not sponsored|not a sponsor|wish this was sponsored)\b", re.I), "sponsorship-negated", 0.45),
    (re.compile(r"\b(great video|love this|awesome content|first!|lol|haha|thanks for sharing)\b", re.I), "fan-comment", 0.24),
    (re.compile(r"\b(where did you (buy|get)|what camera|what mic|tutorial|can you explain)\b", re.I), "viewer-question", 0.1),
    (re.compile(r"\b(free followers|crypto|airdrop|giveaway|sub4sub|telegram me|whatsapp me)\b", re.I), "spam-pattern", 0.55),
    (re.compile(r"\b(i need a job|can you hire me|please hire me)\b", re.I), "job-seeker-not-lead", 0.2),
]


def rank_agents(req: RankAgentsRequest) -> RankAgentsResponse:
    installed = set(req.installed_agent_ids)
    ranked = sorted(
        (_score_agent(req.user_intent, a, installed) for a in req.agents),
        key=lambda item: item.score,
        reverse=True,
    )[: req.limit]
    capabilities = _required_capabilities(req.user_intent)
    covered = {_capability_for_agent(a) for a in req.agents if a.agent_id in installed or a.installed}
    missing = sorted(c for c in capabilities if c and c not in covered)
    summary = (
        f"Found {len(ranked)} relevant agent candidates; "
        f"{len(missing)} capability gap{'s' if len(missing) != 1 else ''} remain."
    )
    return RankAgentsResponse(ranked_agents=ranked, missing_capabilities=missing, _lumo_summary=summary)


def evaluate_agent_risk(req: RiskRequest) -> RiskResponse:
    scopes = req.requested_scopes or req.agent.scopes
    score = min(1.0, 0.08 * len(scopes))
    flags: list[str] = []
    for scope in scopes:
        lower = scope.lower()
        for term, weight in SENSITIVE_SCOPE_TERMS.items():
            if term in lower:
                score = min(1.0, score + weight)
                flag = f"Requests {term.replace('_', ' ')} access"
                if flag not in flags:
                    flags.append(flag)

    for field in req.agent.pii_scope:
        lower = field.lower()
        if "payment" in lower:
            score = min(1.0, score + 0.24)
            if "Uses payment profile data" not in flags:
                flags.append("Uses payment profile data")
        elif any(term in lower for term in ["address", "phone", "email"]):
            score = min(1.0, score + 0.08)
            if "Uses personal contact data" not in flags:
                flags.append("Uses personal contact data")

    if req.agent.requires_payment:
        score = min(1.0, score + 0.22)
        if "Can participate in money-moving flows" not in flags:
            flags.append("Can participate in money-moving flows")

    if req.category_peer_scopes:
        peer_lengths = [len(p) for p in req.category_peer_scopes]
        avg = sum(peer_lengths) / max(len(peer_lengths), 1)
        if len(scopes) > max(avg * 1.5, avg + 2):
            score = min(1.0, score + 0.2)
            flags.append("Requests more scopes than comparable marketplace agents")

    risk_level = "high" if score >= 0.68 else "medium" if score >= 0.34 else "low"
    mitigations = []
    if risk_level != "low":
        mitigations.append("Ask for only the scopes needed for this task.")
        mitigations.append("Require confirmation before any write, booking, message, or payment action.")
    summary = f"{req.agent.display_name or req.agent.agent_id} risk is {risk_level}."
    return RiskResponse(
        risk_level=risk_level,
        score=round(score, 3),
        flags=flags,
        mitigations=mitigations,
        _lumo_summary=summary,
    )


def plan_task(req: PlanTaskRequest) -> PlanTaskResponse:
    all_agents = req.installed_agents + req.marketplace_agents
    ranked = rank_agents(
        RankAgentsRequest(
            user_intent=req.user_intent,
            agents=all_agents,
            installed_agent_ids=[a.agent_id for a in req.installed_agents if a.installed],
            limit=12,
        )
    ).ranked_agents
    required = [a for a in ranked if a.installed]
    missing = [a for a in ranked if not a.installed]
    questions = _questions_for_intent(req.user_intent)
    confirmations = [
        "Confirm flight itinerary and total fare before booking.",
        "Confirm hotel room, dates, fees, and cancellation policy before booking.",
        "Confirm rides, orders, reservations, messages, or payments before dispatch.",
    ]
    rollback = [
        "Hold every booking leg until pricing has been revalidated.",
        "Use each agent's cancel tool for committed travel, food, or reservation legs.",
        "Escalate to the user when cancellation is best-effort or manual.",
    ]
    summary = (
        f"Mission plan created with {len(required)} installed agent"
        f"{'s' if len(required) != 1 else ''} and {len(missing)} marketplace candidate"
        f"{'s' if len(missing) != 1 else ''}."
    )
    return PlanTaskResponse(
        mission_id=f"mission_{uuid.uuid4().hex[:12]}",
        intent_summary=req.user_intent.strip()[:240],
        required_agents=required,
        missing_agents=missing,
        user_questions=questions,
        confirmation_points=confirmations,
        rollback_plan=rollback,
        _lumo_summary=summary,
    )


def optimize_trip(req: OptimizeTripRequest) -> OptimizeTripResponse:
    return _optimize_trip_impl(req)


def transcribe(req: TranscribeRequest) -> TranscribeResponse:
    return transcribe_audio(req)


def extract_pdf(req: ExtractPdfRequest) -> ExtractPdfResponse:
    return extract_pdf_document(req)


def embed_image_tool(req: EmbedImageRequest) -> EmbedImageResponse:
    return embed_image(req)


def detect_anomaly(req: DetectAnomalyRequest) -> DetectAnomalyResponse:
    return detect_anomaly_tool(req)


def forecast_metric(req: ForecastMetricRequest) -> ForecastMetricResponse:
    return forecast_metric_tool(req)


def embed(req: EmbedRequest) -> EmbedResponse:
    redacted_texts = [redact_for_embedding(text).text for text in req.texts]
    embeddings = [_hash_embedding(text) for text in redacted_texts]
    hashes = [hashlib.sha256(text.encode("utf-8")).hexdigest() for text in redacted_texts]
    return EmbedResponse(
        model="hashing-baseline-384",
        dimensions=384,
        embeddings=embeddings,
        content_hashes=hashes,
        _lumo_summary=f"Embedded {len(req.texts)} text chunk{'s' if len(req.texts) != 1 else ''}.",
    )


def classify(req: ClassifyRequest) -> ClassifyResponse:
    if req.classifier != "lead":
        items = [
            ClassifiedItem(label="unknown", score=0, reasons=["classifier-not-configured"], above_threshold=False)
            for _ in req.items
        ]
        return ClassifyResponse(
            classifier=req.classifier,
            items=items,
            _lumo_summary=f"Classifier {req.classifier} is not configured yet.",
        )

    results = []
    for item in req.items:
        redacted_item = redact_for_embedding(item).text
        score, reasons = _score_lead(redacted_item)
        results.append(
            ClassifiedItem(
                label="business_lead" if score >= req.threshold else "not_lead",
                score=round(score, 3),
                reasons=reasons,
                above_threshold=score >= req.threshold,
            )
        )
    return ClassifyResponse(
        classifier="lead",
        items=results,
        _lumo_summary=f"Classified {len(results)} item{'s' if len(results) != 1 else ''}.",
    )


def _score_lead(item: str) -> tuple[float, list[str]]:
    text = item.strip()
    lower = text.lower()
    score = 0.0
    reasons: list[str] = []
    positive_hits = 0
    contact_hit = False
    commercial_hit = False

    for pattern, reason, weight in LEAD_KEYWORDS:
        if pattern.search(text):
            score += weight
            positive_hits += 1
            if reason in {"contact-request", "email-shared", "meeting-request"}:
                contact_hit = True
            if reason in {"commercial-intent", "sponsorship", "brand-deal", "business-development"}:
                commercial_hit = True
            if reason not in reasons:
                reasons.append(reason)

    for pattern, reason, weight in LEAD_NEGATIVE_KEYWORDS:
        if pattern.search(text):
            score -= weight
            if reason not in reasons:
                reasons.append(reason)

    if positive_hits >= 2:
        score += 0.12
        reasons.append("multiple-lead-signals")
    if contact_hit and commercial_hit:
        score += 0.12
        reasons.append("commercial-contact-intent")
    business_sender = bool(
        re.search(
            r"\b(we|our|my company|our agency|our brand|founder|marketing team|partnerships team|my agency|i represent|i manage|i lead|i run)\b",
            lower,
        )
    )
    if business_sender:
        score += 0.18
        reasons.append("business-sender")
    if business_sender and positive_hits >= 1:
        score += 0.2
        reasons.append("business-lead-context")
    if len(text) > 180 and positive_hits > 0:
        score += 0.08
        reasons.append("substantive-length")
    if len(text) < 12:
        score -= 0.12
    score = max(0.0, min(score, 1.0))
    return round(score, 3), _dedupe(reasons)


def _dedupe(values: list[str]) -> list[str]:
    out: list[str] = []
    for value in values:
        if value not in out:
            out.append(value)
    return out


def recall(req: RecallRequest) -> RecallResponse:
    if not req.documents:
        return RecallResponse(
            hits=[],
            status="empty_index",
            _lumo_summary="No indexed documents were provided to search yet.",
        )
    redacted_query = redact_for_embedding(req.query).text
    query_terms = _terms(redacted_query)
    hits: list[RecallHit] = []
    for doc in req.documents:
        redacted_text = redact_for_embedding(doc.text).text
        doc_terms = _terms(redacted_text)
        overlap = len(query_terms & doc_terms)
        score = min(1.0, overlap / max(len(query_terms), 1))
        if score <= 0:
            continue
        hits.append(
            RecallHit(
                id=doc.id,
                score=round(score, 3),
                snippet=_snippet(redacted_text, query_terms),
                source=doc.source,
                metadata=doc.metadata,
            )
        )
    hits.sort(key=lambda hit: hit.score, reverse=True)
    selected = hits[: req.top_k]
    return RecallResponse(
        hits=selected,
        status="ok",
        _lumo_summary=f"Found {len(selected)} relevant memory hit{'s' if len(selected) != 1 else ''}.",
    )


def kg_synthesize(req: KgSynthesizeRequest) -> KgSynthesizeResponse:
    edge_hint = _kg_edge_hint(req.question)
    evidence = _kg_top_evidence(req.traversal)
    citations = _kg_citations(evidence)
    if not citations:
        return KgSynthesizeResponse(
            answer="I could not find graph-cited evidence for that question.",
            citations=[],
            edge_filter_hint=edge_hint,
            _lumo_summary="No knowledge-graph evidence was available for synthesis.",
        )

    blockers = [
        item
        for item in evidence
        if item.kind == "edge" and (item.edge_type or "").upper() in {"BLOCKED_BY", "LED_TO"}
    ]
    citation_text = "; ".join(citation.text for citation in citations[:4] if citation.text)
    if blockers:
        blocker_labels = ", ".join(_clean_text(item.text or item.edge_type or "relationship") for item in blockers[:3])
        answer = (
            f"The graph points to {blocker_labels.lower()} as the key relationship"
            f"{'s' if len(blockers) != 1 else ''}. Supporting evidence: {citation_text}."
        )
    else:
        answer = f"The graph evidence connects this question to: {citation_text}."

    return KgSynthesizeResponse(
        answer=answer[:1600],
        citations=citations[:8],
        edge_filter_hint=edge_hint,
        _lumo_summary=f"Synthesized {len(citations[:8])} cited knowledge-graph evidence item{'s' if len(citations[:8]) != 1 else ''}.",
    )


def analyze_file(req: AnalyzeFileRequest) -> AnalyzeFileResponse:
    return AnalyzeFileResponse(
        status="not_configured",
        extracted={"file_ref": req.file_ref, "task": req.task},
        _lumo_summary="File analysis is scaffolded; sandbox-backed extraction is not configured yet.",
    )


def generate_chart(req: GenerateChartRequest) -> GenerateChartResponse:
    keys = list(req.data[0].keys()) if req.data else []
    chart_type = "bar" if len(keys) >= 2 else "table"
    return GenerateChartResponse(
        chart_spec={"type": chart_type, "title": req.chart_intent, "fields": keys, "rows": req.data[:100]},
        _lumo_summary=f"Generated a {chart_type} chart spec.",
    )


def run_python_sandbox(
    req: PythonSandboxRequest,
    auth: AuthContext | None = None,
) -> PythonSandboxResponse:
    return run_python_sandbox_tool(req, auth)


def _score_agent(intent: str, agent: AgentDescriptor, installed: set[str]) -> RankedAgent:
    haystack = " ".join(
        [
            agent.agent_id,
            agent.display_name or "",
            agent.domain or "",
            agent.category or "",
            " ".join(agent.intents),
        ]
    ).lower()
    intent_terms = _terms(intent)
    agent_terms = _terms(haystack)
    overlap = len(intent_terms & agent_terms)
    capability = _capability_for_agent(agent)
    capability_hit = capability in _required_capabilities(intent)
    score = min(1.0, 0.15 + 0.08 * overlap + (0.35 if capability_hit else 0))
    is_installed = agent.installed or agent.agent_id in installed
    if is_installed:
        score = min(1.0, score + 0.08)
    reasons = []
    if overlap:
        reasons.append(f"Matches {overlap} intent term{'s' if overlap != 1 else ''}")
    if capability_hit and capability:
        reasons.append(f"Covers required {capability} capability")
    if is_installed:
        reasons.append("Already installed")
    return RankedAgent(
        agent_id=agent.agent_id,
        display_name=agent.display_name or agent.agent_id,
        score=round(score, 3),
        installed=is_installed,
        reasons=reasons or ["General marketplace candidate"],
        missing_scopes=[] if is_installed else agent.scopes[:5],
    )


def _required_capabilities(intent: str) -> set[str]:
    lower = intent.lower()
    out = set()
    for capability, keywords in CAPABILITY_KEYWORDS.items():
        if any(keyword in lower for keyword in keywords):
            out.add(capability)
    if "vegas" in lower or "trip" in lower or "travel" in lower:
        out.update({"flight", "hotel", "maps", "food", "events", "attractions"})
    if "drive" in lower or "ev" in lower or "charging" in lower:
        out.add("ev")
    return out


def _capability_for_agent(agent: AgentDescriptor) -> str | None:
    haystack = " ".join([agent.agent_id, agent.domain or "", agent.category or "", *agent.intents]).lower()
    for capability, keywords in CAPABILITY_KEYWORDS.items():
        if capability in haystack or any(keyword in haystack for keyword in keywords):
            return capability
    return None


def _questions_for_intent(intent: str) -> list[str]:
    lower = intent.lower()
    questions = []
    if "vegas" in lower or "trip" in lower or "travel" in lower:
        questions.extend(
            [
                "What is your departure city or airport?",
                "How many travelers should I plan for?",
                "What hotel budget and preferred area in Las Vegas should I use?",
                "Do you want cheapest, fastest, or most comfortable travel options?",
            ]
        )
    if "drive" in lower or "ev" in lower:
        questions.append("If driving, what EV model or charging connector should I optimize for?")
    return questions or ["What constraints should I optimize for: price, speed, comfort, or reliability?"]


def _terms(text: str) -> set[str]:
    return set(re.findall(r"[a-z0-9]+", text.lower()))


def _snippet(text: str, query_terms: set[str]) -> str:
    if not text:
        return ""
    lower = text.lower()
    first = min((lower.find(term) for term in query_terms if term in lower), default=0)
    start = max(0, first - 80)
    end = min(len(text), first + 220)
    return text[start:end].strip()


def _kg_edge_hint(question: str) -> list[str]:
    terms = _terms(question)
    if {"why", "made", "over", "blocked", "block", "cancel", "cancelled", "canceled"} & terms:
        return ["BLOCKED_BY", "LED_TO", "RELATED_TO"]
    if {"where", "place", "location", "at"} & terms:
        return ["OCCURS_AT", "RELATED_TO", "MENTIONS"]
    if {"prefer", "preference", "like", "picked", "pick"} & terms:
        return ["PREFERS", "LED_TO", "RELATED_TO"]
    return []


def _kg_top_evidence(traversal: list[object]) -> list[KgEvidenceItem]:
    out: list[KgEvidenceItem] = []
    seen: set[tuple[str, str]] = set()
    for row in traversal[:30]:
        evidence = getattr(row, "evidence", [])
        for item in evidence:
            key_id = item.node_id or item.edge_id or item.source_row_id
            key = (item.kind, key_id)
            if key in seen:
                continue
            seen.add(key)
            out.append(item)
            if len(out) >= 30:
                return out
    return out


def _kg_citations(evidence: list[KgEvidenceItem]) -> list[KgSynthesizeCitation]:
    citations: list[KgSynthesizeCitation] = []
    seen: set[str] = set()
    for item in evidence:
        if item.kind != "node" or not item.node_id or not item.label:
            continue
        if item.node_id in seen:
            continue
        seen.add(item.node_id)
        text = _clean_text(item.text or item.label)
        citations.append(
            KgSynthesizeCitation(
                node_id=item.node_id,
                label=item.label,
                source_table=item.source_table,
                source_row_id=item.source_row_id,
                source_url=item.source_url,
                asserted_at=item.asserted_at,
                text=text,
            )
        )
    return citations


def _clean_text(text: str) -> str:
    return re.sub(r"\s+", " ", text).strip()


def _hash_embedding(text: str, dimensions: int = 384) -> list[float]:
    values = []
    seed = hashlib.sha256(text.encode("utf-8")).digest()
    for i in range(dimensions):
        digest = hashlib.sha256(seed + i.to_bytes(2, "big")).digest()
        raw = int.from_bytes(digest[:4], "big") / 2**32
        values.append(raw * 2 - 1)
    norm = math.sqrt(sum(v * v for v in values)) or 1.0
    return [round(v / norm, 6) for v in values]


def top_terms(texts: list[str], limit: int = 20) -> list[str]:
    counter: Counter[str] = Counter()
    for text in texts:
        counter.update(_terms(text))
    return [term for term, _ in counter.most_common(limit)]
