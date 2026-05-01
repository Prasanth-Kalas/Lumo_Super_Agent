"""Pre-LLM planning surface for the Lumo Intelligence Layer.

Defines the cross-language contract for ``POST /api/tools/plan`` — the
endpoint the orchestrator hits BEFORE every assistant turn to get the
intent bucket, suggestion chips, optional system-prompt addendum, and
(later) compound mission graph.

Phase 0 (this module's current state) ships the schemas + a stub route
so the TS-side parallel-write client can be built against a real
contract. Phase 1 replaces the stub body with real classification,
suggestion generation, and OR-Tools compound planning — the wire shape
stays stable; only the ``X-Lumo-Plan-Stub: 1`` response header drops.
"""
