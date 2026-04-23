"use client";

/**
 * The Lumo shell home screen. One chat thread, one mic button, one
 * confirmation card when the orchestrator emits a structured summary.
 *
 * Two confirmation surfaces:
 *   - ItineraryConfirmationCard  — single-leg (flight only)
 *   - TripConfirmationCard       — compound (flight + hotel + dinner)
 *
 * The trip card doubles as the dispatch-status surface: once the user
 * confirms, the shell streams per-leg `leg_status` frames and this
 * component threads them back into the card via `legStatuses`.
 *
 * Voice is stubbed for v0 — wired up against the Realtime API in a
 * follow-up PR.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import {
  ItineraryConfirmationCard,
  type ItineraryPayload,
} from "@/components/ItineraryConfirmationCard";
import {
  TripConfirmationCard,
  type TripPayload,
  type LegDispatchStatus,
} from "@/components/TripConfirmationCard";

/**
 * Local mirror of the shell's ConfirmationSummary — we re-declare it
 * here rather than importing from the SDK so the client bundle stays
 * free of node:crypto. Shape must match
 * packages/agent-sdk/src/confirmation.ts :: ConfirmationSummary.
 */
interface UISummary {
  kind:
    | "structured-cart"
    | "structured-itinerary"
    | "structured-booking"
    | "structured-trip";
  payload: unknown;
  hash: string;
  session_id: string;
  turn_id: string;
  rendered_at: string;
}

interface UIMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  summary?: UISummary | null;
}

/**
 * Starter prompt suggestions on the empty state. Chosen to cover the
 * three specialist surfaces we currently ship (flight / food / hotel).
 * Kept in-file because they're copy, not config.
 */
const SUGGESTIONS: Array<{ label: string; prompt: string }> = [
  {
    label: "Flight to Vegas",
    prompt: "Find me a flight to Las Vegas next Friday for under $300.",
  },
  {
    label: "Order dinner",
    prompt: "Order a pepperoni pizza and a Caesar salad from the closest place.",
  },
  {
    label: "Trip to Austin",
    prompt:
      "Plan a trip to Austin next weekend: flight from SFO, a hotel downtown, and dinner Friday night.",
  },
];

export default function Home() {
  const [messages, setMessages] = useState<UIMessage[]>([
    {
      id: "hello",
      role: "assistant",
      content:
        "Hi — I'm Lumo. I can order food, book flights, book hotels, and string them together into one trip. What do you need?",
    },
  ]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  /**
   * Per-assistant-message dispatch status, keyed by the assistant
   * message id → leg order → status. The orchestrator emits
   * `leg_status` SSE frames once the trip is confirmed; we fold them
   * in under the id of the message that carried the trip summary.
   */
  const [legStatusesByMsg, setLegStatusesByMsg] = useState<
    Record<string, Record<number, LegDispatchStatus>>
  >({});
  const scrollRef = useRef<HTMLDivElement>(null);
  const sessionIdRef = useRef<string>(
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : String(Date.now()),
  );

  useEffect(() => {
    scrollRef.current?.scrollTo({
      top: scrollRef.current.scrollHeight,
      behavior: "smooth",
    });
  }, [messages]);

  /**
   * Find the most recent assistant message that carries a trip
   * summary, so `leg_status` frames emitted later in the thread can
   * be folded into the correct card. We look backward from `idx` —
   * the message index at the time the frame arrived — to avoid
   * attaching to a newer trip the user starts mid-dispatch.
   */
  function latestTripMessageId(atIdx: number, from: UIMessage[]): string | null {
    for (let i = atIdx; i >= 0; i--) {
      const m = from[i];
      if (m && m.role === "assistant" && m.summary?.kind === "structured-trip") {
        return m.id;
      }
    }
    return null;
  }

  // Send `text` as a new user message. Appends it to the thread and
  // POSTs the full history (with summaries attached) to /api/chat.
  async function sendText(text: string) {
    if (!text || busy) return;
    const next: UIMessage = {
      id: `u-${Date.now()}`,
      role: "user",
      content: text,
    };

    // Snapshot history-to-send BEFORE we mutate state, so the wire
    // payload is deterministic and doesn't race with React batching.
    const history = [...messages, next];
    setMessages(history);
    setInput("");
    setBusy(true);

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          session_id: sessionIdRef.current,
          device_kind: "web",
          region: "US",
          messages: history.map((m) => ({
            role: m.role,
            content: m.content,
            // Only include when present; the shell's findPriorSummary
            // walks backwards and the most recent wins.
            ...(m.summary ? { summary: m.summary } : {}),
          })),
        }),
      });

      if (!res.body) throw new Error("no stream body");
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let assistantText = "";
      let assistantSummary: UISummary | null = null;
      let buf = "";

      // We stream into a single assistant message whose id is derived
      // from the user turn id, so re-renders are idempotent.
      const assistantId = `a-${next.id}`;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const parts = buf.split("\n\n");
        buf = parts.pop() ?? "";

        for (const p of parts) {
          if (!p.startsWith("data: ")) continue;
          let frame: { type: string; value?: unknown };
          try {
            frame = JSON.parse(p.slice(6));
          } catch {
            continue; // malformed frame — skip, don't crash the stream
          }

          if (frame.type === "text") {
            assistantText += String(frame.value ?? "");
          } else if (frame.type === "summary") {
            assistantSummary = frame.value as UISummary;
          } else if (frame.type === "leg_status") {
            // Compound-booking dispatch update from the orchestrator.
            // Shape: { order: number; status: LegDispatchStatus }.
            const v = frame.value as {
              order?: number;
              status?: LegDispatchStatus;
            };
            if (
              typeof v?.order === "number" &&
              typeof v?.status === "string"
            ) {
              setMessages((m) => {
                const idx = m.length - 1;
                const tripId = latestTripMessageId(idx, m);
                if (!tripId) return m;
                setLegStatusesByMsg((prev) => ({
                  ...prev,
                  [tripId]: {
                    ...(prev[tripId] ?? {}),
                    [v.order as number]: v.status as LegDispatchStatus,
                  },
                }));
                return m;
              });
            }
          } else if (frame.type === "tool") {
            // Debug channel; UI doesn't surface tool calls yet.
            // Future: inline "Lumo asked the flight agent…" breadcrumbs.
          } else if (frame.type === "error") {
            assistantText =
              assistantText ||
              "Something broke on my end. Try again in a moment.";
          } else if (frame.type === "done") {
            // Nothing to do — loop exits on reader done.
          }

          // Publish every applicable frame so partial streams are visible.
          setMessages((m) => {
            const base = m.filter((x) => x.id !== assistantId);
            return [
              ...base,
              {
                id: assistantId,
                role: "assistant",
                content: assistantText,
                summary: assistantSummary,
              },
            ];
          });
        }
      }
    } catch (err) {
      setMessages((m) => [
        ...m,
        {
          id: `err-${Date.now()}`,
          role: "assistant",
          content:
            "Something broke on my end. Try again in a moment — I've logged it.",
        },
      ]);
      console.error(err);
    } finally {
      setBusy(false);
    }
  }

  function send() {
    const text = input.trim();
    if (!text) return;
    void sendText(text);
  }

  // A summary card is "live" if no later user message exists yet; once
  // the user has responded, it freezes. This avoids the double-click
  // /double-book failure mode without needing a separate decided-set.
  function indexOfMessage(id: string): number {
    return messages.findIndex((m) => m.id === id);
  }
  function userMessageExistsAfter(id: string): {
    exists: boolean;
    kind: "confirmed" | "cancelled" | null;
  } {
    const i = indexOfMessage(id);
    if (i < 0) return { exists: false, kind: null };
    for (let j = i + 1; j < messages.length; j++) {
      const m = messages[j]!;
      if (m.role === "user") {
        // Cheap heuristic — same regex family the shell uses. We don't
        // need to be exhaustive: any user reply freezes the card, and
        // the shell is the source of truth for what counts as consent.
        const affirmative = /^\s*(yes|yep|yeah|yup|sure|ok(ay)?|confirm|go(ahead)?|do it|book it|place it|order it|sounds good|looks good|perfect|proceed|let's do it|let's go)/i.test(
          m.content,
        );
        return { exists: true, kind: affirmative ? "confirmed" : "cancelled" };
      }
    }
    return { exists: false, kind: null };
  }

  // True when the thread is effectively empty — just the greeting, no
  // user turn yet. Drives the hero/suggestions block.
  const isEmpty = useMemo(() => {
    return (
      messages.length === 1 &&
      messages[0]?.role === "assistant" &&
      messages[0]?.id === "hello"
    );
  }, [messages]);

  return (
    <main className="flex h-dvh flex-col mx-auto w-full max-w-2xl">
      <header className="flex items-center justify-between px-5 py-4 border-b border-black/5">
        <div className="flex items-center gap-2">
          <div className="h-7 w-7 rounded-full bg-lumo-accent" />
          <span className="font-semibold tracking-tight text-lumo-ink">Lumo</span>
        </div>
        <span className="text-xs text-lumo-muted">one app. any task.</span>
      </header>

      <div
        ref={scrollRef}
        className="thread flex-1 overflow-y-auto px-5 pt-4 pb-4 space-y-3"
      >
        {messages.map((m) => {
          const isItinerary =
            m.role === "assistant" &&
            m.summary?.kind === "structured-itinerary";
          const isTrip =
            m.role === "assistant" && m.summary?.kind === "structured-trip";
          const decided =
            isItinerary || isTrip ? userMessageExistsAfter(m.id) : null;
          const tripStatuses = isTrip ? legStatusesByMsg[m.id] : undefined;

          return (
            <div key={m.id} className="space-y-2">
              {m.content ? (
                <div
                  className={
                    m.role === "user"
                      ? "ml-auto max-w-[85%] rounded-2xl bg-lumo-ink text-white px-4 py-2 whitespace-pre-wrap shadow-sm"
                      : "mr-auto max-w-[85%] rounded-2xl bg-white border border-black/5 px-4 py-2 whitespace-pre-wrap shadow-sm"
                  }
                >
                  {m.content}
                </div>
              ) : null}

              {isItinerary && m.summary ? (
                <ItineraryConfirmationCard
                  payload={m.summary.payload as ItineraryPayload}
                  onConfirm={() => void sendText("Yes, book it.")}
                  onCancel={() => void sendText("Cancel — don't book that.")}
                  disabled={busy || !!decided?.exists}
                  decidedLabel={decided?.kind ?? null}
                />
              ) : null}

              {isTrip && m.summary ? (
                <TripConfirmationCard
                  payload={m.summary.payload as TripPayload}
                  onConfirm={() => void sendText("Yes, book the trip.")}
                  onCancel={() => void sendText("Cancel — don't book that.")}
                  disabled={busy || !!decided?.exists}
                  decidedLabel={decided?.kind ?? null}
                  legStatuses={tripStatuses}
                />
              ) : null}
            </div>
          );
        })}

        {/* Empty-state suggestions. Visible when no user turn has happened
            yet — disappears the moment the first message goes out. */}
        {isEmpty && (
          <div className="pt-2 space-y-2">
            <div className="text-[11px] uppercase tracking-widest text-lumo-muted px-1">
              Try
            </div>
            <div className="flex flex-wrap gap-2">
              {SUGGESTIONS.map((s) => (
                <button
                  key={s.label}
                  type="button"
                  onClick={() => void sendText(s.prompt)}
                  className="text-sm px-3 py-1.5 rounded-full bg-white border border-black/10 text-lumo-ink hover:bg-lumo-paper hover:border-black/20 transition-colors"
                >
                  {s.label}
                </button>
              ))}
            </div>
          </div>
        )}

        {busy && (
          <div
            className="mr-auto max-w-[85%] rounded-2xl bg-white border border-black/5 px-4 py-2 text-lumo-muted shadow-sm inline-flex items-center gap-2"
            aria-live="polite"
          >
            <span className="inline-flex gap-1">
              <span className="h-1.5 w-1.5 rounded-full bg-lumo-muted animate-pulse" />
              <span
                className="h-1.5 w-1.5 rounded-full bg-lumo-muted animate-pulse"
                style={{ animationDelay: "150ms" }}
              />
              <span
                className="h-1.5 w-1.5 rounded-full bg-lumo-muted animate-pulse"
                style={{ animationDelay: "300ms" }}
              />
            </span>
            Lumo is thinking…
          </div>
        )}
      </div>

      <div className="border-t border-black/5 p-3 flex items-end gap-2 bg-white/60 backdrop-blur">
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              send();
            }
          }}
          rows={1}
          placeholder="Order a pizza, book a flight to Vegas, find a hotel in Austin…"
          className="flex-1 resize-none rounded-2xl border border-black/10 bg-white px-4 py-3 focus:outline-none focus:ring-2 focus:ring-lumo-accent/40"
          disabled={busy}
        />
        <button
          type="button"
          aria-label="Voice"
          title="Voice (coming soon)"
          className="h-11 w-11 rounded-full bg-white border border-black/10 flex items-center justify-center hover:bg-black/5 disabled:opacity-50"
          disabled
        >
          <span className="text-lg">🎙</span>
        </button>
        <button
          type="button"
          onClick={send}
          disabled={busy || !input.trim()}
          className="h-11 px-5 rounded-full bg-lumo-ink text-white font-medium hover:opacity-95 disabled:opacity-40 transition-opacity"
        >
          Send
        </button>
      </div>
    </main>
  );
}
