"use client";

/**
 * Lumo shell — one chat thread, one composer, confirmation cards when
 * the orchestrator emits a structured summary.
 *
 * Redesign contract (v2, 2026-04):
 *   - Dark-first, Linear/Vercel editorial-minimal aesthetic. One
 *     restrained accent. No orange glow, no lit discs, no emoji in
 *     the chrome.
 *   - Messages are typographic, not bubbled. User messages right-
 *     aligned in a soft elevated pill; assistant messages flow as
 *     prose with a small "Lumo" label.
 *   - Composer is a bordered block pinned to the bottom with an
 *     explicit toolbar row (kbd hint + Send).
 *   - Per-leg dispatch, confirmation cards, selection cards — all
 *     unchanged in logic; re-skinned via their own components.
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
import {
  TimeSlotsSelectCard,
  type TimeSlotsSelection,
} from "@/components/TimeSlotsSelectCard";
import {
  ReservationConfirmationCard,
  type ReservationPayload,
} from "@/components/ReservationConfirmationCard";
import { ChatMarkdown } from "@/components/ChatMarkdown";
import { ThemeToggle } from "@/components/ThemeToggle";
import { BrandMark } from "@/components/BrandMark";
import VoiceMode from "@/components/VoiceMode";

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
    | "structured-trip"
    | "structured-reservation";
  payload: unknown;
  hash: string;
  session_id: string;
  turn_id: string;
  rendered_at: string;
}

/**
 * Interactive-selection frame — emitted by the orchestrator for
 * discovery tools whose results render as rich UI. Deduped per kind
 * on the server.
 */
interface UISelection {
  kind: "food_menu" | "flight_offers" | "time_slots";
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
 * Starter scaffolds on the empty state. Editorial — each reads as a
 * complete sentence a user would plausibly say, not a feature demo.
 */
const SUGGESTIONS: Array<{ label: string; prompt: string }> = [
  {
    label: "Flight to Vegas next Friday, under $300",
    prompt: "Find me a flight to Las Vegas next Friday for under $300.",
  },
  {
    label: "Pepperoni pizza and a Caesar salad, closest place",
    prompt:
      "Order a pepperoni pizza and a Caesar salad from the closest place.",
  },
  {
    label: "Hotel in Austin, 2 nights, walkable to 6th Street",
    prompt:
      "Find me a hotel in Austin for 2 nights, walkable to 6th Street, 4 stars or better.",
  },
  {
    label: "Trip to Austin: flight, hotel, Friday dinner",
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
        "I can book flights, order food, reserve hotels — and string them together into a single trip. What do you need?",
    },
  ]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [legStatusesByMsg, setLegStatusesByMsg] = useState<
    Record<string, Record<number, LegDispatchStatus>>
  >({});

  // Voice mode — see components/VoiceMode.tsx. `voiceEnabled` is the
  // master toggle, persisted across reloads. `handsFree` auto-restarts
  // the mic after each response (JARVIS loop). `spokenStreamText` is
  // the accumulating assistant text for the CURRENT in-flight turn;
  // VoiceMode reads it reactively and speaks new sentences as they
  // arrive. It resets to "" when a new turn starts.
  const [voiceEnabled, setVoiceEnabled] = useState<boolean>(false);
  const [handsFree, setHandsFree] = useState<boolean>(true);
  const [spokenStreamText, setSpokenStreamText] = useState<string>("");
  useEffect(() => {
    try {
      const v = window.localStorage.getItem("lumo.voiceEnabled");
      const h = window.localStorage.getItem("lumo.handsFree");
      if (v != null) setVoiceEnabled(v === "1");
      if (h != null) setHandsFree(h === "1");
    } catch {
      // localStorage unavailable (private mode) — defaults are fine.
    }
  }, []);
  useEffect(() => {
    try {
      window.localStorage.setItem("lumo.voiceEnabled", voiceEnabled ? "1" : "0");
    } catch {
      // ignore
    }
  }, [voiceEnabled]);
  useEffect(() => {
    try {
      window.localStorage.setItem("lumo.handsFree", handsFree ? "1" : "0");
    } catch {
      // ignore
    }
  }, [handsFree]);

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

  // Auto-grow the textarea up to ~6 lines.
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    const maxPx = 192;
    el.style.height = `${Math.min(el.scrollHeight, maxPx)}px`;
  }, [input]);

  function latestTripMessageId(atIdx: number, from: UIMessage[]): string | null {
    for (let i = atIdx; i >= 0; i--) {
      const m = from[i];
      if (m && m.role === "assistant" && m.summary?.kind === "structured-trip") {
        return m.id;
      }
    }
    return null;
  }

  async function sendText(text: string) {
    if (!text || busy) return;
    const next: UIMessage = {
      id: `u-${Date.now()}`,
      role: "user",
      content: text,
    };

    const history = [...messages, next];
    setMessages(history);
    setInput("");
    setBusy(true);
    // Start a fresh spoken-text buffer for this turn. VoiceMode keys
    // off this to decide where to resume TTS.
    setSpokenStreamText("");

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          session_id: sessionIdRef.current,
          device_kind: "web",
          region: "US",
          // Tell the server we're speaking so it can adapt response
          // length, skip markdown, and narrate structured summaries
          // in spoken prose. See lib/voice-format.ts + system prompt.
          mode: voiceEnabled ? "voice" : "text",
          messages: history.map((m) => ({
            role: m.role,
            content: m.content,
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
            continue;
          }

          if (frame.type === "text") {
            const chunk = String(frame.value ?? "");
            assistantText += chunk;
            if (voiceEnabled) {
              // Mirror into the spoken buffer so VoiceMode can start
              // TTS as sentences land. Functional updater so rapid
              // frames don't drop chunks on React batching.
              setSpokenStreamText((prev) => prev + chunk);
            }
          } else if (frame.type === "summary") {
            assistantSummary = frame.value as UISummary;
          } else if (frame.type === "selection") {
            const s = frame.value as UISelection;
            if (s && typeof s.kind === "string") {
              assistantSelections = [
                ...assistantSelections.filter((x) => x.kind !== s.kind),
                s,
              ];
            }
          } else if (frame.type === "leg_status") {
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
            // Debug channel; not surfaced yet.
          } else if (frame.type === "error") {
            assistantText =
              assistantText ||
              "Something broke on my end. Try again in a moment.";
          }

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
        const affirmative = /^\s*(yes|yep|yeah|yup|sure|ok(ay)?|confirm|go(ahead)?|do it|book it|place it|order it|sounds good|looks good|perfect|proceed|let's do it|let's go)/i.test(
          m.content,
        );
        return { exists: true, kind: affirmative ? "confirmed" : "cancelled" };
      }
    }
    return { exists: false, kind: null };
  }

  function newThread() {
    setMessages([
      {
        id: "hello",
        role: "assistant",
        content:
          "I can book flights, order food, reserve hotels — and string them together into a single trip. What do you need?",
      },
    ]);
    setLegStatusesByMsg({});
    setInput("");
    sessionIdRef.current =
      typeof crypto !== "undefined" && "randomUUID" in crypto
        ? crypto.randomUUID()
        : String(Date.now());
  }

  const isEmpty = useMemo(() => {
    return (
      messages.length === 1 &&
      messages[0]?.role === "assistant" &&
      messages[0]?.id === "hello"
    );
  }, [messages]);

  return (
    <main className="flex h-dvh flex-col bg-lumo-bg text-lumo-fg-high">
      {/* ─── Header ─────────────────────────────────────────────────── */}
      <header className="sticky top-0 z-20 border-b border-lumo-hair bg-lumo-bg/80 backdrop-blur-md">
        <div className="mx-auto flex w-full max-w-3xl items-center justify-between px-5 py-3">
          <div className="flex items-center gap-2.5">
            <BrandMark size={22} className="text-lumo-fg" />
            <div className="flex items-baseline gap-2">
              <span className="text-[14px] font-semibold tracking-tight text-lumo-fg">
                Lumo
              </span>
              <span className="hidden sm:inline text-[11px] text-lumo-fg-low tracking-wide">
                one app · any task
              </span>
            </div>
          </div>

          <div className="flex items-center gap-1.5">
            {/* Model / status chip — ambient, not a CTA. */}
            <div className="hidden sm:inline-flex items-center gap-1.5 text-[10.5px] text-lumo-fg-mid px-2 py-1 rounded-md border border-lumo-hair num tracking-wide">
              <span className="h-1.5 w-1.5 rounded-full bg-lumo-ok" />
              <span>claude-opus-4.6</span>
            </div>

            <button
              type="button"
              onClick={newThread}
              aria-label="New thread"
              title="New thread"
              className="h-7 px-2.5 rounded-md inline-flex items-center gap-1.5 text-[12px] text-lumo-fg-mid hover:text-lumo-fg hover:bg-lumo-elevated transition-colors"
            >
              <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden>
                <path d="M6 2.5v7M2.5 6h7" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
              </svg>
              <span className="hidden sm:inline">New</span>
            </button>

            <ThemeToggle />
          </div>
        </div>
      </header>

      {/* ─── Thread ─────────────────────────────────────────────────── */}
      <div
        ref={scrollRef}
        className="thread flex-1 overflow-y-auto"
      >
        <div className="mx-auto w-full max-w-3xl px-5 pt-6 pb-10 space-y-5">
          {messages.map((m) => {
            const isItinerary =
              m.role === "assistant" &&
              m.summary?.kind === "structured-itinerary";
            const isTrip =
              m.role === "assistant" && m.summary?.kind === "structured-trip";
            const isReservation =
              m.role === "assistant" &&
              m.summary?.kind === "structured-reservation";
            const decided =
              isItinerary || isTrip || isReservation
                ? userMessageExistsAfter(m.id)
                : null;
            const tripStatuses = isTrip ? legStatusesByMsg[m.id] : undefined;
            const isUser = m.role === "user";

            return (
              <div key={m.id} className="animate-fade-up space-y-3">
                {m.content ? (
                  isUser ? (
                    // User — right-aligned, soft elevated surface, tight.
                    <div className="flex justify-end">
                      <div className="max-w-[82%] rounded-lg bg-lumo-elevated text-lumo-fg px-3.5 py-2 text-[14.5px] leading-6 whitespace-pre-wrap border border-lumo-hair">
                        {m.content}
                      </div>
                    </div>
                  ) : (
                    // Assistant — typographic. Small "Lumo" label, then prose.
                    <div className="space-y-1.5">
                      <div className="flex items-center gap-1.5 text-[10.5px] uppercase tracking-[0.12em] text-lumo-fg-low num">
                        <BrandMark size={12} className="text-lumo-fg-low" />
                        <span>Lumo</span>
                      </div>
                      <div className="pl-[18px]">
                        <ChatMarkdown>{m.content}</ChatMarkdown>
                      </div>
                    </div>
                  )
                ) : null}

                {isItinerary && m.summary ? (
                  <div className="pl-[18px]">
                    <ItineraryConfirmationCard
                      payload={m.summary.payload as ItineraryPayload}
                      onConfirm={() => void sendText("Yes, book it.")}
                      onCancel={() => void sendText("Cancel — don't book that.")}
                      disabled={busy || !!decided?.exists}
                      decidedLabel={decided?.kind ?? null}
                    />
                  </div>
                ) : null}

                {isTrip && m.summary ? (
                  <div className="pl-[18px]">
                    <TripConfirmationCard
                      payload={m.summary.payload as TripPayload}
                      onConfirm={() => void sendText("Yes, book the trip.")}
                      onCancel={() => void sendText("Cancel — don't book that.")}
                      disabled={busy || !!decided?.exists}
                      decidedLabel={decided?.kind ?? null}
                      legStatuses={tripStatuses}
                    />
                  </div>
                ) : null}

                {isReservation && m.summary ? (
                  <div className="pl-[18px]">
                    <ReservationConfirmationCard
                      payload={m.summary.payload as ReservationPayload}
                      onConfirm={() => void sendText("Yes, book it.")}
                      onCancel={() => void sendText("Cancel — don't book that.")}
                      disabled={busy || !!decided?.exists}
                      decidedLabel={decided?.kind ?? null}
                    />
                  </div>
                ) : null}

                {m.role === "assistant" && m.selections?.length
                  ? (() => {
                      const selectionDecided = userMessageExistsAfter(m.id);
                      return (
                        <div className="pl-[18px] space-y-3">
                          {m.selections.map((sel) => {
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
                            if (sel.kind === "time_slots") {
                              return (
                                <TimeSlotsSelectCard
                                  key={`${m.id}-time-slots`}
                                  payload={sel.payload as TimeSlotsSelection}
                                  onSubmit={(text) => void sendText(text)}
                                  disabled={busy}
                                  decidedLabel={selectionDecided.kind}
                                />
                              );
                            }
                            return null;
                          })}
                        </div>
                      );
                    })()
                  : null}
              </div>
            );
          })}

          {/* ─── Empty state ─────────────────────────────────────────
              Editorial headline + four scaffold prompts. Disappears
              the moment the first real user turn is sent. */}
          {isEmpty && (
            <div className="pt-4 pb-2 space-y-8 animate-fade-in">
              <div className="space-y-3">
                <h1 className="text-[32px] md:text-[40px] font-semibold tracking-[-0.022em] leading-[1.1] text-lumo-fg">
                  Plan anything, in one{" "}
                  <span className="text-lumo-accent">sentence</span>.
                </h1>
                <p className="text-[14.5px] text-lumo-fg-mid max-w-xl leading-relaxed">
                  Lumo is a conversational shell over specialist agents.
                  Flights, hotels, food — booked by the right service,
                  confirmed in one place.
                </p>
              </div>

              <div className="space-y-1">
                <div className="text-[10.5px] uppercase tracking-[0.14em] text-lumo-fg-low mb-2">
                  Try asking
                </div>
                <div className="flex flex-col divide-y divide-lumo-hair border-y border-lumo-hair">
                  {SUGGESTIONS.map((s) => (
                    <button
                      key={s.label}
                      type="button"
                      onClick={() => void sendText(s.prompt)}
                      className="group text-left px-0.5 py-3 flex items-center justify-between gap-4 hover:text-lumo-fg text-lumo-fg-high transition-colors"
                    >
                      <span className="text-[14px] leading-snug">{s.label}</span>
                      <span className="text-lumo-fg-low group-hover:text-lumo-accent transition-colors shrink-0" aria-hidden>
                        <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                          <path
                            d="M3 7h8m0 0-3-3m3 3-3 3"
                            stroke="currentColor"
                            strokeWidth="1.4"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                          />
                        </svg>
                      </span>
                    </button>
                  ))}
                </div>
              </div>
            </div>
          )}

          {/* ─── "Thinking" indicator ─────────────────────────────── */}
          {busy && (
            <div className="animate-fade-in space-y-1.5">
              <div className="flex items-center gap-1.5 text-[10.5px] uppercase tracking-[0.12em] text-lumo-fg-low num">
                <BrandMark size={12} className="text-lumo-fg-low" />
                <span>Lumo</span>
              </div>
              <div className="pl-[18px] flex items-center gap-2 text-[14px]">
                <span className="shimmer">Thinking</span>
                <span className="inline-flex gap-0.5" aria-hidden>
                  <span className="h-1 w-1 rounded-full bg-lumo-fg-low animate-dot-1" />
                  <span className="h-1 w-1 rounded-full bg-lumo-fg-low animate-dot-2" />
                  <span className="h-1 w-1 rounded-full bg-lumo-fg-low animate-dot-3" />
                </span>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* ─── Composer ───────────────────────────────────────────────── */}
      <div className="border-t border-lumo-hair bg-lumo-bg">
        <div className="mx-auto w-full max-w-3xl px-5 pb-4 pt-3">
          {voiceEnabled ? (
            <div className="mb-2">
              <VoiceMode
                enabled={voiceEnabled}
                onToggle={setVoiceEnabled}
                handsFree={handsFree}
                onHandsFreeToggle={setHandsFree}
                onUserUtterance={(t) => {
                  // Respect busy: a late STT result after the agent
                  // already started a new turn is dropped. The user
                  // can retry.
                  if (!busy) void sendText(t);
                }}
                spokenText={spokenStreamText}
                busy={busy}
              />
            </div>
          ) : null}

          <div className="group rounded-xl border border-lumo-hair bg-lumo-surface focus-within:border-lumo-edge transition-colors">
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
              placeholder="Ask Lumo to book a flight, order dinner, plan a trip…"
              className="block w-full resize-none bg-transparent px-4 pt-3.5 pb-1 text-[15px] leading-6 text-lumo-fg placeholder:text-lumo-fg-low focus:outline-none"
              style={{ outline: "none" }}
              disabled={busy}
            />

            {/* Toolbar row — left: kbd affordances, right: Send. */}
            <div className="flex items-center justify-between px-3 pb-2.5 pt-1.5">
              <div className="flex items-center gap-1 text-lumo-fg-low">
                <button
                  type="button"
                  aria-pressed={voiceEnabled}
                  aria-label={voiceEnabled ? "Turn voice off" : "Turn voice on"}
                  title={voiceEnabled ? "Voice on — click to turn off" : "Voice mode"}
                  onClick={() => setVoiceEnabled((v) => !v)}
                  className={
                    "h-7 w-7 rounded-md inline-flex items-center justify-center transition-colors " +
                    (voiceEnabled
                      ? "bg-lumo-accent/15 text-lumo-accent"
                      : "hover:text-lumo-fg-mid hover:bg-lumo-elevated")
                  }
                >
                  <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden>
                    <rect x="6" y="2" width="4" height="8.4" rx="2" stroke="currentColor" strokeWidth="1.4" />
                    <path d="M3.6 8v.6a4.4 4.4 0 0 0 8.8 0V8M8 13.6V15" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
                  </svg>
                </button>
                <button
                  type="button"
                  aria-label="Attach (coming soon)"
                  title="Attach (coming soon)"
                  className="h-7 w-7 rounded-md inline-flex items-center justify-center hover:text-lumo-fg-mid hover:bg-lumo-elevated disabled:opacity-40 transition-colors"
                  disabled
                >
                  <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden>
                    <path d="M10.6 4.8 5.4 10a2.1 2.1 0 1 0 3 3l5-5a3.5 3.5 0 0 0-4.9-4.9l-5 5a4.9 4.9 0 0 0 7 6.9" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                </button>
                <div className="hidden sm:flex items-center gap-1.5 pl-2 text-[11px]">
                  <span className="kbd">↵</span>
                  <span>send</span>
                  <span className="mx-0.5 text-lumo-fg-low">·</span>
                  <span className="kbd">⇧</span>
                  <span className="kbd">↵</span>
                  <span>newline</span>
                </div>
              </div>

              <button
                type="button"
                onClick={send}
                disabled={busy || !input.trim()}
                aria-label="Send"
                className="group/send h-7 pl-2.5 pr-2 rounded-md inline-flex items-center gap-1.5 text-[12.5px] font-medium bg-lumo-fg text-lumo-bg hover:bg-lumo-accent hover:text-lumo-accent-ink disabled:bg-lumo-elevated disabled:text-lumo-fg-low disabled:cursor-not-allowed transition-colors"
              >
                <span>Send</span>
                <span className="kbd" style={{ borderColor: "transparent", background: "transparent", color: "inherit", padding: 0 }}>↵</span>
              </button>
            </div>
          </div>
          <div className="text-[10.5px] text-lumo-fg-low text-center mt-2 tracking-wide">
            Lumo can make mistakes. Confirmations are tamper-resistant — review before booking.
          </div>
        </div>
      </div>
    </main>
  );
}
