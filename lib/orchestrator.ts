/**
 * Orchestrator loop.
 *
 * Single entry point the /api/chat route calls per user turn. Handles:
 *  - building the system prompt from the registry,
 *  - running the Claude tool-use loop,
 *  - dispatching each tool_use to the correct agent via router.ts,
 *  - streaming assistant text (and SSE frames) back to the client,
 *  - persisting the turn (stubbed — wire to Supabase in follow-up PR),
 *  - failing over to OpenAI (GPT-4o) when Anthropic is unhealthy.
 *
 * Compound orchestration (task #29, 2026-04):
 *  - After the tool-use loop, if Claude priced ≥2 legs in a single turn
 *    (each one's tool result carried a v0.1 `_lumo_summary` envelope and
 *    we can resolve a bookable counterpart + monetary total), we build a
 *    compound TripSummary via `lib/trip-planner` and stash a draft trip
 *    in `lib/trip-state`. The shell then renders a single TripConfirmationCard.
 *  - When the user affirms on the next turn, `/api/chat` doesn't re-enter
 *    the Claude loop — it calls `dispatchConfirmedTrip` from this module,
 *    which walks legs in forward-topological order, emits `leg_status`
 *    frames live, and on any failure invokes the Saga (`lib/saga`) and
 *    emits rollback `leg_status` frames.
 *
 * This file is intentionally self-contained. The money-gate lives inside
 * router.dispatchToolCall — not here — so we cannot accidentally bypass it.
 */

import Anthropic from "@anthropic-ai/sdk";
import { ensureRegistry, userScopedBridge } from "./agent-registry.js";
import { listConnectionsForUser } from "./connections.js";
import { listInstalledAgentsForUser } from "./app-installs.js";
import { dispatchToolCall, type DispatchContext } from "./router.js";
import { userMcpBridge, type McpBridgeResult } from "./mcp/registry.js";
import { dispatchMcpTool, isMcpToolName } from "./mcp/dispatch.js";
import { dispatchWithRetry } from "./retry.js";
import { buildSystemPrompt, type AmbientContext } from "./system-prompt.js";
import {
  forgetFact,
  getProfile,
  listHighConfidencePatterns,
  retrieveRelevantFacts,
  saveFact,
  upsertProfile,
  type FactCategory,
  type UserFact,
} from "./memory.js";
import { META_TOOLS, isMetaToolName } from "./meta-tools.js";
import {
  createIntent,
  deleteIntent,
  updateIntent,
  IntentError,
} from "./standing-intents.js";
import { assembleTripSummary, TripAssemblyError, type PricedLeg } from "./trip-planner.js";
import {
  beginDispatch,
  confirmTrip,
  createDraftTrip,
  finalizeTrip,
  getTripById,
  getTripBySession,
  isCancelRequested,
  snapshot,
  updateLeg,
  type TripRecord,
} from "./trip-state.js";
import { planRollback } from "./saga.js";
import { openEscalation } from "./escalations.js";
import {
  isAffirmative,
  hashSummary,
  hashTripSummary,
  extractAttachedSummary,
  stripAttachedSummary,
  type AttachedSummary,
  type ConfirmationKind,
  type ConfirmationSummary,
  type TripSummaryPayload,
} from "@lumo/agent-sdk";

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
  /** When the assistant rendered a structured summary, the canonical hash. */
  summary?: ConfirmationSummary | null;
}

export interface OrchestratorInput {
  session_id: string;
  user_id: string;
  user_first_name?: string | null;
  user_region: string;
  device_kind: "web" | "ios" | "android" | "watch";
  /** The full thread, oldest first, including the new user message as the last element. */
  messages: ChatMessage[];
  /** Opaque PII bag — router will filter per-agent. */
  user_pii: Record<string, unknown>;
  /**
   * Interaction mode. "voice" means the user is hearing responses,
   * not reading them — likely driving. The system prompt is tuned
   * to keep turns short, avoid markdown, read amounts naturally,
   * and narrate structured summaries as spoken prose instead of
   * relying on the confirmation card UI.
   *
   * Defaults to "text". Only "voice" gets the adapted prompt — any
   * unknown value is treated as text so future mode additions don't
   * accidentally change production behavior.
   */
  mode?: "text" | "voice";
  /**
   * Ambient right-now context — browser's local time, timezone, device,
   * and (with permission) coarse geolocation. Threaded into the system
   * prompt so Claude can reason about "near the user now" without us
   * having to persist anything.
   */
  ambient?: AmbientContext;
}

/**
 * An "interactive selection" emitted for tool results that should render
 * inline selection UI (food menu with checkboxes, flight offers with
 * radio). This is a separate concept from `summary`: a summary gates a
 * money-moving confirmation; a selection narrows candidates that the
 * orchestrator is about to feed into the next tool call.
 *
 * Shape intentionally stays loose at this boundary — the chat shell's
 * client-side components are the typed surface (FoodMenuSelectCard /
 * FlightOffersSelectCard). The orchestrator's job is just to mark
 * "this tool result should be rendered as selection kind X".
 */
export interface InteractiveSelection {
  kind: "food_menu" | "flight_offers" | "time_slots";
  /** The raw (or lightly-reshaped) tool result payload. */
  payload: unknown;
}

export interface OrchestratorTurn {
  assistant_text: string;
  tool_calls: Array<{
    name: string;
    agent_id: string;
    latency_ms: number;
    ok: boolean;
    error_code?: string;
  }>;
  /** The summary we rendered this turn, if any (to persist for next turn's gate). */
  summary: ConfirmationSummary | null;
  /**
   * Interactive selections surfaced this turn. At most one per kind —
   * if the LLM called `food_get_restaurant_menu` twice in the same
   * turn (unusual), the last one wins.
   */
  selections: InteractiveSelection[];
  /**
   * When the turn materialised a compound trip draft, the trip_id. The
   * route handler uses this to bind SSE `leg_status` frames to the right
   * summary on the next (confirm) turn.
   */
  draft_trip_id?: string;
}

/** Anything the route handler wants to surface as an SSE frame. Structured. */
export type OrchestratorFrame =
  | { type: "text"; value: string }
  | {
      type: "tool";
      value: {
        name: string;
        agent_id: string;
        latency_ms: number;
        ok: boolean;
        error_code?: string;
      };
    }
  | { type: "selection"; value: InteractiveSelection }
  | { type: "summary"; value: ConfirmationSummary }
  | {
      type: "leg_status";
      value: {
        order: number;
        status:
          | "pending"
          | "in_flight"
          | "committed"
          | "failed"
          | "rolled_back"
          | "rollback_failed";
      };
    }
  | { type: "error"; value: { message: string } }
  | {
      /**
       * Observability-only frame. Not user-facing — the shell ignores
       * these. Lands in the events table via the route handler so
       * replay can see the orchestrator's internal decisions (retry
       * attempts, price-integrity violations, saga plan emission, etc).
       */
      type: "internal";
      value: { kind: string; detail: Record<string, unknown> };
    };

export type EmitFrame = (frame: OrchestratorFrame) => void;

const MAX_TOOL_LOOP = 6;
// Sonnet 4.6 is the orchestrator brain. Originally ran on Opus 4.6 for
// compound-booking decomposition (one user intent → N specialist legs
// with DAG dependencies → single-confirm + Saga rollback), but Sonnet
// 4.6 hits parity on the current tool-routing + selection/confirmation
// workloads at meaningfully lower latency and per-turn cost, which
// matters for a chat-first product where time-to-first-token is the
// north-star UX metric. If compound-orchestration (#29) starts to regress
// on rollback or multi-leg sequencing during eval runs, revisit Opus for
// the orchestrator turn specifically. Specialist agents that run their
// own LLM (e.g. Food Agent's /api/chat) continue to pick Sonnet or Haiku
// for their own in-house flows.
const MODEL = "claude-sonnet-4-6";

// ──────────────────────────────────────────────────────────────────────────
// runTurn — one Claude turn, optionally emitting live SSE frames
// ──────────────────────────────────────────────────────────────────────────

export async function runTurn(
  input: OrchestratorInput,
  emit: EmitFrame = () => {},
): Promise<OrchestratorTurn> {
  const registry = await ensureRegistry();
  // Appstore (v0.4): filter the Claude tool bridge to agents the current
  // user has actually connected, plus public "connect.model === none"
  // agents. Prevents Claude from trying to use an app the user hasn't
  // linked yet — the user would just see "connect Food first" turns and
  // nothing else, which is a worse UX than the tools simply not being
  // offered.
  const connections =
    input.user_id && input.user_id !== "anon"
      ? await listConnectionsForUser(input.user_id)
      : [];
  const installs =
    input.user_id && input.user_id !== "anon"
      ? await listInstalledAgentsForUser(input.user_id)
      : [];
  const connectedAgentIds = new Set(
    connections.filter((c) => c.status === "active").map((c) => c.agent_id),
  );
  const installedAgentIds = new Set(
    installs.filter((i) => i.status === "installed").map((i) => i.agent_id),
  );
  const bridge = userScopedBridge(
    registry,
    connectedAgentIds,
    installedAgentIds,
    0.6,
    input.user_id === "anon",
  );

  // ── JARVIS memory + ambient (J1/J4) ─────────────────────────────────
  // Retrieve the user's profile, top-relevant facts, and high-confidence
  // behavior patterns. All three are best-effort: missing Supabase or
  // missing OpenAI keys degrade recall but don't fail the turn.
  const lastUserForRetrieval =
    input.messages.findLast((m) => m.role === "user")?.content ?? "";
  const [profileForPrompt, factsForPrompt, patternsForPrompt] =
    input.user_id && input.user_id !== "anon"
      ? await Promise.all([
          getProfile(input.user_id),
          retrieveRelevantFacts(input.user_id, lastUserForRetrieval, 8),
          listHighConfidencePatterns(input.user_id, 0.7, 10),
        ])
      : [null, [] as UserFact[], []];

  const system = buildSystemPrompt({
    agents: Object.values(registry.agents),
    now: new Date(),
    user_first_name: input.user_first_name ?? null,
    user_region: input.user_region,
    mode: input.mode === "voice" ? "voice" : "text",
    memory: {
      profile: profileForPrompt,
      facts: factsForPrompt,
      patterns: patternsForPrompt,
    },
    ambient: input.ambient,
  });

  // MCP bridge — third-party tools exposed via Model Context Protocol.
  // Each user's connected MCP servers contribute additional tools with
  // mcp__<server>__<tool> naming. Failures here are swallowed inside
  // userMcpBridge (one flaky server can't break the whole turn) so we
  // can merge the result unconditionally.
  let mcpBridge: McpBridgeResult = { tools: [], routing: {} };
  try {
    mcpBridge = await userMcpBridge(input.user_id);
  } catch (err) {
    console.warn("[orchestrator] MCP bridge failed:", err);
  }

  // Merge meta-tools (memory_save, memory_forget, profile_update) onto
  // the registry bridge so Claude sees them alongside agent tools. MCP
  // tools tack on after — they share the same tool_use protocol and
  // dispatch is intercepted below based on name prefix.
  const toolsForClaude = [
    ...bridge.tools,
    ...META_TOOLS,
    // MCP tool schemas arrive as opaque JSON Schema from third-party
    // servers. Anthropic.Tool expects a more specific type-literal
    // for `input_schema.type`, but the runtime shape is identical —
    // so a cast is safer than trying to narrow every sub-field of
    // an untrusted schema. Sanitization already happened in
    // sanitizeTool(); this is purely a TS appeasement.
    ...(mcpBridge.tools.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.input_schema,
    })) as unknown as typeof META_TOOLS),
  ];

  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  const priorSummary = findPriorSummary(input.messages);
  const lastUser = input.messages.findLast((m) => m.role === "user")?.content ?? "";
  const userConfirmed = isAffirmative(lastUser);

  // Convert our ChatMessage[] → Anthropic messages. Summaries are inlined as
  // JSON blocks so Claude can reference them when computing summary_hash.
  const messages = input.messages.map((m) => ({
    role: m.role,
    content: m.summary
      ? `${m.content}\n\n<summary hash="${m.summary.hash}">${JSON.stringify(m.summary.payload)}</summary>`
      : m.content,
  }));

  const toolCalls: OrchestratorTurn["tool_calls"] = [];
  const selections: InteractiveSelection[] = [];

  // Candidates for compound trip assembly. Every successful tool call whose
  // result carried a v0.1 `_lumo_summary` envelope is a potential leg. We
  // decide post-loop whether there are enough (≥2) to fold into a trip.
  interface TripLegCandidate {
    agent_id: string;
    pricing_tool_name: string;
    summary: AttachedSummary;
    /** The stripped-of-envelope pricing result body, used to extract total_amount/currency. */
    result_body: Record<string, unknown>;
  }
  const tripLegCandidates: TripLegCandidate[] = [];

  let assistantText = "";
  let renderedSummary: ConfirmationSummary | null = null;
  const loopAssistantMessages: Anthropic.MessageParam[] = [];

  for (let i = 0; i < MAX_TOOL_LOOP; i++) {
    const response = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 1024,
      system,
      tools: toolsForClaude,
      messages: [...messages, ...loopAssistantMessages],
    });

    // Collect any text Claude emitted this pass — and stream it live.
    let passText = "";
    for (const block of response.content) {
      if (block.type === "text") passText += block.text;
    }
    if (passText) {
      assistantText += passText;
      emit({ type: "text", value: passText });
    }

    // If Claude embedded a structured summary tag, capture it (legacy path).
    const parsed = extractSummary(assistantText);
    if (parsed) renderedSummary = parsed;

    // Find tool_use blocks, if any.
    const toolUses = response.content.filter(
      (b): b is Anthropic.ToolUseBlock => b.type === "tool_use",
    );
    if (toolUses.length === 0) break;

    // Append the assistant turn & dispatch each tool_use.
    loopAssistantMessages.push({ role: "assistant", content: response.content });
    // `content` is a union of block-param types in the Anthropic SDK;
    // that union isn't re-exported under a single name in v0.27.3, so
    // we build it as any[] and let MessageParam's own validator accept
    // it. Runtime shape is guarded structurally when we push().
    const toolResults: Anthropic.MessageParam = { role: "user", content: [] as any[] };

    for (const tu of toolUses) {
      const turn_id = `${input.session_id}:${Date.now()}`;

      // ── Meta-tool interception ────────────────────────────────────
      // memory_save / memory_forget / profile_update never leave the
      // Super Agent process. We handle them inline and synthesize a
      // DispatchOutcome so the rest of the loop (tool_result, toolCalls
      // trace, SSE frame) is unchanged vs. a real dispatch.
      if (isMetaToolName(tu.name)) {
        const outcome = await handleMetaTool(
          tu.name,
          (tu.input as Record<string, unknown>) ?? {},
          input.user_id,
        );
        const traceFrameMeta = {
          name: tu.name,
          agent_id: "lumo-super-agent",
          latency_ms: outcome.latency_ms,
          ok: outcome.ok,
          error_code: outcome.ok ? undefined : outcome.error_code,
        };
        toolCalls.push(traceFrameMeta);
        emit({ type: "tool", value: traceFrameMeta });
        (toolResults.content as any[]).push({
          type: "tool_result",
          tool_use_id: tu.id,
          content: JSON.stringify(outcome.result ?? { ok: outcome.ok }),
          is_error: !outcome.ok,
        });
        continue;
      }

      const ctx: DispatchContext = {
        user_id: input.user_id,
        session_id: input.session_id,
        turn_id,
        idempotency_key: `${input.session_id}:${tu.id}`,
        region: input.user_region,
        device_kind: input.device_kind,
        prior_summary: renderedSummary ?? priorSummary,
        user_confirmed: userConfirmed,
        user_pii: input.user_pii,
      };
      // MCP branch. Tool names starting with `mcp__` live in the
      // MCP namespace — route to the MCP dispatcher instead of the
      // native agent router. Shape of `outcome` is normalized so the
      // rest of the loop (trace frame, tool_result construction)
      // doesn't care which world the call came from.
      let outcome: Awaited<ReturnType<typeof dispatchToolCall>>;
      if (isMcpToolName(tu.name)) {
        const mcpStarted = Date.now();
        const mcpRouting = mcpBridge.routing[tu.name] ?? null;
        const mcp = await dispatchMcpTool(
          tu.name,
          mcpRouting,
          (tu.input as Record<string, unknown>) ?? {},
          { user_id: input.user_id },
        );
        // Map MCP dispatch shape onto DispatchOutcome so the rest of
        // the loop treats it identically. Known MCP error codes are
        // aligned with AgentErrorCode strings; anything unexpected
        // degrades to "upstream_error" so we never emit an invalid code.
        const allowedCodes = new Set([
          "upstream_error",
          "connection_required",
          "connection_refresh_failed",
          "not_available",
          "upstream_timeout",
          "rate_limited",
          "internal_error",
        ] as const);
        type OkCode = typeof allowedCodes extends Set<infer U> ? U : never;
        const incomingCode = mcp.error?.code ?? "upstream_error";
        const errorCode: OkCode = (allowedCodes as Set<string>).has(incomingCode)
          ? (incomingCode as OkCode)
          : "upstream_error";
        outcome = mcp.ok
          ? {
              ok: true,
              result: { content: mcp.content },
              latency_ms: Date.now() - mcpStarted,
            }
          : {
              ok: false,
              error: {
                code: errorCode,
                message: mcp.error?.message ?? "MCP tool failed",
                at: new Date().toISOString(),
              },
              latency_ms: Date.now() - mcpStarted,
            };
      } else {
        outcome = await dispatchToolCall(
          tu.name,
          (tu.input as Record<string, unknown>) ?? {},
          ctx,
        );
      }

      const routing = registry.bridge.routing[tu.name];
      const mcpAgentId = isMcpToolName(tu.name)
        ? `mcp:${mcpBridge.routing[tu.name]?.server_id ?? "unknown"}`
        : null;
      const traceFrame = {
        name: tu.name,
        agent_id: mcpAgentId ?? routing?.agent_id ?? "unknown",
        latency_ms: outcome.latency_ms,
        ok: outcome.ok,
        error_code: outcome.ok ? undefined : outcome.error.code,
      };
      toolCalls.push(traceFrame);
      emit({ type: "tool", value: traceFrame });

      // If this tool result carries an agent-authoritative confirmation
      // envelope, adopt it as the turn's summary. This is the primary
      // path — hash parity is structural (both sides call hashSummary on
      // the same canonical payload). The XML-extraction path below is a
      // legacy fallback.
      let resultForModel: unknown = outcome.ok ? outcome.result : outcome.error;
      if (outcome.ok) {
        const env = extractAttachedSummary(outcome.result);
        if (env) {
          renderedSummary = {
            kind: env.kind,
            payload: env.payload,
            hash: env.hash,
            session_id: input.session_id,
            turn_id,
            rendered_at: new Date().toISOString(),
          };
          // Stash as a trip-leg candidate — we may fold ≥2 of these into
          // a compound TripSummary after the loop exits. The `result_body`
          // is stripped of the envelope so we can safely spread it into a
          // bookable tool's args on the confirm turn.
          const stripped =
            typeof outcome.result === "object" && outcome.result !== null
              ? stripAttachedSummary(outcome.result as Record<string, unknown>)
              : {};
          tripLegCandidates.push({
            agent_id: routing?.agent_id ?? "unknown",
            pricing_tool_name: tu.name,
            summary: env,
            result_body: stripped as Record<string, unknown>,
          });
          // Don't send the envelope to Claude — it's shell-internal
          // metadata, not domain data the model should reason over.
          resultForModel = stripped;
        }
      }

      (toolResults.content as any[]).push({
        type: "tool_result",
        tool_use_id: tu.id,
        content: JSON.stringify(resultForModel),
        is_error: !outcome.ok,
      });

      // ─── Interactive-selection surfacing ───────────────────────────
      // A small set of "discovery" tools produce results that the user
      // should be able to pick from in rich UI (food menu items → cart
      // lines, flight offers → pricing gate). We don't gate anything
      // here — the model is free to keep reasoning — but we capture
      // the payload so the SSE layer can emit a `selection` frame and
      // the shell can render the right card inline in the message.
      //
      // De-duped per kind: last writer wins if the model somehow calls
      // the same discovery tool twice in one turn.
      if (outcome.ok && isInteractiveDiscoveryTool(tu.name)) {
        const kind = selectionKindForTool(tu.name);
        if (kind) {
          const idx = selections.findIndex((s) => s.kind === kind);
          const entry: InteractiveSelection = {
            kind,
            payload: outcome.result,
          };
          if (idx >= 0) selections[idx] = entry;
          else selections.push(entry);
          emit({ type: "selection", value: entry });
        }
      }
    }

    loopAssistantMessages.push(toolResults);
  }

  // ─── Compound trip assembly (post-loop) ──────────────────────────────
  // If Claude priced ≥2 specialist legs in this turn, upgrade the single-
  // leg summary (if any) to a compound `structured-trip` summary. The
  // user sees one confirmation card; the next turn's dispatch flow
  // (dispatchConfirmedTrip, below) walks the legs in DAG order.
  let draft_trip_id: string | undefined;
  if (tripLegCandidates.length >= 2) {
    const legs = resolveTripLegs(tripLegCandidates, registry.bridge.routing);
    if (legs.length >= 2) {
      try {
        const trip_title = inferTripTitle(input.messages);
        const payload = assembleTripSummary({ trip_title, legs });
        const record = await createDraftTrip(
          input.session_id,
          input.user_id,
          payload,
        );
        const turn_id = `${input.session_id}:${Date.now()}`;
        const tripSummary: ConfirmationSummary = {
          kind: "structured-trip",
          payload: payload as unknown,
          hash: record.hash,
          session_id: input.session_id,
          turn_id,
          rendered_at: new Date().toISOString(),
        };
        renderedSummary = tripSummary;
        draft_trip_id = record.trip_id;
        emit({ type: "summary", value: tripSummary });
      } catch (err) {
        if (err instanceof TripAssemblyError) {
          console.warn(
            `[orchestrator] trip assembly failed (${err.code}): ${err.message}`,
          );
          // Fall through — leave renderedSummary as the last single-leg
          // summary (if any) so the user still gets something actionable.
        } else {
          throw err;
        }
      }
    }
  }

  // If we didn't compose a compound trip but we DID capture a single-
  // leg summary from a tool result, emit it now. (For compound trips the
  // emit happens above; the route handler only emits this frame once.)
  if (!draft_trip_id && renderedSummary) {
    emit({ type: "summary", value: renderedSummary });
  }

  return {
    assistant_text: assistantText.trim(),
    tool_calls: toolCalls,
    summary: renderedSummary,
    selections,
    draft_trip_id,
  };
}

// ──────────────────────────────────────────────────────────────────────────
// dispatchConfirmedTrip — user affirmed; walk legs in DAG order
// ──────────────────────────────────────────────────────────────────────────

export interface DispatchTripInput {
  trip_id: string;
  session_id: string;
  user_id: string;
  user_region: string;
  device_kind: "web" | "ios" | "android" | "watch";
  user_pii: Record<string, unknown>;
}

/**
 * Called by `/api/chat` when the user affirms a draft compound trip.
 * Walks every leg of the trip in forward-topological order (dependencies
 * first), dispatching the bookable tool for each. Emits `leg_status`
 * frames live so the TripConfirmationCard can animate progress.
 *
 * On any leg failure the forward pass stops, we snapshot the trip, and
 * hand the snapshot to `planRollback` from `lib/saga`. Each rollback
 * step is then dispatched, again with live `leg_status` frames (the card
 * uses the same state field for both forward and backward status —
 * `rolled_back` / `rollback_failed` are distinct statuses so the UI can
 * colour them differently).
 *
 * This function has side-effects (state-store mutations, HTTP calls) but
 * doesn't log; leave that to the route handler, which sees every frame.
 */
export async function dispatchConfirmedTrip(
  input: DispatchTripInput,
  emit: EmitFrame,
): Promise<void> {
  const registry = await ensureRegistry();

  // Mark the trip as dispatching. confirmTrip was already called by the
  // route handler (it needs the hash equality check wired into the gate).
  let trip = await beginDispatch(input.trip_id);

  // Seed UI with every leg in `pending` so the card lights up immediately.
  for (const leg of trip.legs) {
    emit({ type: "leg_status", value: { order: leg.order, status: "pending" } });
  }

  // Depth-batched parallel dispatch (task #75).
  //
  // Previously this was a single sequential loop over every leg in
  // ascending (depth, order). That's correct but slow for independent
  // legs — a flight + hotel + restaurant trip with depends_on=[] on
  // all three waited on three serial round-trips to three specialist
  // agents. For v2 we group legs by topological depth and dispatch
  // all legs at the same depth concurrently via Promise.all. Between
  // depths we still serialize — the next depth's legs may depend on
  // this depth's bookings.
  //
  // Any failure at a given depth flips forwardFailed and we break
  // out of the outer loop without advancing. Saga rollback then
  // compensates whatever committed at earlier depths or concurrently
  // succeeded at this depth — the per-leg status is authoritative.
  const depthMap = computeLegDepths(trip.legs);
  const depths = Array.from(new Set(depthMap.values())).sort((a, b) => a - b);

  let forwardFailed = false;
  for (const depth of depths) {
    if (forwardFailed) break;

    // Cooperative cancellation check. Done once per depth (not per
    // leg) so a cancel fires while the prior depth's legs are in
    // flight still gets observed before we open the next fan-out.
    if (await isCancelRequested(input.trip_id)) {
      emit({
        type: "internal",
        value: { kind: "user_cancel_observed", detail: { at_depth: depth } },
      });
      emit({
        type: "text",
        value: "Cancellation requested. Stopping dispatch and rolling back committed legs.",
      });
      forwardFailed = true;
      break;
    }

    const legsAtDepth = trip.legs
      .filter((l) => (depthMap.get(l.order) ?? 0) === depth)
      .sort((a, b) => a.order - b.order);

    const results = await Promise.all(
      legsAtDepth.map((leg) =>
        dispatchOneLegForward({
          leg,
          trip,
          input,
          emit,
        }),
      ),
    );

    // Reconcile concurrent updateLeg calls by re-snapshotting once
    // per depth before moving on — the next depth's dep-check needs
    // the merged view.
    trip = await snapshotTripRecord(trip, input.trip_id);

    if (results.some((r) => !r.ok)) {
      forwardFailed = true;
      break;
    }
  }

  if (!forwardFailed) {
    await finalizeTrip(input.trip_id, "committed");
    emit({
      type: "text",
      value: "Trip booked. You'll see a confirmation for each leg in your inbox.",
    });
    return;
  }

  // ─── Saga rollback ────────────────────────────────────────────────
  const state = await snapshot(input.trip_id);
  const plan = planRollback(state, { routing: registry.bridge.routing });

  emit({
    type: "text",
    value:
      plan.steps.length > 0
        ? "One leg failed — rolling back the parts I already committed."
        : "One leg failed. The committed parts cannot be auto-cancelled; I'll flag this to support.",
  });

  let anyRollbackFailed = plan.manual_escalations.length > 0;

  // Any manual_escalation the saga plan surfaced (e.g., leg had no
  // booking_id, agent has no compensation tool) gets filed to the
  // escalations queue right now — before we touch any compensation
  // tool. Ops needs these visible even if the rest of rollback
  // succeeds.
  for (const esc of plan.manual_escalations) {
    void openEscalation({
      trip_id: input.trip_id,
      session_id: input.session_id,
      user_id: input.user_id,
      leg_order: esc.order,
      reason: "manual_only",
      detail: { saga_reason: esc.reason, source: "dispatch_forward_failed" },
    });
  }

  for (const step of plan.steps) {
    emit({
      type: "leg_status",
      value: { order: step.order, status: "in_flight" },
    });

    const turn_id = `${input.session_id}:${Date.now()}`;
    // Rollback compensation is retryable by construction — cancel
    // tools are idempotent and the idempotency key is stable. A 502
    // from the vendor during refund shouldn't strand a leg in
    // rollback_failed and dump it into the escalation queue.
    const outcome = await dispatchWithRetry(
      step.tool_name,
      step.body as unknown as Record<string, unknown>,
      {
        user_id: input.user_id,
        session_id: input.session_id,
        turn_id,
        idempotency_key: `${input.session_id}:trip_${input.trip_id}:rollback_leg_${step.order}`,
        region: input.user_region,
        device_kind: input.device_kind,
        prior_summary: null,
        // Cancel tools are idempotent and do not go through the
        // money-gate (cost_tier !== "money"), so user_confirmed is not
        // meaningful — we pass true defensively.
        user_confirmed: true,
        user_pii: input.user_pii,
      },
      {},
      (info) =>
        emit({
          type: "internal",
          value: {
            kind: "retry_rollback_leg",
            detail: {
              tool_name: step.tool_name,
              leg_order: step.order,
              attempt: info.attempt,
              next_delay_ms: info.next_delay_ms,
              error_code: info.error_code,
              error_message: info.error_message,
            },
          },
        }),
    );

    if (outcome.ok) {
      await updateLeg(input.trip_id, step.order, { status: "rolled_back" });
      emit({
        type: "leg_status",
        value: { order: step.order, status: "rolled_back" },
      });
    } else {
      await updateLeg(input.trip_id, step.order, {
        status: "rollback_failed",
        error_detail: {
          code: outcome.error.code,
          message: outcome.error.message,
        },
      });
      emit({
        type: "leg_status",
        value: { order: step.order, status: "rollback_failed" },
      });
      anyRollbackFailed = true;

      // Queue for human follow-up. The user has been charged and the
      // automatic refund path just failed — this is the exact case
      // that must not sit silently in the DB.
      void openEscalation({
        trip_id: input.trip_id,
        session_id: input.session_id,
        user_id: input.user_id,
        leg_order: step.order,
        reason: "rollback_failed",
        detail: {
          tool_name: step.tool_name,
          error_code: outcome.error.code,
          error_message: outcome.error.message,
          source: "dispatch_saga",
        },
      });
    }
  }

  await finalizeTrip(
    input.trip_id,
    anyRollbackFailed ? "rollback_failed" : "rolled_back",
  );
}

// ──────────────────────────────────────────────────────────────────────────
// Trip-leg resolution
// ──────────────────────────────────────────────────────────────────────────

/**
 * Turn raw TripLegCandidates (one per AttachedSummary captured during
 * the tool-use loop) into validated `PricedLeg`s ready for
 * `assembleTripSummary`. Drops any candidate that:
 *   - has no resolvable bookable counterpart (pricing tool without a
 *     matching money tool on the same agent), or
 *   - lacks an extractable decimal amount + ISO currency.
 *
 * Order is assigned densely (1..N) in the order Claude called the
 * pricing tools. For v1 every leg's `depends_on` is `[]` — legs commit
 * independently. Saga rollback still works because it orders by `order`
 * descending as the tiebreaker when depths are equal (see `lib/saga.ts`
 * :: computeDepths). A future task can widen this to chain / fork DAGs
 * inferred from the user utterance.
 */
function resolveTripLegs(
  candidates: Array<{
    agent_id: string;
    pricing_tool_name: string;
    summary: AttachedSummary;
    result_body: Record<string, unknown>;
  }>,
  routing: Record<string, import("@lumo/agent-sdk").ToolRoutingEntry>,
): PricedLeg[] {
  const legs: PricedLeg[] = [];
  let nextOrder = 1;
  for (const c of candidates) {
    const bookable = resolveBookableTool(c.agent_id, c.summary.kind, routing);
    if (!bookable) continue;
    const amounts = extractLegAmount(c.result_body, c.summary.payload);
    if (!amounts) continue;
    legs.push({
      agent_id: c.agent_id,
      tool_name: bookable,
      order: nextOrder++,
      depends_on: [],
      summary: c.summary,
      leg_amount: amounts.amount,
      currency: amounts.currency,
    });
  }
  return legs;
}

/**
 * Given a pricing tool's agent + the confirmation `kind` it emits, find
 * the bookable (money-tier) tool on the same agent that requires that
 * kind. This is the pairing the SDK already enforces — we just look it
 * up reflectively rather than hardcoding `flight_price_offer →
 * flight_book_offer` etc.
 *
 * Returns the bookable tool name, or `null` if none found.
 */
function resolveBookableTool(
  agent_id: string,
  kind: ConfirmationKind,
  routing: Record<string, import("@lumo/agent-sdk").ToolRoutingEntry>,
): string | null {
  for (const [toolName, entry] of Object.entries(routing)) {
    if (entry.agent_id !== agent_id) continue;
    if (entry.cost_tier !== "money") continue;
    if (entry.requires_confirmation !== kind) continue;
    return toolName;
  }
  return null;
}

/**
 * Extract a decimal amount + ISO currency for a leg. Tries the stripped
 * pricing body first (where agents typically surface `total_amount` as
 * a top-level field), falling back to the AttachedSummary's payload.
 *
 * Currency is ISO 4217 (3 letters, uppercase).
 */
function extractLegAmount(
  body: Record<string, unknown>,
  payload: unknown,
): { amount: string; currency: string } | null {
  const sources: Array<Record<string, unknown> | null> = [
    body,
    isRecord(payload) ? payload : null,
  ];
  for (const src of sources) {
    if (!src) continue;
    const amount = firstDecimalString(src, [
      "total_amount",
      "subtotal",
      "total",
      "price",
      "amount",
    ]);
    const currency = firstCurrency(src);
    if (amount && currency) return { amount, currency };
  }
  return null;
}

function firstDecimalString(src: Record<string, unknown>, keys: string[]): string | null {
  for (const k of keys) {
    const v = src[k];
    if (typeof v === "string" && /^\d+(\.\d+)?$/.test(v)) return v;
    if (typeof v === "number" && Number.isFinite(v) && v >= 0) {
      // Reject floats with more than 4 decimal places — those almost
      // certainly came from IEEE-754 drift and shouldn't be trusted as
      // money. Agents that emit numeric amounts should string-format.
      const s = String(v);
      if (/^\d+(\.\d{1,4})?$/.test(s)) return s;
    }
  }
  return null;
}

function firstCurrency(src: Record<string, unknown>): string | null {
  const c = src["currency"];
  if (typeof c === "string" && /^[A-Z]{3}$/.test(c)) return c;
  return null;
}

/**
 * Price-integrity gate.
 *
 * The user confirmed a specific leg total (carried inside the leg's
 * AttachedSummary payload and hash-protected via the compound trip
 * hash the gate already enforces). After the booking tool returns,
 * we compare the charged total on the response body against the
 * confirmed ceiling. Any overrun — even 1 cent — is a violation.
 *
 * Why compare to the AttachedSummary payload and not to the trip's
 * total_amount: totals can be composed in currencies we don't want to
 * normalize here, and the SDK already guarantees trip.total_amount
 * equals the sum of leg amounts at assembly time. Per-leg is the
 * right granularity for rollback.
 *
 * Returns null if everything's fine OR if we can't compare (either
 * side missing a parseable amount). Returns a violation detail if
 * charged > confirmed, or if the currencies disagree.
 */
function checkLegPriceIntegrity(
  legRef: { summary: { payload: unknown } },
  chargedBody: unknown,
): {
  message: string;
  confirmed_amount: string;
  confirmed_currency: string;
  charged_amount: string;
  charged_currency: string;
} | null {
  const confirmed = extractLegAmount({}, legRef.summary.payload);
  if (!confirmed) return null; // summary shape we don't know how to read — skip

  const chargedSources: Array<Record<string, unknown>> = [];
  if (isRecord(chargedBody)) chargedSources.push(chargedBody);
  const charged = chargedSources.reduce<
    { amount: string; currency: string } | null
  >(
    (acc, src) => acc ?? extractLegAmount(src, null),
    null,
  );
  if (!charged) return null; // vendor didn't return a total — skip

  if (charged.currency !== confirmed.currency) {
    return {
      message: `Currency drift: confirmed ${confirmed.currency}, charged ${charged.currency}`,
      confirmed_amount: confirmed.amount,
      confirmed_currency: confirmed.currency,
      charged_amount: charged.amount,
      charged_currency: charged.currency,
    };
  }

  // Compare as scaled integers. Four-decimal max on both sides is
  // enforced by firstDecimalString's regex.
  const confirmedCents = toCents(confirmed.amount);
  const chargedCents = toCents(charged.amount);
  if (confirmedCents === null || chargedCents === null) return null;

  if (chargedCents > confirmedCents) {
    return {
      message: `Charged ${charged.amount} > confirmed ceiling ${confirmed.amount} ${confirmed.currency}`,
      confirmed_amount: confirmed.amount,
      confirmed_currency: confirmed.currency,
      charged_amount: charged.amount,
      charged_currency: charged.currency,
    };
  }
  return null;
}

/**
 * Parse a decimal money string (e.g. "12.34", "7") as scaled-int cents
 * with 4 decimals of precision. Returns null if the string doesn't
 * match. Does not clamp — callers already reject amounts with > 4
 * fractional digits via firstDecimalString.
 */
function toCents(s: string): number | null {
  const m = /^(\d+)(?:\.(\d{1,4}))?$/.exec(s);
  if (!m) return null;
  const whole = Number(m[1]);
  const fracRaw = m[2] ?? "";
  const fracPadded = (fracRaw + "0000").slice(0, 4);
  const frac = Number(fracPadded);
  if (!Number.isFinite(whole) || !Number.isFinite(frac)) return null;
  return whole * 10000 + frac;
}

/**
 * Best-effort booking_id extraction from a bookable-tool result body.
 * Tried in order: `booking_id`, `order_id`, `reservation_id`, `id`.
 * Returns undefined if none present — saga.ts escalates that leg to
 * manual rather than auto-compensating.
 */
function extractBookingId(result: unknown): string | undefined {
  if (!isRecord(result)) return undefined;
  for (const k of ["booking_id", "order_id", "reservation_id", "id"]) {
    const v = result[k];
    if (typeof v === "string" && v.length > 0) return v;
  }
  return undefined;
}

/**
 * Synthesize a trip title from the user's last intent-carrying message.
 * Intentionally dumb for v1 — we just take up to 60 chars of the latest
 * user message with trailing punctuation stripped. A future task can
 * route this through a cheap LLM call for prettier titles.
 */
function inferTripTitle(messages: ChatMessage[]): string {
  const lastUser = messages.findLast((m) => m.role === "user")?.content?.trim() ?? "";
  if (!lastUser) return "Your trip";
  const firstLine = lastUser.split("\n")[0] ?? "";
  const trimmed = firstLine.replace(/[.!?]+$/, "").trim();
  if (!trimmed) return "Your trip";
  return trimmed.length > 60 ? trimmed.slice(0, 57).trim() + "…" : trimmed;
}

/**
 * Dispatch one forward leg. Extracted from dispatchConfirmedTrip so
 * that Promise.all can fan out legs at the same topological depth
 * concurrently (task #75).
 *
 * Mutates the leg row via updateLeg (DB-backed + in-memory cache). The
 * caller re-snapshots the trip after Promise.all to reconcile — we
 * don't return the updated trip here because concurrent fan-out would
 * make that racy.
 *
 * Returns { ok: true } on success (committed + no price violation),
 * { ok: false, reason } otherwise. The caller only needs the boolean
 * — detailed per-leg status is already persisted + emitted as
 * leg_status frames.
 */
async function dispatchOneLegForward(args: {
  leg: { order: number; depends_on: number[]; agent_id: string; tool_name: string };
  trip: TripRecord;
  input: DispatchTripInput;
  emit: EmitFrame;
}): Promise<{ ok: true } | { ok: false; reason: string }> {
  const { leg, trip, input, emit } = args;

  // Dependency check — every depends_on must be committed. A sibling
  // in the same depth-batch can't be a dependency (depths guarantee
  // this), so at this point all deps are at earlier depths and their
  // Promise.all already settled. We re-check against the current
  // trip legs map rather than trusting a stale snapshot.
  const depsOk = leg.depends_on.every(
    (d) => trip.legs.find((x) => x.order === d)?.status === "committed",
  );
  if (!depsOk) {
    await updateLeg(input.trip_id, leg.order, {
      status: "failed",
      error_detail: { reason: "dependency_failed" },
    });
    emit({ type: "leg_status", value: { order: leg.order, status: "failed" } });
    return { ok: false, reason: "dependency_failed" };
  }

  await updateLeg(input.trip_id, leg.order, { status: "in_flight" });
  emit({ type: "leg_status", value: { order: leg.order, status: "in_flight" } });

  const legRef = trip.payload.legs.find((l) => l.order === leg.order);
  if (!legRef) {
    // Unreachable — snapshot matches payload. Treat as failure to
    // avoid silent pending leg.
    await updateLeg(input.trip_id, leg.order, {
      status: "failed",
      error_detail: { reason: "legref_missing" },
    });
    emit({ type: "leg_status", value: { order: leg.order, status: "failed" } });
    return { ok: false, reason: "legref_missing" };
  }

  const legSummaryPayload = legRef.summary.payload as Record<string, unknown>;
  const callArgs: Record<string, unknown> = {
    ...legSummaryPayload,
    summary_hash: legRef.summary.hash,
    trip_hash: trip.hash,
    trip_leg_order: leg.order,
  };

  const turn_id = `${input.session_id}:${Date.now()}:${leg.order}`;
  const legPriorSummary: ConfirmationSummary = {
    kind: legRef.summary.kind,
    payload: legRef.summary.payload as unknown,
    hash: legRef.summary.hash,
    session_id: input.session_id,
    turn_id,
    rendered_at: new Date().toISOString(),
  };

  const outcome = await dispatchWithRetry(
    leg.tool_name,
    callArgs,
    {
      user_id: input.user_id,
      session_id: input.session_id,
      turn_id,
      idempotency_key: `${input.session_id}:trip_${input.trip_id}:leg_${leg.order}`,
      region: input.user_region,
      device_kind: input.device_kind,
      prior_summary: legPriorSummary,
      user_confirmed: true,
      user_pii: input.user_pii,
    },
    {},
    (info) =>
      emit({
        type: "internal",
        value: {
          kind: "retry_forward_leg",
          detail: {
            tool_name: leg.tool_name,
            leg_order: leg.order,
            attempt: info.attempt,
            next_delay_ms: info.next_delay_ms,
            error_code: info.error_code,
            error_message: info.error_message,
          },
        },
      }),
  );

  if (!outcome.ok) {
    await updateLeg(input.trip_id, leg.order, {
      status: "failed",
      error_detail: {
        code: outcome.error.code,
        message: outcome.error.message,
      },
    });
    emit({ type: "leg_status", value: { order: leg.order, status: "failed" } });
    return { ok: false, reason: outcome.error.code };
  }

  // Price-integrity gate.
  const violation = checkLegPriceIntegrity(legRef, outcome.result);
  const booking_id = extractBookingId(outcome.result);
  if (violation) {
    await updateLeg(input.trip_id, leg.order, {
      status: "committed",
      booking_id,
      error_detail: {
        code: "price_changed",
        message: violation.message,
        reason: "price_integrity_violation",
        confirmed_amount: violation.confirmed_amount,
        confirmed_currency: violation.confirmed_currency,
        charged_amount: violation.charged_amount,
        charged_currency: violation.charged_currency,
      },
    });
    emit({ type: "leg_status", value: { order: leg.order, status: "committed" } });
    emit({
      type: "text",
      value: `Price-integrity violation on leg ${leg.order} — vendor charged ${violation.charged_amount} ${violation.charged_currency}, you confirmed ${violation.confirmed_amount} ${violation.confirmed_currency}. Rolling back.`,
    });
    return { ok: false, reason: "price_integrity_violation" };
  }

  await updateLeg(input.trip_id, leg.order, {
    status: "committed",
    booking_id,
  });
  emit({ type: "leg_status", value: { order: leg.order, status: "committed" } });
  return { ok: true };
}

/**
 * Merge refresh: after Promise.all over a depth-batch, re-read the
 * trip so the next depth's dep-check sees every concurrent update.
 * Falls back to the stale record if the read fails — callers prefer
 * continuing-with-stale over aborting the whole trip on a transient
 * DB blip.
 */
async function snapshotTripRecord(
  fallback: TripRecord,
  trip_id: string,
): Promise<TripRecord> {
  const fresh = await getTripById(trip_id);
  return fresh ?? fallback;
}

/**
 * Legal depths for per-leg forward dispatch. Mirrors saga.ts' reverse-
 * topological depth computation but runs it ascending (dep-free legs
 * first). Guards cycles defensively even though assembleTripSummary /
 * attachTripSummary already reject them.
 */
function computeLegDepths(
  legs: Array<{ order: number; depends_on: number[] }>,
): Map<number, number> {
  const byOrder = new Map<number, { order: number; depends_on: number[] }>();
  for (const l of legs) byOrder.set(l.order, l);

  const depths = new Map<number, number>();
  function depth(order: number, seen: Set<number>): number {
    if (depths.has(order)) return depths.get(order)!;
    if (seen.has(order)) return 0;
    const leg = byOrder.get(order);
    if (!leg || leg.depends_on.length === 0) {
      depths.set(order, 0);
      return 0;
    }
    const next = new Set(seen);
    next.add(order);
    let d = 0;
    for (const dep of leg.depends_on) {
      d = Math.max(d, depth(dep, next) + 1);
    }
    depths.set(order, d);
    return d;
  }
  for (const l of legs) depth(l.order, new Set());
  return depths;
}

// ──────────────────────────────────────────────────────────────────────────
// Tool → selection-kind mapping
// ──────────────────────────────────────────────────────────────────────────

/**
 * Interactive-discovery tools are read-only tools whose results
 * benefit from rich selection UI. Keep this list tight — adding a
 * new kind requires a matching component in the shell.
 */
function isInteractiveDiscoveryTool(toolName: string): boolean {
  return (
    toolName === "food_get_restaurant_menu" ||
    toolName === "flight_search_offers" ||
    toolName === "restaurant_check_availability"
  );
}

function selectionKindForTool(
  toolName: string,
): InteractiveSelection["kind"] | null {
  if (toolName === "food_get_restaurant_menu") return "food_menu";
  if (toolName === "flight_search_offers") return "flight_offers";
  if (toolName === "restaurant_check_availability") return "time_slots";
  return null;
}

// ──────────────────────────────────────────────────────────────────────────
// Summary extraction
// ──────────────────────────────────────────────────────────────────────────

/**
 * Find the most recently rendered structured summary in the thread. Used as
 * the fallback when the current turn hasn't rendered one yet (e.g. the user
 * said "yes" without a new summary).
 */
function findPriorSummary(messages: ChatMessage[]): ConfirmationSummary | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (m.role === "assistant" && m.summary) return m.summary;
  }
  return null;
}

/**
 * Legacy fallback: pull a `<summary kind="…" session_id="…" turn_id="…">…</summary>`
 * block out of assistant text and hash the payload.
 *
 * This path is UNRELIABLE by design — it depends on the LLM emitting byte-
 * identical JSON across turns, which no current model guarantees. Prefer
 * the `_lumo_summary` envelope attached by the agent to its tool result
 * (see `extractAttachedSummary` usage in the dispatch loop above). This
 * function only fires when no envelope was produced, and should be
 * treated as a deprecation seam — remove once all agents emit envelopes.
 */
function extractSummary(text: string): ConfirmationSummary | null {
  const m = text.match(
    /<summary\s+kind="([^"]+)"\s+session_id="([^"]+)"\s+turn_id="([^"]+)">([\s\S]*?)<\/summary>/,
  );
  if (!m) return null;
  const [, kind, session_id, turn_id, payloadRaw] = m;
  try {
    const payload = JSON.parse(payloadRaw!.trim());
    return {
      kind: kind as ConfirmationSummary["kind"],
      payload,
      session_id: session_id!,
      turn_id: turn_id!,
      rendered_at: new Date().toISOString(),
      hash: hashSummary(payload),
    };
  } catch {
    return null;
  }
}

// ──────────────────────────────────────────────────────────────────────────
// Tiny utils
// ──────────────────────────────────────────────────────────────────────────

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

// ──────────────────────────────────────────────────────────────────────────
// Meta-tool handler (memory + profile)
// ──────────────────────────────────────────────────────────────────────────

interface MetaOutcome {
  ok: boolean;
  result?: unknown;
  error_code?: string;
  latency_ms: number;
}

/**
 * Execute a meta-tool and synthesize a DispatchOutcome-shaped result so
 * the orchestrator loop can treat it identically to a remote dispatch.
 *
 * Anon users (no authenticated session) are not persisted — we silently
 * succeed so Claude isn't confused by "I can't save that" errors in
 * dev. In prod every authed user has a real user_id.
 */
async function handleMetaTool(
  name: string,
  input: Record<string, unknown>,
  user_id: string,
): Promise<MetaOutcome> {
  const started = Date.now();

  if (!user_id || user_id === "anon") {
    return {
      ok: true,
      result: { note: "memory skipped — no authenticated user" },
      latency_ms: Date.now() - started,
    };
  }

  try {
    if (name === "memory_save") {
      const fact = typeof input.fact === "string" ? input.fact : "";
      const category =
        typeof input.category === "string"
          ? (input.category as FactCategory)
          : "other";
      const confidence =
        typeof input.confidence === "number" ? input.confidence : undefined;
      const supersedes_id =
        typeof input.supersedes_id === "string" ? input.supersedes_id : null;
      const saved = await saveFact({
        user_id,
        fact,
        category,
        confidence,
        supersedes_id,
      });
      return {
        ok: true,
        result: { id: saved.id, category: saved.category },
        latency_ms: Date.now() - started,
      };
    }

    if (name === "memory_forget") {
      const fact_id = typeof input.fact_id === "string" ? input.fact_id : "";
      if (!fact_id) {
        return {
          ok: false,
          result: { error: "fact_id required" },
          error_code: "invalid_input",
          latency_ms: Date.now() - started,
        };
      }
      await forgetFact(user_id, fact_id);
      return {
        ok: true,
        result: { id: fact_id, forgotten: true },
        latency_ms: Date.now() - started,
      };
    }

    if (name === "profile_update") {
      // Cast is safe because the schema constrains inputs; Zod at the
      // DB layer catches anything malformed.
      const patch = input as Parameters<typeof upsertProfile>[1];
      const updated = await upsertProfile(user_id, patch);
      return {
        ok: true,
        result: updated ? { id: updated.id, updated: true } : { ok: false },
        latency_ms: Date.now() - started,
      };
    }

    if (name === "intent_create") {
      const description = typeof input.description === "string" ? input.description : "";
      const schedule_cron = typeof input.schedule_cron === "string" ? input.schedule_cron : "";
      const timezone = typeof input.timezone === "string" ? input.timezone : undefined;
      const guardrails =
        input.guardrails && typeof input.guardrails === "object"
          ? (input.guardrails as Record<string, unknown>)
          : undefined;
      const action_plan =
        input.action_plan && typeof input.action_plan === "object"
          ? (input.action_plan as Record<string, unknown>)
          : undefined;
      try {
        const intent = await createIntent({
          user_id,
          description,
          schedule_cron,
          timezone,
          guardrails,
          action_plan,
        });
        return {
          ok: true,
          result: {
            id: intent.id,
            next_fire_at: intent.next_fire_at,
          },
          latency_ms: Date.now() - started,
        };
      } catch (err) {
        if (err instanceof IntentError) {
          return {
            ok: false,
            result: { error: err.code, detail: err.message },
            error_code: err.code === "invalid_cron" ? "invalid_input" : "internal_error",
            latency_ms: Date.now() - started,
          };
        }
        throw err;
      }
    }

    if (name === "intent_update") {
      const intent_id = typeof input.intent_id === "string" ? input.intent_id : "";
      if (!intent_id) {
        return {
          ok: false,
          result: { error: "intent_id required" },
          error_code: "invalid_input",
          latency_ms: Date.now() - started,
        };
      }
      const patch = { ...input } as Record<string, unknown>;
      delete patch.intent_id;
      try {
        const updated = await updateIntent({
          user_id,
          id: intent_id,
          patch: patch as Parameters<typeof updateIntent>[0]["patch"],
        });
        return {
          ok: !!updated,
          result: updated ? { id: updated.id, next_fire_at: updated.next_fire_at } : { error: "not_found" },
          latency_ms: Date.now() - started,
        };
      } catch (err) {
        if (err instanceof IntentError) {
          return {
            ok: false,
            result: { error: err.code, detail: err.message },
            error_code: err.code === "invalid_cron" ? "invalid_input" : "internal_error",
            latency_ms: Date.now() - started,
          };
        }
        throw err;
      }
    }

    if (name === "intent_delete") {
      const intent_id = typeof input.intent_id === "string" ? input.intent_id : "";
      if (!intent_id) {
        return {
          ok: false,
          result: { error: "intent_id required" },
          error_code: "invalid_input",
          latency_ms: Date.now() - started,
        };
      }
      await deleteIntent(user_id, intent_id);
      return {
        ok: true,
        result: { id: intent_id, deleted: true },
        latency_ms: Date.now() - started,
      };
    }

    return {
      ok: false,
      result: { error: `unknown meta tool: ${name}` },
      error_code: "not_available",
      latency_ms: Date.now() - started,
    };
  } catch (err) {
    console.error(`[orchestrator] meta tool ${name} failed:`, err);
    return {
      ok: false,
      result: { error: err instanceof Error ? err.message : String(err) },
      error_code: "internal_error",
      latency_ms: Date.now() - started,
    };
  }
}

// Re-exported so route handlers don't need to import the state store directly
// to check "does this session have a draft trip waiting for confirmation".
export { getTripBySession, confirmTrip, hashTripSummary };
export type { TripSummaryPayload };
