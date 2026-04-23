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
 *
 * Visual model
 * ────────────
 * - Warm paper canvas (set on <body> in globals.css) with a bright
 *   surface card for the chat column so legibility never depends on
 *   the gradient tone behind it.
 * - Assistant replies are rendered through ChatMarkdown, so GFM tables,
 *   lists, code, and links get real typography instead of whitespace-
 *   preserved plain text. This is what fixes the "literal pipes" look
 *   we saw on the first deploy.
 * - Suggestion tiles on the empty state are full cards, not chips —
 *   flights/food/trips each get an icon, a label, and a one-line hint.
 * - The composer is a single pill with mic + send living inside the
 *   same bordered surface; matches the density of a premium chat UI.
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
import {
  FoodMenuSelectCard,
  type FoodMenuSelection,
} from "@/components/FoodMenuSelectCard";
import {
  FlightOffersSelectCard,
  type FlightOffersSelection,
} from "@/components/FlightOffersSelectCard";
import { ChatMarkdown } from "@/components/ChatMarkdown";

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

/**
 * Interactive-selection frame emitted by the orchestrator for
 * discovery tools whose results render as rich UI (food menu
 * checkboxes, flight offer radios). Deduped per kind on the server.
 */
interface UISelection {
  kind: "food_menu" | "flight_offers";
  payload: unknown;
}

interface UIMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  summary?: UISummary | null;
  selections?: UISelection[];
}

/**
 * Starter prompt suggestions on the empty state. Chosen to cover the
 * three specialist surfaces we currently ship (flight / food / hotel).
 * Each tile carries a glyph + label + hint so the empty state reads as
 * an onboarding moment, not a placeholder.
 */
const SUGGESTIONS: Array<{
  label: string;
  hint: string;
  prompt: string;
  glyph: string;
}> = [
  {
    label: "Book a flight",
    hint: "SFO → LAS next Friday, under $300",
    prompt: "Find me a flight to Las Vegas next Friday for under $300.",
    glyph: "✈",
  },
  {
    label: "Order dinner",
    hint: "Pepperoni pizza + Caesar salad, nearby",
    prompt:
      "Order a pepperoni pizza and a Caesar salad from the closest place.",
    glyph: "🍽",
  },
  {
    label: "Plan a trip",
    hint: "Flight + hotel + dinner, all in one ask",
    prompt:
      "Plan a trip to Austin next weekend: flight from SFO, a hotel downtown, and dinner Friday night.",
    glyph: "🗺",
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
  const textareaRef = useRef<HTMLTextAreaElement>(null);
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

  // Auto-grow the textarea up to ~5 lines, then clamp to scroll. The
  // raw `rows={1}` fallback is kept so SSR renders a single-line shell
  // before hydration runs this effect.
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    const maxPx = 160; // ~5 lines at our line-height
    el.style.height = `${Math.min(el.scrollHeight, maxPx)}px`;
  }, [input]);

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
      let assistantSelections: UISelection[] = [];
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
          } else if (frame.type === "selection") {
            // Discovery tool output that should render as rich UI
            // (checkbox menu / radio offers). Dedupe by kind — last
            // emit wins — so the card always reflects the most recent
            // tool call of that kind in this turn.
            const s = frame.value as UISelection;
            if (s && typeof s.kind === "string") {
              assistantSelections = [
                ...assistantSelections.filter((x) => x.kind !== s.kind),
                s,
              ];
            }
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
                selections: assistantSelections.length
                  ? assistantSelections
                  : undefined,
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
    <main className="flex h-dvh flex-col mx-auto w-full max-w-3xl">
      {/* ─── Header ─────────────────────────────────────────────────── */}
      <header className="flex items-center justify-between px-6 py-4">
        <div className="flex items-center gap-2.5">
          {/* Mark: solid orange disc with a tiny inner highlight to read
              as a "lit" dot rather than a flat circle. */}
          <div className="relative h-8 w-8 rounded-full bg-lumo-accent shadow-[0_0_0_1px_rgba(11,14,20,0.06),0_4px_10px_-4px_rgba(255,107,44,0.55)]">
            <div className="absolute left-[6px] top-[6px] h-[7px] w-[7px] rounded-full bg-white/60 blur-[0.5px]" />
          </div>
          <div className="leading-tight">
            <div className="font-semibold tracking-tight text-lumo-ink text-[15px]">
              Lumo
            </div>
            <div className="text-[11px] text-lumo-muted -mt-0.5">
              one app. any task.
            </div>
          </div>
        </div>

        {/* Status pill — a running agent's equivalent of a presence dot.
            Intentionally low-contrast; it's ambient, not a CTA. */}
        <div className="flex items-center gap-1.5 text-[11px] text-lumo-muted px-2.5 py-1 rounded-full border border-lumo-hairline bg-white/60 backdrop-blur-sm">
          <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
          live
        </div>
      </header>

      {/* ─── Thread ─────────────────────────────────────────────────── */}
      <div
        ref={scrollRef}
        className="thread flex-1 overflow-y-auto px-5 pt-2 pb-6 space-y-4"
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
          const isUser = m.role === "user";

          return (
            <div key={m.id} className="animate-fade-up space-y-2">
              {m.content ? (
                isUser ? (
                  // User bubble — ink surface, right-aligned.
                  <div className="ml-auto max-w-[85%] rounded-2xl rounded-br-md bg-lumo-ink text-white/95 px-4 py-2.5 whitespace-pre-wrap shadow-card">
                    {m.content}
                  </div>
                ) : (
                  // Assistant row: avatar + prose bubble. The bubble is
                  // the white "surface" tone so the warm paper canvas
                  // shows around it.
                  <div className="mr-auto flex items-start gap-2.5 max-w-[92%]">
                    <div
                      className="mt-1 h-6 w-6 shrink-0 rounded-full bg-lumo-accent shadow-[0_0_0_1px_rgba(11,14,20,0.06)]"
                      aria-hidden
                    />
                    <div className="flex-1 rounded-2xl rounded-tl-md bg-lumo-surface border border-lumo-hairline px-4 py-3 shadow-card">
                      <ChatMarkdown>{m.content}</ChatMarkdown>
                    </div>
                  </div>
                )
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

              {/* ─── Interactive selection cards ──────────────────
                  Rendered when the orchestrator emits a `selection`
                  frame for a discovery tool (food menu / flight
                  offers). Freezes the same way confirmation cards do
                  — the moment a later user turn exists, the card
                  locks in and shows the decision label. */}
              {m.role === "assistant" && m.selections?.length
                ? (() => {
                    const selectionDecided = userMessageExistsAfter(m.id);
                    return m.selections.map((sel) => {
                      if (sel.kind === "food_menu") {
                        return (
                          <FoodMenuSelectCard
                            key={`${m.id}-food`}
                            payload={sel.payload as FoodMenuSelection}
                            onSubmit={(text) => void sendText(text)}
                            disabled={busy}
                            decidedLabel={selectionDecided.kind}
                          />
                        );
                      }
                      if (sel.kind === "flight_offers") {
                        return (
                          <FlightOffersSelectCard
                            key={`${m.id}-flight-offers`}
                            payload={sel.payload as FlightOffersSelection}
                            onSubmit={(text) => void sendText(text)}
                            disabled={busy}
                            decidedLabel={selectionDecided.kind}
                          />
                        );
                      }
                      return null;
                    });
                  })()
                : null}
            </div>
          );
        })}

        {/* ─── Empty state ──────────────────────────────────────────
            Hero + three full-size suggestion tiles. Disappears the
            moment the first real user turn is sent. */}
        {isEmpty && (
          <div className="pt-6 pb-2 space-y-6">
            <div className="space-y-2 px-1">
              <h1 className="text-2xl sm:text-3xl font-semibold tracking-tight text-lumo-ink">
                What can I book for you?
              </h1>
              <p className="text-sm text-lumo-muted max-w-md">
                Flights, dinner, hotels — or all three in one ask. I'll hand
                off to the right specialist and bring back a single trip.
              </p>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5">
              {SUGGESTIONS.map((s) => (
                <button
                  key={s.label}
                  type="button"
                  onClick={() => void sendText(s.prompt)}
                  className="group text-left rounded-2xl bg-lumo-surface border border-lumo-hairline hover:border-lumo-accent/40 hover:shadow-card transition-all px-4 py-3.5 space-y-1.5"
                >
                  <div className="flex items-center gap-2">
                    <span className="text-base" aria-hidden>
                      {s.glyph}
                    </span>
                    <span className="font-medium text-[14px] text-lumo-ink">
                      {s.label}
                    </span>
                  </div>
                  <div className="text-[12.5px] text-lumo-muted leading-snug">
                    {s.hint}
                  </div>
                </button>
              ))}
            </div>
          </div>
        )}

        {/* ─── "Thinking" indicator ─────────────────────────────────── */}
        {busy && (
          <div className="mr-auto flex items-start gap-2.5 max-w-[92%] animate-fade-up">
            <div
              className="mt-1 h-6 w-6 shrink-0 rounded-full bg-lumo-accent shadow-[0_0_0_1px_rgba(11,14,20,0.06)]"
              aria-hidden
            />
            <div
              className="rounded-2xl rounded-tl-md bg-lumo-surface border border-lumo-hairline px-4 py-3 text-lumo-muted text-sm shadow-card inline-flex items-center gap-2.5"
              aria-live="polite"
            >
              <span className="inline-flex gap-1">
                <span className="h-1.5 w-1.5 rounded-full bg-lumo-accent animate-dot-1" />
                <span className="h-1.5 w-1.5 rounded-full bg-lumo-accent animate-dot-2" />
                <span className="h-1.5 w-1.5 rounded-full bg-lumo-accent animate-dot-3" />
              </span>
              <span>Lumo is thinking…</span>
            </div>
          </div>
        )}
      </div>

      {/* ─── Composer ───────────────────────────────────────────────── */}
      <div className="px-4 pb-4 pt-2">
        <div className="mx-auto flex items-end gap-2 rounded-[22px] bg-lumo-surface border border-lumo-hairline shadow-card px-2.5 py-2 focus-within:border-lumo-accent/50 focus-within:shadow-cardHero transition-shadow">
          <button
            type="button"
            aria-label="Voice (coming soon)"
            title="Voice (coming soon)"
            className="h-10 w-10 rounded-full flex items-center justify-center text-lumo-muted hover:bg-black/5 disabled:opacity-40 transition-colors"
            disabled
          >
            <span className="text-[17px]">🎙</span>
          </button>

          <textarea
            ref={textareaRef}
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
            className="flex-1 resize-none bg-transparent px-1 py-2.5 text-[15px] leading-6 text-lumo-ink placeholder:text-lumo-muted/80 focus:outline-none"
            disabled={busy}
          />

          {/* Send — circular, accent when armed, neutral when empty.
              Kept visually distinct from the mic so the primary action
              is unambiguous. */}
          <button
            type="button"
            onClick={send}
            disabled={busy || !input.trim()}
            aria-label="Send"
            className="h-10 w-10 rounded-full bg-lumo-accent text-white flex items-center justify-center shadow-[0_6px_14px_-6px_rgba(255,107,44,0.7)] hover:bg-lumo-accentDeep disabled:bg-black/10 disabled:text-lumo-muted disabled:shadow-none transition-all"
          >
            <svg
              viewBox="0 0 20 20"
              width="16"
              height="16"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.2"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden
            >
              <path d="M3.5 10h12" />
              <path d="M10 4.5 15.5 10 10 15.5" />
            </svg>
          </button>
        </div>
        <div className="text-[11px] text-lumo-muted text-center mt-2">
          Enter to send · Shift+Enter for newline
        </div>
      </div>
    </main>
  );
}
