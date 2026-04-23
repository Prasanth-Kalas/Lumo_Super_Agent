"use client";

/**
 * The Lumo shell home screen. One chat thread, one mic button, one
 * confirmation card when the orchestrator emits a structured summary.
 * Voice is stubbed for v0 — wired up against the Realtime API in the
 * next PR.
 */

import { useEffect, useRef, useState } from "react";
import {
  ItineraryConfirmationCard,
  type ItineraryPayload,
} from "@/components/ItineraryConfirmationCard";

/**
 * Local mirror of the shell's ConfirmationSummary — we re-declare it
 * here rather than importing from the SDK so the client bundle stays
 * free of node:crypto. Shape must match
 * packages/agent-sdk/src/confirmation.ts :: ConfirmationSummary.
 */
interface UISummary {
  kind: "structured-cart" | "structured-itinerary" | "structured-booking";
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

export default function Home() {
  const [messages, setMessages] = useState<UIMessage[]>([
    {
      id: "hello",
      role: "assistant",
      content:
        "Hi — I'm Lumo. I can order food, book flights, and more as we add agents. What do you need?",
    },
  ]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
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

  return (
    <main className="flex h-dvh flex-col mx-auto w-full max-w-2xl">
      <header className="flex items-center justify-between px-5 py-4">
        <div className="flex items-center gap-2">
          <div className="h-7 w-7 rounded-full bg-lumo-accent" />
          <span className="font-semibold tracking-tight">Lumo</span>
        </div>
        <span className="text-xs text-lumo-muted">one app. any task.</span>
      </header>

      <div
        ref={scrollRef}
        className="thread flex-1 overflow-y-auto px-5 pb-4 space-y-3"
      >
        {messages.map((m) => {
          const isItinerary =
            m.role === "assistant" &&
            m.summary?.kind === "structured-itinerary";
          const decided = isItinerary ? userMessageExistsAfter(m.id) : null;

          return (
            <div key={m.id} className="space-y-2">
              {m.content ? (
                <div
                  className={
                    m.role === "user"
                      ? "ml-auto max-w-[85%] rounded-2xl bg-lumo-ink text-white px-4 py-2 whitespace-pre-wrap"
                      : "mr-auto max-w-[85%] rounded-2xl bg-white border border-black/5 px-4 py-2 whitespace-pre-wrap"
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
            </div>
          );
        })}
        {busy && (
          <div className="mr-auto max-w-[85%] rounded-2xl bg-white border border-black/5 px-4 py-2 text-lumo-muted">
            Lumo is thinking…
          </div>
        )}
      </div>

      <div className="border-t border-black/5 p-3 flex items-end gap-2">
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
          className="h-11 w-11 rounded-full bg-white border border-black/10 flex items-center justify-center hover:bg-black/5"
          disabled
        >
          <span className="text-lg">🎙</span>
        </button>
        <button
          type="button"
          onClick={send}
          disabled={busy || !input.trim()}
          className="h-11 px-4 rounded-full bg-lumo-ink text-white disabled:opacity-40"
        >
          Send
        </button>
      </div>
    </main>
  );
}
