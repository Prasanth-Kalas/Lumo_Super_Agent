/**
 * /landing — first-impression page for people who arrive at the root
 * domain without a deep link. Server component (no "use client"), so
 * it ships zero JS and hydrates instantly — fitting for a marketing
 * surface where TTFB matters and interactivity doesn't.
 *
 * The chat lives at `/`. This page exists for the case where we want
 * to send people to a Vercel preview, a blog post, or a cold outreach
 * link without dropping them straight into an empty thread.
 *
 * Design contract:
 *   - No images yet — text-only so the deploy cost is zero and the
 *     page works offline / print / grep. Add illustrations in a later
 *     PR behind a `next/image` import.
 *   - Same color tokens as the chat (lumo-ink / paper / accent / muted)
 *     so the two surfaces feel like one product.
 *   - All CTAs go to `/` — there is no auth flow yet, and we don't
 *     want to gate exploration on sign-up.
 */

import Link from "next/link";

export const metadata = {
  title: "Lumo — one app, any task",
  description:
    "Lumo plans and books your trip in one conversation. Flights, hotels, dinner — across specialist agents, one confirmation.",
};

const VALUE_PROPS: Array<{ icon: string; title: string; body: string }> = [
  {
    icon: "✈",
    title: "Book flights in one line",
    body: "Describe the trip in plain English. Lumo prices real fares, shows you the itinerary, and only books when you say so.",
  },
  {
    icon: "🍽",
    title: "Order food without the app tax",
    body: "Skip the seven delivery apps. Lumo reads the menu, builds your order, and places it through whichever merchant has it fastest.",
  },
  {
    icon: "🏨",
    title: "Compound trips, one confirmation",
    body: "Flight + hotel + dinner on Friday. Lumo strings specialist agents together and asks you to confirm once — not three times.",
  },
];

const HOW_IT_WORKS: Array<{ step: string; body: string }> = [
  {
    step: "Ask",
    body: "Type or speak a complete intent: 'Flight to Vegas next Friday under $300, hotel near the strip, dinner Friday night.'",
  },
  {
    step: "Review",
    body: "Lumo prices every leg and surfaces one compound card with the full total. Nothing is booked yet — the card is a tamper-resistant summary.",
  },
  {
    step: "Confirm",
    body: "One click. Lumo dispatches each booking in dependency order. If a leg fails, the Saga rolls back committed legs so you never end up half-booked.",
  },
];

export default function LandingPage() {
  return (
    <main className="min-h-dvh bg-lumo-paper text-lumo-ink">
      {/* Header — same lockup as the chat shell so they feel continuous. */}
      <header className="max-w-5xl mx-auto flex items-center justify-between px-6 py-5">
        <Link href="/landing" className="flex items-center gap-2">
          <div className="h-7 w-7 rounded-full bg-lumo-accent" />
          <span className="font-semibold tracking-tight">Lumo</span>
        </Link>
        <Link
          href="/"
          className="text-sm px-4 py-2 rounded-full bg-lumo-ink text-white hover:opacity-95 transition-opacity"
        >
          Open Lumo
        </Link>
      </header>

      {/* Hero — the single promise of the product, in as few words as
          possible. No feature list above the fold; the three value
          props live one scroll down. */}
      <section className="max-w-5xl mx-auto px-6 pt-10 pb-16 md:pt-16 md:pb-24">
        <div className="max-w-3xl">
          <span className="inline-block text-[11px] uppercase tracking-widest text-lumo-muted mb-4">
            One app. Any task.
          </span>
          <h1 className="text-4xl md:text-6xl font-semibold tracking-tight leading-[1.05]">
            Plan your whole trip in{" "}
            <span className="text-lumo-accent">one sentence</span>.
          </h1>
          <p className="mt-6 text-lg md:text-xl text-lumo-muted max-w-2xl">
            Lumo is a conversational shell over specialist agents — flights,
            hotels, food, more on the way. One confirmation books everything;
            if anything fails, it rolls the rest back so you're never half-paid.
          </p>
          <div className="mt-8 flex flex-wrap gap-3">
            <Link
              href="/"
              className="h-11 px-6 rounded-full bg-lumo-ink text-white font-medium inline-flex items-center hover:opacity-95 transition-opacity"
            >
              Try it now
            </Link>
            <a
              href="#how-it-works"
              className="h-11 px-6 rounded-full bg-white border border-black/10 text-lumo-ink font-medium inline-flex items-center hover:bg-black/5 transition-colors"
            >
              How it works
            </a>
          </div>
        </div>
      </section>

      {/* Value props — three columns on desktop, stacked on mobile. */}
      <section className="max-w-5xl mx-auto px-6 py-10 border-t border-black/5">
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
          {VALUE_PROPS.map((v) => (
            <div
              key={v.title}
              className="rounded-2xl bg-white border border-black/5 p-6 shadow-sm"
            >
              <div className="h-10 w-10 rounded-full bg-lumo-paper flex items-center justify-center text-xl mb-4">
                <span aria-hidden>{v.icon}</span>
              </div>
              <h3 className="text-base font-semibold tracking-tight">{v.title}</h3>
              <p className="mt-2 text-sm text-lumo-muted leading-relaxed">
                {v.body}
              </p>
            </div>
          ))}
        </div>
      </section>

      {/* How it works — three steps. The specifics here match the
          actual product flow (compound summary → confirmation → Saga)
          so the messaging survives contact with the chat. */}
      <section
        id="how-it-works"
        className="max-w-5xl mx-auto px-6 py-16 border-t border-black/5"
      >
        <h2 className="text-2xl md:text-3xl font-semibold tracking-tight">
          How it works
        </h2>
        <ol className="mt-8 grid grid-cols-1 md:grid-cols-3 gap-6">
          {HOW_IT_WORKS.map((s, i) => (
            <li
              key={s.step}
              className="rounded-2xl bg-white border border-black/5 p-6"
            >
              <div className="text-[11px] uppercase tracking-widest text-lumo-muted">
                Step {i + 1}
              </div>
              <div className="mt-1 text-lg font-semibold tracking-tight">
                {s.step}
              </div>
              <p className="mt-3 text-sm text-lumo-muted leading-relaxed">
                {s.body}
              </p>
            </li>
          ))}
        </ol>
      </section>

      {/* Closing CTA — a second "Open Lumo" near the bottom so users
          who read all the way don't have to scroll back up. */}
      <section className="max-w-5xl mx-auto px-6 py-16 border-t border-black/5">
        <div className="rounded-3xl bg-lumo-ink text-white px-8 py-12 md:px-12 md:py-16 flex flex-col md:flex-row md:items-center md:justify-between gap-6">
          <div className="max-w-xl">
            <h2 className="text-2xl md:text-3xl font-semibold tracking-tight">
              Start with a single sentence.
            </h2>
            <p className="mt-3 text-white/70">
              No onboarding, no downloads. Just a chat — and it's free while
              we're in preview.
            </p>
          </div>
          <Link
            href="/"
            className="h-11 px-6 rounded-full bg-lumo-accent text-white font-medium inline-flex items-center justify-center hover:opacity-95 transition-opacity whitespace-nowrap"
          >
            Open Lumo →
          </Link>
        </div>
      </section>

      <footer className="max-w-5xl mx-auto px-6 py-10 text-xs text-lumo-muted flex flex-wrap items-center justify-between gap-3">
        <div>© {new Date().getFullYear()} Lumo. Research preview.</div>
        <div className="flex gap-4">
          <Link href="/" className="hover:text-lumo-ink">
            Open the app
          </Link>
          <a
            href="https://github.com/Prasanth-Kalas"
            target="_blank"
            rel="noreferrer"
            className="hover:text-lumo-ink"
          >
            GitHub
          </a>
        </div>
      </footer>
    </main>
  );
}
