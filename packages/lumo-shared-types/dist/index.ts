/**
 * AUTO-GENERATED FROM apps/ml-service/lumo_ml/schemas.py.
 *
 * Do not edit by hand. To update:
 *   cd packages/lumo-shared-types && python3 codegen.py
 *
 * CI runs scripts/check-drift.sh which re-runs codegen and fails the build
 * if dist/index.ts has drifted from the Pydantic source.
 */

/* tslint:disable */
/* eslint-disable */
/**
/* This file was automatically generated from pydantic models by running pydantic2ts.
/* Do not modify it by hand - just update the pydantic models and then re-run the script
*/

export interface AgentDescriptor {
  agent_id: string;
  display_name?: string | null;
  domain?: string | null;
  category?: string | null;
  intents?: string[];
  scopes?: string[];
  installed?: boolean;
  connect_model?: string | null;
  requires_payment?: boolean;
  pii_scope?: string[];
}
export interface AnalyzeFileRequest {
  file_ref: string;
  task: string;
  output_schema?: {
    [k: string]: unknown;
  } | null;
}
export interface AnalyzeFileResponse {
  _lumo_summary: string;
  status: "not_configured" | "ok";
  extracted?: {
    [k: string]: unknown;
  };
}
export interface AnomalyContext {
  lookback_days?: number | null;
  expected_frequency?: "daily" | "hourly" | "weekly";
  min_points?: number;
}
export interface AnomalyFinding {
  finding_type: "spike" | "drop" | "level_shift" | "pattern_change";
  anomaly_ts: string;
  expected_value: number;
  actual_value: number;
  z_score: number;
  confidence: number;
}
export interface ChatTurn {
  role: "user" | "assistant";
  content: string;
}
export interface ClassifiedItem {
  label: string;
  score: number;
  reasons?: string[];
  above_threshold: boolean;
}
export interface ClassifyRequest {
  classifier?: string;
  /**
   * @minItems 1
   * @maxItems 100
   */
  items: [string, ...string[]];
  threshold?: number;
}
export interface ClassifyResponse {
  _lumo_summary: string;
  classifier: string;
  items: ClassifiedItem[];
}
/**
 * Planning-time leg of a compound mission.
 */
export interface CompoundMissionLeg {
  leg_id: string;
  agent_id: string;
  agent_display_name: string;
  description: string;
  /**
   * @maxItems 12
   */
  depends_on?:
    | []
    | [string]
    | [string, string]
    | [string, string, string]
    | [string, string, string, string]
    | [string, string, string, string, string]
    | [string, string, string, string, string, string]
    | [string, string, string, string, string, string, string]
    | [string, string, string, string, string, string, string, string]
    | [string, string, string, string, string, string, string, string, string]
    | [string, string, string, string, string, string, string, string, string, string]
    | [string, string, string, string, string, string, string, string, string, string, string]
    | [string, string, string, string, string, string, string, string, string, string, string, string];
}
/**
 * Topologically-orderable plan emitted when the planner detects a
 * multi-agent compound trip. The orchestrator uses this to seed the
 * runtime ``AssistantCompoundDispatchFrameValue`` once dispatch starts.
 */
export interface CompoundMissionPlan {
  compound_transaction_id: string;
  /**
   * @minItems 1
   * @maxItems 12
   */
  legs:
    | [CompoundMissionLeg]
    | [CompoundMissionLeg, CompoundMissionLeg]
    | [CompoundMissionLeg, CompoundMissionLeg, CompoundMissionLeg]
    | [CompoundMissionLeg, CompoundMissionLeg, CompoundMissionLeg, CompoundMissionLeg]
    | [CompoundMissionLeg, CompoundMissionLeg, CompoundMissionLeg, CompoundMissionLeg, CompoundMissionLeg]
    | [
        CompoundMissionLeg,
        CompoundMissionLeg,
        CompoundMissionLeg,
        CompoundMissionLeg,
        CompoundMissionLeg,
        CompoundMissionLeg
      ]
    | [
        CompoundMissionLeg,
        CompoundMissionLeg,
        CompoundMissionLeg,
        CompoundMissionLeg,
        CompoundMissionLeg,
        CompoundMissionLeg,
        CompoundMissionLeg
      ]
    | [
        CompoundMissionLeg,
        CompoundMissionLeg,
        CompoundMissionLeg,
        CompoundMissionLeg,
        CompoundMissionLeg,
        CompoundMissionLeg,
        CompoundMissionLeg,
        CompoundMissionLeg
      ]
    | [
        CompoundMissionLeg,
        CompoundMissionLeg,
        CompoundMissionLeg,
        CompoundMissionLeg,
        CompoundMissionLeg,
        CompoundMissionLeg,
        CompoundMissionLeg,
        CompoundMissionLeg,
        CompoundMissionLeg
      ]
    | [
        CompoundMissionLeg,
        CompoundMissionLeg,
        CompoundMissionLeg,
        CompoundMissionLeg,
        CompoundMissionLeg,
        CompoundMissionLeg,
        CompoundMissionLeg,
        CompoundMissionLeg,
        CompoundMissionLeg,
        CompoundMissionLeg
      ]
    | [
        CompoundMissionLeg,
        CompoundMissionLeg,
        CompoundMissionLeg,
        CompoundMissionLeg,
        CompoundMissionLeg,
        CompoundMissionLeg,
        CompoundMissionLeg,
        CompoundMissionLeg,
        CompoundMissionLeg,
        CompoundMissionLeg,
        CompoundMissionLeg
      ]
    | [
        CompoundMissionLeg,
        CompoundMissionLeg,
        CompoundMissionLeg,
        CompoundMissionLeg,
        CompoundMissionLeg,
        CompoundMissionLeg,
        CompoundMissionLeg,
        CompoundMissionLeg,
        CompoundMissionLeg,
        CompoundMissionLeg,
        CompoundMissionLeg,
        CompoundMissionLeg
      ];
}
export interface DetectAnomalyRequest {
  metric_key: string;
  /**
   * @minItems 1
   * @maxItems 5000
   */
  points: [MetricPoint, ...MetricPoint[]];
  context?: AnomalyContext;
}
export interface MetricPoint {
  ts: string;
  value: number;
  dimensions?: {
    [k: string]: unknown;
  };
}
export interface DetectAnomalyResponse {
  _lumo_summary: string;
  findings: AnomalyFinding[];
  model:
    | "prophet"
    | "isolation_forest"
    | "hybrid"
    | "seasonal_robust"
    | "dimension_pattern"
    | "hybrid_fallback"
    | "not_configured";
  model_detail?: string | null;
  points_analyzed: number;
}
export interface EmbedImageRequest {
  image_url: string;
  /**
   * @maxItems 64
   */
  candidate_labels?: string[];
  source_metadata?: {
    [k: string]: unknown;
  };
}
export interface EmbedImageResponse {
  _lumo_summary: string;
  status: "ok" | "not_configured" | "error";
  model: string;
  dimensions: number;
  embedding: number[];
  labels: ImageLabel[];
  summary_text: string;
  content_hash: string;
}
export interface ImageLabel {
  label: string;
  score: number;
}
export interface EmbedRequest {
  /**
   * @minItems 1
   * @maxItems 128
   */
  texts: [string, ...string[]];
  source_metadata?: {
    [k: string]: unknown;
  };
}
export interface EmbedResponse {
  _lumo_summary: string;
  model: string;
  dimensions: number;
  embeddings: number[][];
  content_hashes: string[];
}
export interface ExtractPdfRequest {
  pdf_url: string;
  source_metadata?: {
    [k: string]: unknown;
  };
}
export interface ExtractPdfResponse {
  _lumo_summary: string;
  status: "ok" | "not_configured" | "error";
  pages: PdfPage[];
  total_pages: number;
  language?: string | null;
}
export interface PdfPage {
  page_number: number;
  blocks?: PdfBlock[];
}
export interface PdfBlock {
  type: "heading" | "paragraph" | "table" | "list";
  text: string;
  bbox?: number[] | null;
}
export interface ForecastContext {
  expected_frequency?: "daily" | "hourly" | "weekly";
}
export interface ForecastMetricRequest {
  metric_key: string;
  /**
   * @minItems 1
   * @maxItems 5000
   */
  points: [MetricPoint, ...MetricPoint[]];
  horizon_days: number;
  context?: ForecastContext;
}
export interface ForecastMetricResponse {
  _lumo_summary: string;
  forecast: ForecastPoint[];
  model: "prophet" | "naive_seasonal" | "not_configured";
  confidence_interval?: number;
  points_used: number;
}
export interface ForecastPoint {
  ts: string;
  predicted_value: number;
  lower_bound: number;
  upper_bound: number;
}
export interface GenerateChartRequest {
  chart_intent: string;
  data?: {
    [k: string]: unknown;
  }[];
}
export interface GenerateChartResponse {
  _lumo_summary: string;
  chart_spec: {
    [k: string]: unknown;
  };
}
export interface KgEvidenceItem {
  kind: "node" | "edge";
  node_id?: string | null;
  edge_id?: string | null;
  label?: string | null;
  edge_type?: string | null;
  source_table: string;
  source_row_id: string;
  source_url?: string | null;
  asserted_at?: string | null;
  text?: string | null;
}
export interface KgSynthesizeCitation {
  node_id: string;
  label: string;
  source_table: string;
  source_row_id: string;
  source_url?: string | null;
  asserted_at?: string | null;
  text: string;
}
export interface KgSynthesizeRequest {
  question: string;
  /**
   * @maxItems 30
   */
  traversal?: KgTraversalItem[];
}
export interface KgTraversalItem {
  node_id: string;
  label: string;
  properties?: {
    [k: string]: unknown;
  };
  depth: number;
  score: number;
  /**
   * @maxItems 8
   */
  path?:
    | []
    | [string]
    | [string, string]
    | [string, string, string]
    | [string, string, string, string]
    | [string, string, string, string, string]
    | [string, string, string, string, string, string]
    | [string, string, string, string, string, string, string]
    | [string, string, string, string, string, string, string, string];
  /**
   * @maxItems 8
   */
  edge_types?:
    | []
    | [string]
    | [string, string]
    | [string, string, string]
    | [string, string, string, string]
    | [string, string, string, string, string]
    | [string, string, string, string, string, string]
    | [string, string, string, string, string, string, string]
    | [string, string, string, string, string, string, string, string];
  /**
   * @maxItems 64
   */
  evidence?: KgEvidenceItem[];
}
export interface KgSynthesizeResponse {
  _lumo_summary: string;
  answer: string;
  citations: KgSynthesizeCitation[];
  edge_filter_hint?: string[];
  model?: "deterministic_kg_synthesizer" | "llm_synthesizer";
}
export interface LumoToolResponse {
  _lumo_summary: string;
}
export interface OptimizeTripRequest {
  objective?: "balanced" | "fastest" | "cheapest" | "comfort";
  /**
   * @minItems 2
   * @maxItems 24
   */
  stops: [TripStop, TripStop, ...TripStop[]];
  /**
   * @maxItems 576
   */
  legs?: TripLegEstimate[];
  start_stop_id: string;
  end_stop_id?: string | null;
  max_solver_seconds?: number;
}
export interface TripStop {
  id: string;
  label: string;
  category: string;
  duration_minutes?: number;
  earliest_start_minute?: number;
  latest_end_minute?: number;
  priority?: number;
}
export interface TripLegEstimate {
  from_id: string;
  to_id: string;
  duration_minutes: number;
  cost_usd?: number;
  distance_km?: number;
}
export interface OptimizeTripResponse {
  _lumo_summary: string;
  status: "ok" | "fallback" | "infeasible";
  objective: "balanced" | "fastest" | "cheapest" | "comfort";
  route: OptimizedTripStop[];
  dropped_stop_ids?: string[];
  total_duration_minutes: number;
  total_cost_usd: number;
  total_distance_km: number;
  solver: string;
}
export interface OptimizedTripStop {
  id: string;
  label: string;
  category: string;
  sequence: number;
  arrival_minute: number;
  departure_minute: number;
  wait_minutes?: number;
}
export interface PlanRequest {
  user_message: string;
  session_id: string;
  user_id: string;
  /**
   * @maxItems 50
   */
  history?: ChatTurn[];
  /**
   * @maxItems 64
   */
  approvals?: SessionAppApproval[];
  planning_step_hint?: ("clarification" | "selection" | "confirmation" | "post_booking") | null;
  last_assistant_message?: string | null;
  user_first_name?: string | null;
  user_region?: string;
  mode?: "text" | "voice";
  /**
   * @maxItems 80
   */
  agents?: AgentManifestForPrompt[];
  memory?: MemorySnapshot | null;
  ambient?: AmbientContext | null;
  booking_profile?: BookingProfileSnapshot | null;
}
/**
 * Pre-bootstrapped per-session approval record. Mirrors
 * ``apps/web/lib/session-app-approvals.ts``.
 */
export interface SessionAppApproval {
  user_id: string;
  session_id: string;
  agent_id: string;
  /**
   * @maxItems 64
   */
  granted_scopes?: string[];
  approved_at: string;
  connected_at?: string | null;
  connection_provider?: string | null;
}
/**
 * Slim subset of ``RegistryEntry`` needed by ``buildSystemPrompt``
 * — the prompt only renders display_name, agent_id, one_liner, and
 * up to 3 example utterances per agent. ``health_score`` gates the
 * CURRENTLY UNAVAILABLE block.
 */
export interface AgentManifestForPrompt {
  display_name: string;
  agent_id: string;
  one_liner: string;
  /**
   * @maxItems 12
   */
  example_utterances?:
    | []
    | [string]
    | [string, string]
    | [string, string, string]
    | [string, string, string, string]
    | [string, string, string, string, string]
    | [string, string, string, string, string, string]
    | [string, string, string, string, string, string, string]
    | [string, string, string, string, string, string, string, string]
    | [string, string, string, string, string, string, string, string, string]
    | [string, string, string, string, string, string, string, string, string, string]
    | [string, string, string, string, string, string, string, string, string, string, string]
    | [string, string, string, string, string, string, string, string, string, string, string, string];
  health_score?: number;
  [k: string]: unknown;
}
/**
 * The bag the orchestrator hands ``buildSystemPrompt`` for memory
 * context. Mirrors the inline TS shape ``{profile, facts[],
 * patterns[]}`` declared on ``BuildSystemPromptOpts.memory``.
 */
export interface MemorySnapshot {
  profile?: UserProfile | null;
  /**
   * @maxItems 64
   */
  facts?: UserFact[];
  /**
   * @maxItems 32
   */
  patterns?: BehaviorPattern[];
  [k: string]: unknown;
}
/**
 * Mirrors apps/web/lib/memory.ts:UserProfile. The 13 whitelisted
 * fields surfaced by ``profileToLines`` are: display_name, timezone,
 * preferred_language, home_address, work_address, dietary_flags,
 * allergies, preferred_cuisines, preferred_airline_class,
 * preferred_airline_seat, preferred_hotel_chains, budget_tier,
 * preferred_payment_hint.
 */
export interface UserProfile {
  id: string;
  display_name?: string | null;
  timezone?: string | null;
  preferred_language?: string | null;
  home_address?: AddressPayload | null;
  work_address?: AddressPayload | null;
  /**
   * @maxItems 32
   */
  dietary_flags?: string[];
  /**
   * @maxItems 32
   */
  allergies?: string[];
  /**
   * @maxItems 32
   */
  preferred_cuisines?: string[];
  preferred_airline_class?: string | null;
  preferred_airline_seat?: string | null;
  /**
   * @maxItems 32
   */
  preferred_hotel_chains?: string[];
  budget_tier?: string | null;
  preferred_payment_hint?: string | null;
  [k: string]: unknown;
}
/**
 * Mirrors apps/web/lib/memory.ts:AddressPayload — every field
 * optional; ``addressToLine`` formatter joins ``line1, city, region,
 * country`` with ``label`` prefix when present.
 */
export interface AddressPayload {
  label?: string | null;
  line1?: string | null;
  line2?: string | null;
  city?: string | null;
  region?: string | null;
  country?: string | null;
  postal_code?: string | null;
  [k: string]: unknown;
}
/**
 * Mirrors apps/web/lib/memory.ts:UserFact. The prompt only renders
 * ``[category] fact`` per row; other fields ride along for codex's
 * consumer-side selection logic.
 */
export interface UserFact {
  id: string;
  fact: string;
  category: "preference" | "identity" | "habit" | "location" | "constraint" | "context" | "milestone" | "other";
  source?: ("explicit" | "inferred" | "behavioral") | null;
  confidence?: number | null;
  [k: string]: unknown;
}
/**
 * Mirrors apps/web/lib/memory.ts:BehaviorPattern. The prompt
 * renders ``description (observed N×)`` per row.
 */
export interface BehaviorPattern {
  id: string;
  description: string;
  evidence_count: number;
  [k: string]: unknown;
}
/**
 * Mirrors apps/web/lib/system-prompt.ts:AmbientContext — browser-
 * sent right-now signals, never persisted.
 */
export interface AmbientContext {
  local_time?: string | null;
  timezone?: string | null;
  coords?: AmbientCoords | null;
  location_label?: string | null;
  device_kind?: string | null;
  [k: string]: unknown;
}
export interface AmbientCoords {
  lat: number;
  lng: number;
  accuracy_m?: number | null;
  [k: string]: unknown;
}
/**
 * Mirrors apps/web/lib/booking-profile-core.ts:BookingProfileSnapshot
 * — pruned to the subset the prompt actually reads. Codex's plan-
 * client serializes only ``status`` + ``label`` per field; the typed
 * payload values stay TS-side.
 */
export interface BookingProfileSnapshot {
  user_id: string;
  /**
   * @maxItems 64
   */
  granted_scopes?: string[];
  fields?: {
    [k: string]: BookingProfileFieldSlim;
  };
  /**
   * @maxItems 8
   */
  required_missing_fields?:
    | []
    | ["name" | "email" | "phone" | "payment_method_id" | "traveler_profile" | "passport" | "passport_optional" | "dob"]
    | [
        (
          | "name"
          | "email"
          | "phone"
          | "payment_method_id"
          | "traveler_profile"
          | "passport"
          | "passport_optional"
          | "dob"
        ),
        "name" | "email" | "phone" | "payment_method_id" | "traveler_profile" | "passport" | "passport_optional" | "dob"
      ]
    | [
        (
          | "name"
          | "email"
          | "phone"
          | "payment_method_id"
          | "traveler_profile"
          | "passport"
          | "passport_optional"
          | "dob"
        ),
        (
          | "name"
          | "email"
          | "phone"
          | "payment_method_id"
          | "traveler_profile"
          | "passport"
          | "passport_optional"
          | "dob"
        ),
        "name" | "email" | "phone" | "payment_method_id" | "traveler_profile" | "passport" | "passport_optional" | "dob"
      ]
    | [
        (
          | "name"
          | "email"
          | "phone"
          | "payment_method_id"
          | "traveler_profile"
          | "passport"
          | "passport_optional"
          | "dob"
        ),
        (
          | "name"
          | "email"
          | "phone"
          | "payment_method_id"
          | "traveler_profile"
          | "passport"
          | "passport_optional"
          | "dob"
        ),
        (
          | "name"
          | "email"
          | "phone"
          | "payment_method_id"
          | "traveler_profile"
          | "passport"
          | "passport_optional"
          | "dob"
        ),
        "name" | "email" | "phone" | "payment_method_id" | "traveler_profile" | "passport" | "passport_optional" | "dob"
      ]
    | [
        (
          | "name"
          | "email"
          | "phone"
          | "payment_method_id"
          | "traveler_profile"
          | "passport"
          | "passport_optional"
          | "dob"
        ),
        (
          | "name"
          | "email"
          | "phone"
          | "payment_method_id"
          | "traveler_profile"
          | "passport"
          | "passport_optional"
          | "dob"
        ),
        (
          | "name"
          | "email"
          | "phone"
          | "payment_method_id"
          | "traveler_profile"
          | "passport"
          | "passport_optional"
          | "dob"
        ),
        (
          | "name"
          | "email"
          | "phone"
          | "payment_method_id"
          | "traveler_profile"
          | "passport"
          | "passport_optional"
          | "dob"
        ),
        "name" | "email" | "phone" | "payment_method_id" | "traveler_profile" | "passport" | "passport_optional" | "dob"
      ]
    | [
        (
          | "name"
          | "email"
          | "phone"
          | "payment_method_id"
          | "traveler_profile"
          | "passport"
          | "passport_optional"
          | "dob"
        ),
        (
          | "name"
          | "email"
          | "phone"
          | "payment_method_id"
          | "traveler_profile"
          | "passport"
          | "passport_optional"
          | "dob"
        ),
        (
          | "name"
          | "email"
          | "phone"
          | "payment_method_id"
          | "traveler_profile"
          | "passport"
          | "passport_optional"
          | "dob"
        ),
        (
          | "name"
          | "email"
          | "phone"
          | "payment_method_id"
          | "traveler_profile"
          | "passport"
          | "passport_optional"
          | "dob"
        ),
        (
          | "name"
          | "email"
          | "phone"
          | "payment_method_id"
          | "traveler_profile"
          | "passport"
          | "passport_optional"
          | "dob"
        ),
        "name" | "email" | "phone" | "payment_method_id" | "traveler_profile" | "passport" | "passport_optional" | "dob"
      ]
    | [
        (
          | "name"
          | "email"
          | "phone"
          | "payment_method_id"
          | "traveler_profile"
          | "passport"
          | "passport_optional"
          | "dob"
        ),
        (
          | "name"
          | "email"
          | "phone"
          | "payment_method_id"
          | "traveler_profile"
          | "passport"
          | "passport_optional"
          | "dob"
        ),
        (
          | "name"
          | "email"
          | "phone"
          | "payment_method_id"
          | "traveler_profile"
          | "passport"
          | "passport_optional"
          | "dob"
        ),
        (
          | "name"
          | "email"
          | "phone"
          | "payment_method_id"
          | "traveler_profile"
          | "passport"
          | "passport_optional"
          | "dob"
        ),
        (
          | "name"
          | "email"
          | "phone"
          | "payment_method_id"
          | "traveler_profile"
          | "passport"
          | "passport_optional"
          | "dob"
        ),
        (
          | "name"
          | "email"
          | "phone"
          | "payment_method_id"
          | "traveler_profile"
          | "passport"
          | "passport_optional"
          | "dob"
        ),
        "name" | "email" | "phone" | "payment_method_id" | "traveler_profile" | "passport" | "passport_optional" | "dob"
      ]
    | [
        (
          | "name"
          | "email"
          | "phone"
          | "payment_method_id"
          | "traveler_profile"
          | "passport"
          | "passport_optional"
          | "dob"
        ),
        (
          | "name"
          | "email"
          | "phone"
          | "payment_method_id"
          | "traveler_profile"
          | "passport"
          | "passport_optional"
          | "dob"
        ),
        (
          | "name"
          | "email"
          | "phone"
          | "payment_method_id"
          | "traveler_profile"
          | "passport"
          | "passport_optional"
          | "dob"
        ),
        (
          | "name"
          | "email"
          | "phone"
          | "payment_method_id"
          | "traveler_profile"
          | "passport"
          | "passport_optional"
          | "dob"
        ),
        (
          | "name"
          | "email"
          | "phone"
          | "payment_method_id"
          | "traveler_profile"
          | "passport"
          | "passport_optional"
          | "dob"
        ),
        (
          | "name"
          | "email"
          | "phone"
          | "payment_method_id"
          | "traveler_profile"
          | "passport"
          | "passport_optional"
          | "dob"
        ),
        (
          | "name"
          | "email"
          | "phone"
          | "payment_method_id"
          | "traveler_profile"
          | "passport"
          | "passport_optional"
          | "dob"
        ),
        "name" | "email" | "phone" | "payment_method_id" | "traveler_profile" | "passport" | "passport_optional" | "dob"
      ];
  prefill_summary?: string | null;
  [k: string]: unknown;
}
/**
 * Slim view of ``BookingProfileField<T>``. The prompt only reads
 * ``status`` and the optional ``label`` — never the typed value — so
 * the wire shape doesn't have to discriminate on the field's type
 * parameter.
 */
export interface BookingProfileFieldSlim {
  status: "present" | "missing" | "not_in_scope";
  label?: string | null;
  [k: string]: unknown;
}
export interface PlanResponse {
  intent_bucket: "fast_path" | "tool_path" | "reasoning_path";
  planning_step: "clarification" | "selection" | "confirmation" | "post_booking";
  /**
   * @maxItems 4
   */
  suggestions?:
    | []
    | [Suggestion]
    | [Suggestion, Suggestion]
    | [Suggestion, Suggestion, Suggestion]
    | [Suggestion, Suggestion, Suggestion, Suggestion];
  system_prompt_addendum?: string | null;
  full_system_prompt?: string | null;
  compound_graph?: CompoundMissionPlan | null;
  profile_summary_hints?: ProfileSummaryHints | null;
}
/**
 * Suggestion-chip shape attached to clarification turns.
 */
export interface Suggestion {
  id: string;
  label: string;
  value: string;
}
/**
 * Slim view of the user's booking-profile autofill state. Lets the
 * planner shape clarification questions ("we have your passport but
 * not DOB — ask for DOB?") without parsing the full snapshot.
 */
export interface ProfileSummaryHints {
  /**
   * @maxItems 32
   */
  available_fields?: string[];
  /**
   * @maxItems 32
   */
  required_missing_fields?: string[];
  prefill_summary?: string | null;
}
export interface PlanTaskRequest {
  user_intent: string;
  installed_agents?: AgentDescriptor[];
  marketplace_agents?: AgentDescriptor[];
  user_context_summary?: string | null;
}
export interface PlanTaskResponse {
  _lumo_summary: string;
  mission_id: string;
  intent_summary: string;
  required_agents: RankedAgent[];
  missing_agents: RankedAgent[];
  user_questions: string[];
  confirmation_points: string[];
  rollback_plan: string[];
}
export interface RankedAgent {
  agent_id: string;
  display_name: string;
  score: number;
  installed: boolean;
  reasons?: string[];
  missing_scopes?: string[];
}
export interface PythonSandboxRequest {
  code: string;
  timeout_seconds?: number;
  network_policy?: "disabled" | "allowlist";
}
export interface PythonSandboxResponse {
  _lumo_summary: string;
  status: "not_configured" | "ok" | "error" | "timeout" | "denied";
  stdout?: string;
  stderr?: string;
  duration_ms?: number;
  artifacts?: {
    [k: string]: unknown;
  }[];
}
export interface RankAgentsRequest {
  user_intent: string;
  agents?: AgentDescriptor[];
  installed_agent_ids?: string[];
  limit?: number;
}
export interface RankAgentsResponse {
  _lumo_summary: string;
  ranked_agents: RankedAgent[];
  missing_capabilities: string[];
}
export interface RecallDocument {
  id: string;
  text: string;
  source?: string | null;
  metadata?: {
    [k: string]: unknown;
  };
}
export interface RecallHit {
  id: string;
  score: number;
  snippet: string;
  source?: string | null;
  metadata?: {
    [k: string]: unknown;
  };
}
export interface RecallRequest {
  query: string;
  documents?: RecallDocument[];
  top_k?: number;
}
export interface RecallResponse {
  _lumo_summary: string;
  hits: RecallHit[];
  status: "ok" | "empty_index" | "partial";
}
export interface RiskRequest {
  agent: AgentDescriptor;
  requested_scopes?: string[];
  category_peer_scopes?: string[][];
}
export interface RiskResponse {
  _lumo_summary: string;
  risk_level: "low" | "medium" | "high";
  score: number;
  flags?: string[];
  mitigations?: string[];
}
export interface TranscribeRequest {
  audio_url: string;
  language?: string | null;
  speaker_diarization?: boolean;
}
export interface TranscribeResponse {
  _lumo_summary: string;
  status: "ok" | "not_configured" | "error";
  transcript: string;
  segments: TranscriptSegment[];
  language?: string | null;
  duration_s: number;
  model: string;
  diarization?: "not_requested" | "ok" | "not_configured" | "error";
}
export interface TranscriptSegment {
  start: number;
  end: number;
  text: string;
  speaker?: string | null;
}
