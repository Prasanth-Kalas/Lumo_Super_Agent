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
import MobileNav from "@/components/MobileNav";
import { seedProfile } from "@/lib/seed-profile";

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

// Starter suggestion cards were removed — the personalized hello
// from the assistant ("Hey Alex! Good morning. I can book flights,
// order food, reserve hotels…") carries the same discovery intent
// without stealing focus from the composer.

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
  // Mobile drawer open/close.
  const [mobileNavOpen, setMobileNavOpen] = useState<boolean>(false);
  // Auth'd user (id/email/full_name/first_name) — populated from
  // /api/me on mount. Null while loading or when signed out.
  const [me, setMe] = useState<{
    id: string;
    email: string | null;
    full_name: string | null;
    first_name: string | null;
  } | null>(null);

  useEffect(() => {
    // Fetch the auth user once on mount. When signed in, trigger the
    // idempotent profile seed so timezone/language/display_name land
    // on the first turn. When signed out, /api/me 401s and we leave
    // me=null.
    void (async () => {
      try {
        const res = await fetch("/api/me", { cache: "no-store" });
        if (!res.ok) return;
        const j = (await res.json()) as {
          user?: {
            id: string;
            email: string | null;
            full_name: string | null;
            first_name: string | null;
          };
        };
        if (j.user) {
          setMe(j.user);
          // Fire-and-forget — the seed helper is itself idempotent
          // and gated by sessionStorage.
          void seedProfile();
        }
      } catch {
        /* ignore — sign-out or network blip */
      }
    })();
  }, []);

  // Personalize the opening hello with the user's first name AND
  // device-local time of day (Good morning / afternoon / evening).
  // We mutate the "hello" message content in place so the generic
  // scaffold swaps to a warm, time-aware greeting within a beat of
  // the page loading — but only if it still reads as the scaffold
  // (never overwrite a user's own turn or an in-flight reply).
  //
  // Time-of-day buckets use local wall-clock, not UTC: 05:00–11:59
  // morning, 12:00–16:59 afternoon, 17:00–21:59 evening, else night.
  // These boundaries match how people actually greet each other;
  // adjust here if we ever want regional variants.
  useEffect(() => {
    if (!me?.first_name) return;
    const greeting = `Hey ${me.first_name}! ${timeOfDayGreeting(new Date())} I can book flights, order food, reserve hotels, and string them together into a single trip. What do you need?`;
    setMessages((prev) =>
      prev.map((m) =>
        m.id === "hello" &&
        (m.content.startsWith("I can book flights") ||
          m.content.startsWith(`Hey ${me.first_name}`))
          ? { ...m, content: greeting }
          : m,
      ),
    );
  }, [me?.first_name]);
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
  // Session identity for this tab.
  //
  // On first paint we read ?session=<uuid> from the URL and adopt it
  // as our session_id if present — this is how /history's "Open
  // conversation" button attaches new messages to an existing
  // thread in the audit log rather than spawning an orphan
  // session. If the query param is missing or malformed we fall
  // back to a fresh random UUID (or a timestamp if the crypto API
  // isn't around — mobile webviews). Message replay from
  // /api/events is a separate ticket; for now we only pin the ID.
  //
  // ⚠︎ SSR-safety: the old implementation computed this in a lazy
  // ref initializer that read window.location + crypto.randomUUID()
  // at render time. The server produced UUID #1; the client hydrated
  // with UUID #2; anywhere the ref flowed into rendered attributes
  // (e.g. LeftRail's currentSessionId prop → session row aria-current)
  // React saw mismatched markup and threw hydration errors #425/#418/
  // #423 in production. We now start BOTH the state and the ref at
  // "" so server and client first-render agree, then populate from
  // ?session=… or a fresh UUID in a mount effect — which only runs
  // after hydration, avoiding the mismatch entirely.
  const sessionIdRef = useRef<string>("");
  const [sessionId, setSessionId] = useState<string>("");
  useEffect(() => {
    let id = "";
    try {
      const fromUrl = new URL(window.location.href).searchParams.get(
        "session",
      );
      if (fromUrl && /^[0-9a-fA-F-]{8,}$/.test(fromUrl)) id = fromUrl;
    } catch {
      /* ignore */
    }
    if (!id) {
      id =
        typeof crypto !== "undefined" && "randomUUID" in crypto
          ? crypto.randomUUID()
          : String(Date.now());
    }
    sessionIdRef.current = id;
    setSessionId(id);
  }, []);

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
            const rawChunk = String(frame.value ?? "");
            // Claude sometimes emits consecutive text blocks with no
            // whitespace between them — e.g. an ack + the main
            // response, where the tail of block 1 ends "...now!" and
            // block 2 starts "Got a few...". Result: "now!Got".
            // Fix: if the new chunk starts with a capital letter and
            // the accumulated text ends with sentence punctuation
            // without trailing whitespace, insert a space.
            const needsSpace =
              /[.!?](["')\]]*)$/.test(assistantText) && /^[A-Z]/.test(rawChunk);
            const chunk = needsSpace ? " " + rawChunk : rawChunk;
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
    const fresh =
      typeof crypto !== "undefined" && "randomUUID" in crypto
        ? crypto.randomUUID()
        : String(Date.now());
    sessionIdRef.current = fresh;
    // Mirror the ref into state so LeftRail re-renders with the new
    // id and the session-row highlight stays in sync.
    setSessionId(fresh);
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
        <div className="mx-auto flex w-full max-w-4xl items-center justify-between px-4 sm:px-5 py-3">
          <div className="flex items-center gap-2.5">
            {/* Mobile-only hamburger. Hidden on lg+ where LeftRail is visible. */}
            <button
              type="button"
              onClick={() => setMobileNavOpen(true)}
              aria-label="Open menu"
              className="lg:hidden h-9 w-9 -ml-1 rounded-full inline-flex items-center justify-center text-lumo-fg hover:bg-lumo-elevated transition-colors"
            >
              <svg width="18" height="18" viewBox="0 0 18 18" fill="none" aria-hidden>
                <path
                  d="M3 5h12M3 9h12M3 13h12"
                  stroke="currentColor"
                  strokeWidth="1.8"
                  strokeLinecap="round"
                />
              </svg>
            </button>

            <BrandMark size={22} className="text-lumo-fg" />
            <div className="flex items-baseline gap-2">
              <span className="text-[15px] font-semibold tracking-tight text-lumo-fg">
                Lumo
              </span>
              <span className="hidden sm:inline text-[11px] text-lumo-fg-low tracking-wide">
                one app · any task
              </span>
            </div>
          </div>

          <div className="flex items-center gap-1.5">
            {/* Model / status chip REMOVED — end users don't need to
                see the model name or a green dot. If we want runtime
                health back, expose it in the right-rail HUD where
                power users look. */}

            {/* Desktop nav buttons — hidden on mobile (drawer owns these). */}
            <button
              type="button"
              onClick={newThread}
              aria-label="New thread"
              title="New thread"
              className="hidden sm:inline-flex h-8 px-2.5 rounded-md items-center gap-1.5 text-[12.5px] text-lumo-fg-mid hover:text-lumo-fg hover:bg-lumo-elevated transition-colors"
            >
              <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden>
                <path d="M6 2.5v7M2.5 6h7" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
              </svg>
              <span>New</span>
            </button>

            <a
              href="/history"
              aria-label="History"
              title="Past trips and conversations"
              className="hidden sm:inline-flex h-8 px-2.5 rounded-md items-center gap-1.5 text-[12.5px] text-lumo-fg-low hover:text-lumo-fg hover:bg-lumo-elevated transition-colors"
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
              <span>History</span>
            </a>

            {/* Auth chip — three states:
                  • env not wired → render nothing (dev / stub deploy)
                  • env wired, signed out → "Sign in" link
                  • env wired, signed in → circular initial chip
                    linking to /memory (shows full name + email there).
                Hides on mobile; drawer owns that surface. */}
            {process.env.NEXT_PUBLIC_SUPABASE_URL ? (
              me ? (
                <a
                  href="/memory"
                  aria-label={
                    me.full_name
                      ? `Signed in as ${me.full_name}`
                      : `Signed in as ${me.email ?? "you"}`
                  }
                  title={me.email ?? me.full_name ?? "Account"}
                  className="hidden sm:inline-flex h-8 w-8 rounded-full items-center justify-center bg-lumo-elevated border border-lumo-hair text-[12px] font-semibold text-lumo-fg hover:bg-lumo-surface transition-colors"
                >
                  {initialFor(me.first_name, me.full_name, me.email)}
                </a>
              ) : (
                <a
                  href="/login"
                  aria-label="Sign in"
                  className="hidden sm:inline-flex h-8 px-3 rounded-md items-center text-[12.5px] font-medium text-lumo-fg hover:bg-lumo-elevated transition-colors"
                >
                  Sign in
                </a>
              )
            ) : null}

            <ThemeToggle />
          </div>
        </div>
      </header>

      {/* Mobile drawer — slides over the chat. Invisible on lg+. */}
      <MobileNav
        open={mobileNavOpen}
        onClose={() => setMobileNavOpen(false)}
        onNewChat={newThread}
      />

      {/* ─── 3-column operator console ──────────────────────────────
          The JARVIS dashboard layout. LeftRail hides below `lg`
          (1024); RightRail hides below `xl` (1280). Center column
          always renders.
      ──────────────────────────────────────────────────────────── */}
      <div className="flex flex-1 overflow-hidden">
        <LeftRail
          onNewChat={newThread}
          currentSessionId={sessionId || null}
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
              Clean personalized hero — one greeting line tied to the
              user's first name and time of day, a short subline, and
              that's it. No starter suggestions (low signal, high
              noise) and no editorial headline that competes with the
              real hello the assistant just delivered. The first
              assistant "hello" message (rendered by the normal
              message loop above) IS the greeting; this block is
              just the ambient backdrop for the thread before the
              user speaks. */}
          {isEmpty && (
            <div
              className="pt-10 pb-2 animate-fade-in relative"
              aria-hidden
            >
              <div
                className="pointer-events-none absolute -top-20 -left-20 h-80 w-[120%] rounded-full opacity-[0.10] blur-3xl -z-10"
                style={{
                  background:
                    "radial-gradient(ellipse at 20% 30%, var(--lumo-accent) 0%, transparent 65%)",
                }}
              />
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
          {/* Composer footnote removed — the confirmation cards are
              the trust surface, not a line of fine print. Legal /
              safety copy lives on /landing and /memory. */}
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

      {/* Post-sign-in location prompt — renders nothing until we have
          an authed user AND a profile fetch confirms no home_address
          yet. Self-dismisses on save / "not now" / esc. */}
      {me ? <LocationPrompt userId={me.id} /> : null}
    </main>
  );
}

// ──────────────────────────────────────────────────────────────────────
// Local helpers
// ──────────────────────────────────────────────────────────────────────

/**
 * "Good morning." / "Good afternoon." / "Good evening." based on the
 * device's wall-clock hour. Returned with a trailing space-friendly
 * period so the greeting sentence reads naturally when concatenated.
 *
 * Buckets chosen to match conversational English, not astronomical
 * definitions: 05–11 morning, 12–16 afternoon, 17–21 evening, else
 * we fall back to "evening" (nobody greets at 2 a.m. with "good
 * night"; it reads as a farewell).
 */
function timeOfDayGreeting(now: Date): string {
  const h = now.getHours();
  if (h >= 5 && h < 12) return "Good morning.";
  if (h >= 12 && h < 17) return "Good afternoon.";
  return "Good evening.";
}

/**
 * One-character initial for the auth chip. Prefers first name, then
 * the first letter of full name, then the first letter of the email
 * local-part, then "·" as a last resort. Always uppercase.
 */
function initialFor(
  firstName: string | null,
  fullName: string | null,
  email: string | null,
): string {
  const src =
    (firstName && firstName.trim()) ||
    (fullName && fullName.trim()) ||
    (email && email.split("@")[0]) ||
    "";
  const ch = src.charAt(0);
  return ch ? ch.toUpperCase() : "·";
}

/**
 * Post-sign-in location prompt. Checks once whether the user's
 * profile has a home_address; if not, slides in a dismissible card
 * asking for "current location" (geolocation) or a typed place.
 *
 * Why here and not always-on: we want to ask exactly once per user
 * per device — nagging people every mount is worse than missing the
 * signal. State:
 *
 *   "checking"  → fetching /api/memory to see if home_address exists
 *   "hidden"    → profile already has it, or user dismissed this
 *                 session
 *   "prompt"    → showing the card
 *   "saving"    → PATCH in flight
 *
 * Dismissal is sticky per user per device via localStorage
 * ("lumo.locationPromptDismissed.v1:<userId>") so a reload doesn't
 * re-ask. A server-side "dismissed" flag would be stronger; for now
 * a local flag is good enough and keeps the first-login experience
 * from feeling nosy.
 */
function LocationPrompt({ userId }: { userId: string }) {
  type Phase = "checking" | "hidden" | "prompt" | "saving";
  const [phase, setPhase] = useState<Phase>("checking");
  const [manual, setManual] = useState("");
  const [err, setErr] = useState<string | null>(null);

  const dismissKey = `lumo.locationPromptDismissed.v1:${userId}`;

  useEffect(() => {
    // Short-circuit if dismissed for this user on this device.
    try {
      if (window.localStorage.getItem(dismissKey) === "1") {
        setPhase("hidden");
        return;
      }
    } catch {
      /* ignore */
    }

    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch("/api/memory", { cache: "no-store" });
        if (!res.ok) {
          // Signed out or error — don't render.
          if (!cancelled) setPhase("hidden");
          return;
        }
        const j = (await res.json()) as {
          profile?: { home_address?: unknown } | null;
        };
        const hasHome =
          j.profile &&
          j.profile.home_address &&
          typeof j.profile.home_address === "object";
        if (!cancelled) setPhase(hasHome ? "hidden" : "prompt");
      } catch {
        if (!cancelled) setPhase("hidden");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [dismissKey]);

  function dismiss(remember = true) {
    if (remember) {
      try {
        window.localStorage.setItem(dismissKey, "1");
      } catch {
        /* ignore */
      }
    }
    setPhase("hidden");
  }

  async function saveHome(payload: Record<string, unknown>) {
    setPhase("saving");
    setErr(null);
    try {
      const res = await fetch("/api/memory/profile", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ home_address: payload }),
      });
      if (!res.ok) {
        setErr("Couldn't save location. Try again?");
        setPhase("prompt");
        return;
      }
      dismiss(true);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      setPhase("prompt");
    }
  }

  async function saveCurrentLocation() {
    if (typeof navigator === "undefined" || !navigator.geolocation) {
      setErr("This browser doesn't support location.");
      return;
    }
    setErr(null);
    await new Promise<void>((resolve) => {
      navigator.geolocation.getCurrentPosition(
        (pos) => {
          void saveHome({
            label: "Current location",
            coords: {
              lat: pos.coords.latitude,
              lng: pos.coords.longitude,
            },
          }).finally(() => resolve());
        },
        (e) => {
          setErr(
            e.code === 1
              ? "Location permission denied. You can type it instead."
              : "Couldn't read location. Try typing it.",
          );
          resolve();
        },
        { timeout: 8000, maximumAge: 5 * 60 * 1000 },
      );
    });
  }

  async function saveManual(e: React.FormEvent) {
    e.preventDefault();
    const label = manual.trim();
    if (!label) return;
    await saveHome({ label });
  }

  if (phase === "hidden" || phase === "checking") return null;

  return (
    <div className="fixed inset-x-0 bottom-4 z-40 px-4 sm:px-6 flex justify-center pointer-events-none">
      <div
        role="dialog"
        aria-label="Share your location"
        className="pointer-events-auto w-full max-w-md rounded-2xl border border-lumo-hair bg-lumo-surface/95 backdrop-blur-md shadow-lg p-4 sm:p-5 animate-fade-up"
      >
        <div className="flex items-start gap-3">
          <div className="h-8 w-8 shrink-0 rounded-full bg-lumo-accent/10 text-lumo-accent inline-flex items-center justify-center">
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden>
              <path
                d="M8 14s5-4.5 5-8.3A5 5 0 0 0 3 5.7C3 9.5 8 14 8 14Z"
                stroke="currentColor"
                strokeWidth="1.4"
                strokeLinejoin="round"
              />
              <circle cx="8" cy="5.8" r="1.6" stroke="currentColor" strokeWidth="1.4" />
            </svg>
          </div>
          <div className="flex-1 min-w-0">
            <div className="text-[14px] font-medium text-lumo-fg">
              Where are you based?
            </div>
            <div className="text-[12.5px] text-lumo-fg-mid mt-0.5 leading-snug">
              Helps Lumo find nearby food, suggest flights from the
              right airport, and estimate drive times. You can change
              it anytime in Memory.
            </div>

            <form onSubmit={saveManual} className="mt-3 space-y-2.5">
              <input
                type="text"
                value={manual}
                onChange={(ev) => setManual(ev.target.value)}
                placeholder="City or neighborhood — e.g. Austin, TX"
                className="w-full rounded-md border border-lumo-hair bg-lumo-bg px-3 py-2 text-[13.5px] text-lumo-fg placeholder:text-lumo-fg-low focus:border-lumo-edge outline-none"
                disabled={phase === "saving"}
                autoFocus
              />

              {err ? (
                <div className="text-[11.5px] text-red-500">{err}</div>
              ) : null}

              <div className="flex items-center gap-2">
                <button
                  type="submit"
                  disabled={phase === "saving" || !manual.trim()}
                  className="h-8 px-3 rounded-md bg-lumo-fg text-lumo-bg text-[12.5px] font-medium hover:bg-lumo-accent hover:text-lumo-accent-ink disabled:bg-lumo-elevated disabled:text-lumo-fg-low transition-colors"
                >
                  {phase === "saving" ? "Saving…" : "Save"}
                </button>
                <button
                  type="button"
                  onClick={() => void saveCurrentLocation()}
                  disabled={phase === "saving"}
                  className="h-8 px-3 rounded-md border border-lumo-hair bg-lumo-bg text-[12.5px] text-lumo-fg hover:bg-lumo-elevated transition-colors inline-flex items-center gap-1.5"
                >
                  <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden>
                    <circle cx="6" cy="6" r="2" stroke="currentColor" strokeWidth="1.3" />
                    <path
                      d="M6 1v1.5M6 9.5V11M1 6h1.5M9.5 6H11"
                      stroke="currentColor"
                      strokeWidth="1.3"
                      strokeLinecap="round"
                    />
                  </svg>
                  Use current
                </button>
                <button
                  type="button"
                  onClick={() => dismiss(true)}
                  disabled={phase === "saving"}
                  className="ml-auto h-8 px-2 text-[12px] text-lumo-fg-low hover:text-lumo-fg transition-colors"
                >
                  Not now
                </button>
              </div>
            </form>
          </div>
        </div>
      </div>
    </div>
  );
}
