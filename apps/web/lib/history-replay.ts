import type { EventRow } from "./events.js";

export type ReplayEvent = EventRow & { ts: string; event_id: number };

export interface ReplayedChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  created_at: string;
  summary?: unknown | null;
  selections?: Array<{ kind: string; payload: unknown }>;
  suggestions?: unknown | null;
  compoundDispatch?: unknown | null;
  mission?: unknown | null;
}

interface AssistantDraft {
  id: string;
  created_at: string;
  content: string;
  summary: unknown | null;
  selections: Array<{ kind: string; payload: unknown }>;
  suggestions: unknown | null;
  compoundDispatch: unknown | null;
  mission: unknown | null;
  hasFrame: boolean;
}

export function sessionEventsBelongToUser(
  events: ReplayEvent[],
  user_id: string,
): boolean {
  return events.some((event) => {
    if (event.frame_type !== "request") return false;
    const value = asRecord(event.frame_value);
    return value?.["user_id"] === user_id;
  });
}

export function replayEventsToMessages(
  events: ReplayEvent[],
): ReplayedChatMessage[] {
  const messages: ReplayedChatMessage[] = [];
  let assistant: AssistantDraft | null = null;

  const flushAssistant = () => {
    if (!assistant?.hasFrame) {
      assistant = null;
      return;
    }
    messages.push({
      id: assistant.id,
      role: "assistant",
      content: assistant.content.trim(),
      created_at: assistant.created_at,
      summary: assistant.summary,
      selections: assistant.selections.length ? assistant.selections : undefined,
      suggestions: assistant.suggestions,
      compoundDispatch: assistant.compoundDispatch,
      mission: assistant.mission,
    });
    assistant = null;
  };

  const ensureAssistant = (event: ReplayEvent): AssistantDraft => {
    if (!assistant) {
      assistant = {
        id: `h-${event.event_id}-assistant`,
        created_at: event.ts,
        content: "",
        summary: null,
        selections: [],
        suggestions: null,
        compoundDispatch: null,
        mission: null,
        hasFrame: false,
      };
    }
    return assistant;
  };

  for (const event of events) {
    if (event.frame_type === "request") {
      flushAssistant();
      const userContent = requestMessage(event.frame_value);
      if (userContent) {
        messages.push({
          id: `h-${event.event_id}-user`,
          role: "user",
          content: userContent,
          created_at: event.ts,
        });
      }
      continue;
    }

    const frame = asRecord(event.frame_value);
    const value = frame && "value" in frame ? frame["value"] : event.frame_value;

    if (event.frame_type === "done") {
      flushAssistant();
      continue;
    }

    if (event.frame_type === "text") {
      const chunk = typeof value === "string" ? value : "";
      if (!chunk) continue;
      const draft = ensureAssistant(event);
      draft.content = appendChunk(draft.content, chunk);
      draft.hasFrame = true;
      continue;
    }

    if (event.frame_type === "summary") {
      const draft = ensureAssistant(event);
      draft.summary = value ?? null;
      draft.hasFrame = true;
      continue;
    }

    if (event.frame_type === "mission") {
      const draft = ensureAssistant(event);
      draft.mission = value ?? null;
      draft.hasFrame = true;
      continue;
    }

    if (event.frame_type === "selection") {
      const selection = asRecord(value);
      const kind = selection?.["kind"];
      if (!selection || typeof kind !== "string") continue;
      const draft = ensureAssistant(event);
      draft.selections = [
        ...draft.selections.filter((existing) => existing.kind !== kind),
        { kind, payload: selection["payload"] },
      ];
      draft.hasFrame = true;
      continue;
    }

    if (event.frame_type === "assistant_suggestions") {
      const draft = ensureAssistant(event);
      draft.suggestions = value ?? null;
      draft.hasFrame = true;
      continue;
    }

    if (event.frame_type === "assistant_compound_dispatch") {
      const draft = ensureAssistant(event);
      draft.compoundDispatch = value ?? null;
      draft.hasFrame = true;
      continue;
    }

    if (event.frame_type === "assistant_compound_step_update") {
      const draft = ensureAssistant(event);
      draft.compoundDispatch = applyCompoundStepUpdate(draft.compoundDispatch, value);
      draft.hasFrame = true;
      continue;
    }

    if (event.frame_type === "error") {
      const error = asRecord(value);
      const message =
        typeof error?.["message"] === "string" ? error["message"] : "Something broke on my end.";
      const draft = ensureAssistant(event);
      if (!draft.content) draft.content = message;
      draft.hasFrame = true;
    }
  }

  flushAssistant();
  return messages;
}

function requestMessage(frame_value: unknown): string | null {
  const value = asRecord(frame_value);
  const message = value?.["last_user_message"];
  if (typeof message !== "string") return null;
  const trimmed = message.trim();
  return trimmed || null;
}

function appendChunk(existing: string, chunk: string): string {
  if (!existing) return chunk;
  const needsSpace = /[.!?](["')\]]*)$/.test(existing) && /^[A-Z]/.test(chunk);
  return existing + (needsSpace ? " " : "") + chunk;
}

function applyCompoundStepUpdate(compoundDispatch: unknown, value: unknown): unknown {
  const dispatch = asRecord(compoundDispatch);
  const update = asRecord(value);
  const legId = typeof update?.["leg_id"] === "string" ? update["leg_id"] : "";
  const status = typeof update?.["status"] === "string" ? update["status"] : "";
  const legs = Array.isArray(dispatch?.["legs"]) ? dispatch["legs"] : null;
  if (!dispatch || !update || !legs || !legId || !status) return compoundDispatch;
  const updateRecord = update;
  return {
    ...dispatch,
    legs: legs.map((leg) => {
      const row = asRecord(leg);
      if (!row || row["leg_id"] !== legId) return leg;
      return {
        ...row,
        status,
        timestamp: updateRecord["timestamp"] ?? row["timestamp"] ?? null,
        provider_reference:
          updateRecord["provider_reference"] ?? row["provider_reference"] ?? null,
        evidence: updateRecord["evidence"] ?? row["evidence"] ?? null,
      };
    }),
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}
