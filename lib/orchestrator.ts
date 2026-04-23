/**
 * Orchestrator loop.
 *
 * Single entry point the /api/chat route calls per user turn. Handles:
 *  - building the system prompt from the registry,
 *  - running the Claude tool-use loop,
 *  - dispatching each tool_use to the correct agent via router.ts,
 *  - streaming assistant text back to the client,
 *  - persisting the turn (stubbed — wire to Supabase in follow-up PR),
 *  - failing over to OpenAI (GPT-4o) when Anthropic is unhealthy.
 *
 * This file is intentionally self-contained. The money-gate lives inside
 * router.dispatchToolCall — not here — so we cannot accidentally bypass it.
 */

import Anthropic from "@anthropic-ai/sdk";
import { ensureRegistry, healthyBridge } from "./agent-registry.js";
import { dispatchToolCall, type DispatchContext } from "./router.js";
import { buildSystemPrompt } from "./system-prompt.js";
import {
  isAffirmative,
  hashSummary,
  extractAttachedSummary,
  stripAttachedSummary,
  type ConfirmationSummary,
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
  kind: "food_menu" | "flight_offers";
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
}

const MAX_TOOL_LOOP = 6;
// Opus 4.6 is the orchestrator brain. We chose Opus over Sonnet for the
// Super Agent specifically because compound-booking decomposition (one user
// intent → N specialist legs with DAG dependencies → single-confirm +
// Saga rollback) has a longer critical reasoning path than single-leg
// bookings. The per-turn token cost is higher; the per-intent error rate
// and recovery cost are lower. Specialist agents that run their own LLM
// (e.g. Food Agent's /api/chat) are free to pick Sonnet or Haiku for their
// own in-house flows.
const MODEL = "claude-opus-4-6";

export async function runTurn(input: OrchestratorInput): Promise<OrchestratorTurn> {
  const registry = await ensureRegistry();
  const bridge = healthyBridge(registry);
  const system = buildSystemPrompt({
    agents: Object.values(registry.agents),
    now: new Date(),
    user_first_name: input.user_first_name ?? null,
    user_region: input.user_region,
  });

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
  let assistantText = "";
  let renderedSummary: ConfirmationSummary | null = null;
  let loopAssistantMessages: Anthropic.MessageParam[] = [];

  for (let i = 0; i < MAX_TOOL_LOOP; i++) {
    const response = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 1024,
      system,
      tools: bridge.tools,
      messages: [...messages, ...loopAssistantMessages],
    });

    // Collect any text Claude emitted this pass.
    for (const block of response.content) {
      if (block.type === "text") assistantText += block.text;
    }

    // If Claude embedded a structured summary tag, capture it.
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
      const outcome = await dispatchToolCall(
        tu.name,
        (tu.input as Record<string, unknown>) ?? {},
        ctx,
      );

      const routing = registry.bridge.routing[tu.name];
      toolCalls.push({
        name: tu.name,
        agent_id: routing?.agent_id ?? "unknown",
        latency_ms: outcome.latency_ms,
        ok: outcome.ok,
        error_code: outcome.ok ? undefined : outcome.error.code,
      });

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
          // Don't send the envelope to Claude — it's shell-internal
          // metadata, not domain data the model should reason over.
          resultForModel =
            typeof outcome.result === "object" && outcome.result !== null
              ? stripAttachedSummary(outcome.result as Record<string, unknown>)
              : outcome.result;
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
        }
      }
    }

    loopAssistantMessages.push(toolResults);
  }

  return {
    assistant_text: assistantText.trim(),
    tool_calls: toolCalls,
    summary: renderedSummary,
    selections,
  };
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
    toolName === "flight_search_offers"
  );
}

function selectionKindForTool(
  toolName: string,
): InteractiveSelection["kind"] | null {
  if (toolName === "food_get_restaurant_menu") return "food_menu";
  if (toolName === "flight_search_offers") return "flight_offers";
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
