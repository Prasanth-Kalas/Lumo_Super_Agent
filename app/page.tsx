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
import VoiceMode, { type VoiceState } from "@/components/VoiceMode";
import LeftRail from "@/components/LeftRail";
import RightRail, { type ActiveTripView, type LegStatusLite } from "@/components/RightRail";

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
  // Hands-free is always-on when voice is enabled (#85 removed
  // push-to-talk). State kept for VoiceMode API compatibility.
  const [handsFree, setHandsFree] = useState<boolean>(true);
  // Bumped after each agent turn so RightRail's MemoryPanel re-fetches.
  const [memoryRefreshKey, setMemoryRefreshKey] = useState<number>(0);
  // Mute Lumo's TTS while keeping the mic hot. Persisted.
  const [voiceMuted, setVoiceMuted] = useState<boolean>(false);
  const [spokenStreamText, setSpokenStreamText] = useState<string>("");
  // Mirror of VoiceMode's internal state so the right-rail HUD can
  // show a matching pulse without owning the state machine.
  const [voiceState, setVoiceState] = useState<VoiceState>("off");
  useEffect(() => {
    try {
      const v = window.localStorage.getItem("lumo.voiceEnabled");
      const h = window.localStorage.getItem("lumo.handsFree");
      const m = window.localStorage.getItem("lumo.voiceMuted");
      if (v != null) setVoiceEnabled(v === "1");
      if (h != null) setHandsFree(h === "1");
      if (m != null) setVoiceMuted(m === "1");
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
  useEffect(() => {
    try {
      window.localStorage.setItem("lumo.voiceMuted", voiceMuted ? "1" : "0");
    } catch {
      // ignore
    }
  }, [voiceMuted]);

  const scrollRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const sessionIdRef = useRef<string>(
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : String(Date.now()),
  );

  // J4 — ambient context. Opportunistic geolocation: ask once on the
  // first real user message, remember yes/no for the session. Denied
  // is fine; we still send local_time + timezone.
  const coordsRef = useRef<{ lat: number; lng: number; accuracy_m?: number } | null>(null);
  const geoAskedRef = useRef<boolean>(false);
  async function captureCoordsOnce(): Promise<void> {
    if (geoAskedRef.current) return;
    geoAskedRef.current = true;
    if (typeof navigator === "undefined" || !navigator.geolocation) return;
    await new Promise<void>((resolve) => {
      navigator.geolocation.getCurrentPosition(
        (pos) => {
          coordsRef.current = {
            lat: pos.coords.latitude,
            lng: pos.coords.longitude,
            accuracy_m: pos.coords.accuracy,
          };
          resolve();
        },
        () => resolve(),
        { timeout: 4000, maximumAge: 5 * 60 * 1000 },
      );
    });
  }
  function buildAmbient() {
    const tz =
      typeof Intl !== "undefined"
        ? Intl.DateTimeFormat().resolvedOptions().timeZone
        : undefined;
    return {
      local_time: new Date().toISOString(),
      timezone: tz,
      coords: coordsRef.current ?? undefined,
    };
  }

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
      // J4 — ask for geolocation on the first real turn. The prompt
      // only appears once per session; subsequent turns reuse whatever
      // the user decided.
      await captureCoordsOnce();

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
          ambient: buildAmbient(),
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
      // Bump memory refresh key — the orchestrator may have called
      // memory_save / profile_update / memory_forget during this
      // turn. RightRail's MemoryPanel re-fetches /api/memory when
      // this changes.
      setMemoryRefreshKey((k) => k + 1);
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

  // Derive the active trip for the right-rail HUD. We scan backwards
  // through the thread looking for the most recent assistant message
  // that carries a structured-trip summary. Legs merge with live
  // statuses from legStatusesByMsg (set by SSE leg_status frames).
  const activeTrip: ActiveTripView | null = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      if (!m || m.role !== "assistant") continue;
      if (m.summary?.kind !== "structured-trip") continue;
      const p = (m.summary.payload ?? {}) as {
        trip_title?: string;
        total_amount?: string;
        currency?: string;
        legs?: Array<{ order: number; agent_id: string }>;
      };
      const statuses = legStatusesByMsg[m.id] ?? {};
      const legs: LegStatusLite[] = (p.legs ?? []).map((l) => ({
        order: l.order,
        agent_id: l.agent_id,
        status: (statuses[l.order] ?? "pending") as LegStatusLite["status"],
      }));
      return {
        trip_title: p.trip_title,
        total_amount: p.total_amount,
        currency: p.currency,
        legs,
      };
    }
    return null;
  }, [messages, legStatusesByMsg]);

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

            <a
              href="/history"
              aria-label="History"
              title="Past trips and conversations"
              className="h-8 px-2.5 rounded-md inline-flex items-center gap-1.5 text-[12.5px] text-lumo-fg-low hover:text-lumo-fg hover:bg-lumo-elevated transition-colors"
            >
              <svg
                width="12"
                height="12"
                viewBox="0 0 12 12"
                fill="none"
                aria-hidden
              >
                <circle cx="6" cy="6" r="4.5" stroke="currentColor" strokeWidth="1.4" />
                <path
                  d="M6 3.5V6l1.6 1.2"
                  stroke="currentColor"
                  strokeWidth="1.4"
                  strokeLinecap="round"
                />
              </svg>
              <span className="hidden sm:inline">History</span>
            </a>

            <ThemeToggle />
          </div>
        </div>
      </header>

      {/* ─── 3-column operator console ──────────────────────────────
          The JARVIS dashboard layout. LeftRail hides below `lg`
          (1024); RightRail hides below `xl` (1280). Center column
          always renders.
      ──────────────────────────────────────────────────────────── */}
      <div className="flex flex-1 overflow-hidden">
        <LeftRail
          onNewChat={newThread}
          currentSessionId={sessionIdRef.current}
        />

        <div className="flex flex-1 flex-col min-w-0">
      {/* ─── Thread ─────────────────────────────────────────────────── */}
      <div
        ref={scrollRef}
        className="thread flex-1 overflow-y-auto"
      >
        <div className="mx-auto w-full max-w-4xl px-6 pt-8 pb-12 space-y-6">
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
                      <div className="max-w-[82%] rounded-2xl bg-lumo-elevated text-lumo-fg px-4 py-2.5 text-[16px] leading-[1.55] whitespace-pre-wrap border border-lumo-hair">
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
            <div className="pt-8 pb-4 space-y-10 animate-fade-in relative">
              {/* Ambient accent glow behind the headline */}
              <div
                className="pointer-events-none absolute -top-16 -left-16 h-80 w-[120%] rounded-full opacity-[0.12] blur-3xl -z-10"
                style={{
                  background:
                    "radial-gradient(ellipse at 20% 30%, var(--lumo-accent) 0%, transparent 65%)",
                }}
                aria-hidden
              />

              <div className="space-y-5">
                <h1 className="text-[44px] md:text-[56px] lg:text-[64px] font-semibold tracking-[-0.025em] leading-[1.02] text-lumo-fg">
                  Plan anything,
                  <br />
                  in one{" "}
                  <span className="relative inline-block text-lumo-accent">
                    sentence
                    <span
                      className="absolute inset-x-0 -bottom-1 h-[6px] bg-lumo-accent/25 blur-md"
                      aria-hidden
                    />
                  </span>
                  .
                </h1>
                <p className="text-[17px] text-lumo-fg-mid max-w-2xl leading-relaxed">
                  Lumo is your conversational concierge. Flights, hotels, food,
                  reservations — booked by specialist agents, confirmed in one
                  place. Speak or type; it works either way.
                </p>
              </div>

              <div className="space-y-3">
                <div className="text-[12px] uppercase tracking-[0.18em] text-lumo-fg-low">
                  Try asking
                </div>
                <div className="grid sm:grid-cols-2 gap-3">
                  {SUGGESTIONS.map((s) => (
                    <button
                      key={s.label}
                      type="button"
                      onClick={() => void sendText(s.prompt)}
                      className="group text-left rounded-2xl border border-lumo-hair bg-gradient-to-br from-lumo-surface to-lumo-bg hover:from-lumo-elevated hover:to-lumo-surface hover:border-lumo-edge px-5 py-4 transition-all flex items-center justify-between gap-4"
                    >
                      <span className="text-[15px] leading-snug text-lumo-fg">
                        {s.label}
                      </span>
                      <span
                        className="text-lumo-fg-low group-hover:text-lumo-accent group-hover:translate-x-0.5 transition-all shrink-0"
                        aria-hidden
                      >
                        <svg width="16" height="16" viewBox="0 0 14 14" fill="none">
                          <path
                            d="M3 7h8m0 0-3-3m3 3-3 3"
                            stroke="currentColor"
                            strokeWidth="1.6"
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
        <div className="mx-auto w-full max-w-4xl px-6 pb-5 pt-3">
          {voiceEnabled ? (
            <div className="mb-2">
              <VoiceMode
                enabled={voiceEnabled}
                onToggle={setVoiceEnabled}
                handsFree={handsFree}
                onHandsFreeToggle={setHandsFree}
                muted={voiceMuted}
                onMutedToggle={setVoiceMuted}
                onUserUtterance={(t) => {
                  // Respect busy: a late STT result after the agent
                  // already started a new turn is dropped. The user
                  // can retry.
                  if (!busy) void sendText(t);
                }}
                spokenText={spokenStreamText}
                busy={busy}
                onStateChange={setVoiceState}
              />
            </div>
          ) : null}

          <div className="group rounded-2xl border border-lumo-hair bg-gradient-to-br from-lumo-surface to-lumo-bg focus-within:border-lumo-edge focus-within:shadow-[0_0_0_3px_rgba(94,234,172,0.08)] transition-all">
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
              className="block w-full resize-none bg-transparent px-5 pt-4 pb-1.5 text-[16.5px] leading-[1.5] text-lumo-fg placeholder:text-lumo-fg-low focus:outline-none"
              style={{ outline: "none" }}
              disabled={busy}
            />

            {/* Composer toolbar — just the voice toggle and Send.
                Attach + kbd hints were removed in #85: attach was
                dead weight ("coming soon" for months), kbd hints
                added visual noise once the composer got bigger.
                If you need the keyboard shortcut, it's ↵ to send,
                ⇧↵ for newline. */}
            <div className="flex items-center justify-between px-4 pb-3 pt-1">
              <button
                type="button"
                aria-pressed={voiceEnabled}
                aria-label={voiceEnabled ? "Turn voice off" : "Turn voice on"}
                title={voiceEnabled ? "Voice on — click to turn off" : "Turn on voice mode"}
                onClick={() => setVoiceEnabled((v) => !v)}
                className={
                  "h-9 w-9 rounded-full inline-flex items-center justify-center transition-colors " +
                  (voiceEnabled
                    ? "bg-lumo-accent/15 text-lumo-accent shadow-[0_0_12px_rgba(94,234,172,0.25)]"
                    : "text-lumo-fg-low hover:text-lumo-fg hover:bg-lumo-elevated")
                }
              >
                <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden>
                  <rect x="6" y="2" width="4" height="8.4" rx="2" stroke="currentColor" strokeWidth="1.5" />
                  <path d="M3.6 8v.6a4.4 4.4 0 0 0 8.8 0V8M8 13.6V15" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                </svg>
              </button>

              <button
                type="button"
                onClick={send}
                disabled={busy || !input.trim()}
                aria-label="Send"
                className="h-9 px-4 rounded-full inline-flex items-center gap-2 text-[14px] font-medium bg-lumo-fg text-lumo-bg hover:bg-lumo-accent hover:text-lumo-accent-ink disabled:bg-lumo-elevated disabled:text-lumo-fg-low disabled:cursor-not-allowed transition-colors"
              >
                <span>Send</span>
                <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden>
                  <path d="M3 7h8m0 0-3-3m3 3-3 3" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </button>
            </div>
          </div>
          <div className="text-[10.5px] text-lumo-fg-low text-center mt-2 tracking-wide">
            Lumo can make mistakes. Confirmations are tamper-resistant — review before booking.
          </div>
        </div>
      </div>
        </div>
        {/* ─── Right rail — live operator HUD ───────────────────── */}
        <RightRail
          activeTrip={activeTrip}
          voiceState={voiceState}
          voiceEnabled={voiceEnabled}
          voiceMuted={voiceMuted}
          onToggleVoice={() => setVoiceEnabled((v) => !v)}
          onToggleMuted={() => setVoiceMuted((m) => !m)}
          userRegion="US"
          onSuggestion={(t) => {
            if (!busy) void sendText(t);
          }}
          memoryRefreshKey={memoryRefreshKey}
        />
      </div>
    </main>
  );
}
