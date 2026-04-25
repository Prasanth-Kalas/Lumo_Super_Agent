/**
 * /landing — first-impression page for people who arrive at the root
 * domain without a deep link. Server component (no "use client"), so
 * it ships zero JS and hydrates instantly — fitting for a marketing
 * surface where TTFB matters and interactivity doesn't.
 *
 * Design contract — Linear/Vercel editorial dark-first:
 *
 *   - Typography carries the entire hero. No value-prop tiles
 *     competing with the headline.
 *   - Three value props are laid out as a single divider-separated
 *     row (not a card grid) so nothing pretends to be interactive
 *     that isn't.
 *   - "How it works" is a numbered list, not three boxed cards.
 *   - Closing CTA is a thin rule + centered type — no glossy hero
 *     panel, no rounded-3xl wells.
 *   - The "preview" block is a tiny, honest render of the actual
 *     chat turn the user will see at `/`, so the surface advertises
 *     the product rather than a fabrication.
 *   - Color tokens match the chat surface: bg → surface → elevated,
 *     fg → fg-high → fg-mid → fg-low, single mint accent.
 *
 * Server-rendered. Zero client JS.
 */

import Link from "next/link";
import { BrandMark } from "@/components/BrandMark";

export const metadata = {
  title: "Lumo — one app, any task",
  description:
    "Lumo plans and books your trip in one conversation. Flights, hotels, dinner — across specialist agents, one confirmation.",
};

const VALUE_PROPS: Array<{ eyebrow: string; title: string; body: string }> = [
  {
    eyebrow: "Flights",
    title: "One sentence, a real fare",
    body: "Describe the trip. Lumo prices against a live offer pool, shows the itinerary, and only books when you say so.",
  },
  {
    eyebrow: "Food",
    title: "Skip the app tax",
    body: "No switching between seven delivery apps. Lumo reads the menu, builds your order, places it through the fastest merchant.",
  },
  {
    eyebrow: "Compound",
    title: "One confirmation, all legs",
    body: "Flight, hotel, dinner on Friday. Specialist agents work together; the Saga rolls back partial failures.",
  },
];

const HOW_IT_WORKS: Array<{ step: string; body: string }> = [
  {
    step: "Ask",
    body: "Type a complete intent: 'Flight to Vegas next Friday under $300, hotel near the strip, dinner Friday night.'",
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
    <main className="min-h-dvh bg-lumo-bg text-lumo-fg">
      {/* Header — same lockup as the chat shell so they feel
          continuous. Thin hairline, no shadow. */}
      <header className="sticky top-0 z-10 border-b border-lumo-hair bg-lumo-bg/80 backdrop-blur-md">
        <div className="max-w-5xl mx-auto flex items-center justify-between px-6 h-14">
          <Link href="/landing" className="flex items-center gap-2 text-lumo-fg">
            <BrandMark size={20} />
            <span className="text-[14.5px] font-semibold tracking-[-0.01em]">
              Lumo
            </span>
            <span className="text-[12.5px] text-lumo-fg-mid hidden sm:inline">
              · one app, any task
            </span>
          </Link>
          <Link
            href="/"
            className="h-8 px-3.5 rounded-md text-[12.5px] font-medium bg-lumo-fg text-lumo-bg hover:bg-lumo-accent hover:text-lumo-accent-ink transition-colors inline-flex items-center"
          >
            Open Lumo
          </Link>
        </div>
      </header>

      {/* Hero — text carries the page. No illustration, no product
          screenshot. The single mint word is the only color move. */}
      <section className="max-w-5xl mx-auto px-6 pt-20 pb-16 md:pt-28 md:pb-24">
        <div className="max-w-3xl">
          <span className="inline-flex items-center gap-2 text-[10.5px] uppercase tracking-[0.14em] text-lumo-fg-mid font-medium">
            <span className="h-1 w-1 rounded-full bg-lumo-accent" aria-hidden />
            Research preview
          </span>
          <h1 className="mt-5 text-[44px] md:text-[64px] leading-[1.04] font-semibold tracking-[-0.028em] text-lumo-fg">
            Plan anything,
            <br />
            in <span className="text-lumo-accent">one sentence</span>.
          </h1>
          <p className="mt-6 text-[16px] md:text-[17px] text-lumo-fg-mid max-w-2xl leading-[1.6]">
            Lumo is a conversational layer over specialist agents — flights,
            hotels, food, more on the way. One confirmation books everything;
            if a leg fails, Lumo rolls the rest back so you&apos;re never
            half-paid.
          </p>
          <div className="mt-8 flex flex-wrap items-center gap-3">
            <Link
              href="/"
              className="h-10 px-5 rounded-md text-[13.5px] font-medium bg-lumo-fg text-lumo-bg hover:bg-lumo-accent hover:text-lumo-accent-ink transition-colors inline-flex items-center"
            >
              Try it now
            </Link>
            <a
              href="#how-it-works"
              className="h-10 px-5 rounded-md text-[13.5px] font-medium text-lumo-fg-mid hover:text-lumo-fg hover:bg-lumo-elevated transition-colors inline-flex items-center"
            >
              How it works →
            </a>
          </div>
        </div>
      </section>

      {/* Product surface preview — a tiny, honest render of what the
          user gets at `/`. Not a marketing composite; just the thing.
          Gives the page something product-shaped without overclaiming. */}
      <section className="max-w-5xl mx-auto px-6 pb-20">
        <div className="rounded-xl border border-lumo-hair bg-lumo-surface overflow-hidden">
          <div className="flex items-center gap-1.5 px-4 h-9 border-b border-lumo-hair">
            <span className="h-2 w-2 rounded-full bg-lumo-fg-low" aria-hidden />
            <span className="h-2 w-2 rounded-full bg-lumo-fg-low" aria-hidden />
            <span className="h-2 w-2 rounded-full bg-lumo-fg-low" aria-hidden />
            <span className="ml-3 text-[11px] text-lumo-fg-mid font-mono">
              lumo.rentals/chat
            </span>
          </div>
          <div className="px-6 py-8 md:px-10 md:py-12 space-y-5">
            {/* Fake user turn */}
            <div className="flex justify-end">
              <div className="max-w-[82%] rounded-lg border border-lumo-hair bg-lumo-elevated px-3.5 py-2 text-[14px] text-lumo-fg leading-relaxed">
                Flight to Vegas next Friday, under $300.
              </div>
            </div>
            {/* Fake assistant turn */}
            <div>
              <div className="flex items-center gap-1.5 text-lumo-fg-mid mb-1.5">
                <BrandMark size={12} />
                <span className="text-[10.5px] uppercase tracking-[0.12em] font-medium font-mono">
                  LUMO
                </span>
              </div>
              <div className="pl-[18px] text-[14px] text-lumo-fg-high leading-[1.625]">
                Found 12 offers SFO → LAS next Friday. Cheapest nonstop is{" "}
                <span className="text-lumo-fg num">Spirit NK 1202</span> at{" "}
                <span className="text-lumo-fg num">$147</span>. Want the
                breakdown, or should I pick the best direct?
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* Value props — three columns, no boxes. Just typography on the
          canvas, separated by hairlines. */}
      <section className="max-w-5xl mx-auto px-6 border-t border-lumo-hair">
        <div className="grid grid-cols-1 md:grid-cols-3 md:divide-x md:divide-lumo-hair">
          {VALUE_PROPS.map((v) => (
            <div key={v.title} className="px-0 md:px-8 py-10 first:pl-0 last:pr-0">
              <div className="text-[10.5px] uppercase tracking-[0.14em] text-lumo-fg-mid font-medium">
                {v.eyebrow}
              </div>
              <h3 className="mt-3 text-[18px] font-semibold tracking-[-0.01em] text-lumo-fg">
                {v.title}
              </h3>
              <p className="mt-3 text-[13.5px] text-lumo-fg-mid leading-[1.65]">
                {v.body}
              </p>
            </div>
          ))}
        </div>
      </section>

      {/* How it works — numbered list, each step on its own row,
          hairline separators. No boxes. */}
      <section
        id="how-it-works"
        className="max-w-5xl mx-auto px-6 pt-20 pb-10 border-t border-lumo-hair"
      >
        <div className="text-[10.5px] uppercase tracking-[0.14em] text-lumo-fg-mid font-medium">
          Flow
        </div>
        <h2 className="mt-2 text-[32px] md:text-[40px] leading-[1.1] font-semibold tracking-[-0.022em] text-lumo-fg">
          How it works.
        </h2>
        <ol className="mt-10 divide-y divide-lumo-hair border-y border-lumo-hair">
          {HOW_IT_WORKS.map((s, i) => (
            <li
              key={s.step}
              className="py-6 md:py-7 grid grid-cols-[80px_1fr] md:grid-cols-[120px_1fr] gap-6 md:gap-10"
            >
              <div>
                <div className="text-[10.5px] uppercase tracking-[0.14em] text-lumo-fg-low font-medium font-mono num">
                  0{i + 1}
                </div>
                <div className="mt-1 text-[17px] md:text-[20px] font-semibold tracking-[-0.01em] text-lumo-fg">
                  {s.step}
                </div>
              </div>
              <p className="text-[14px] md:text-[15px] text-lumo-fg-mid leading-[1.65] max-w-[52ch]">
                {s.body}
              </p>
            </li>
          ))}
        </ol>
      </section>

      {/* Closing CTA — rule, type, button. No hero panel. */}
      <section className="max-w-5xl mx-auto px-6 pt-20 pb-24 border-t border-lumo-hair">
        <div className="max-w-2xl">
          <h2 className="text-[28px] md:text-[36px] leading-[1.15] font-semibold tracking-[-0.02em] text-lumo-fg">
            Start with a single sentence.
          </h2>
          <p className="mt-4 text-[15px] text-lumo-fg-mid leading-[1.6]">
            No onboarding. No downloads. Just a chat — and it&apos;s free while
            we&apos;re in preview.
          </p>
          <div className="mt-7 flex items-center gap-3">
            <Link
              href="/"
              className="h-10 px-5 rounded-md text-[13.5px] font-medium bg-lumo-fg text-lumo-bg hover:bg-lumo-accent hover:text-lumo-accent-ink transition-colors inline-flex items-center"
            >
              Open Lumo →
            </Link>
            <span className="text-[12px] text-lumo-fg-low">
              No credit card. No signup.
            </span>
          </div>
        </div>
      </section>

      {/* Footer — honest, tiny. */}
      <footer className="border-t border-lumo-hair">
        <div className="max-w-5xl mx-auto px-6 h-14 flex flex-wrap items-center justify-between gap-3 text-[11.5px] text-lumo-fg-mid">
          <div className="flex items-center gap-2">
            <BrandMark size={14} className="text-lumo-fg-mid" />
            <span>© {new Date().getFullYear()} Lumo · Research preview</span>
          </div>
          <div className="flex items-center gap-5">
            <Link href="/" className="hover:text-lumo-fg transition-colors">
              Open the app
            </Link>
            <a
              href="https://github.com/Prasanth-Kalas"
              target="_blank"
              rel="noreferrer"
              className="hover:text-lumo-fg transition-colors"
            >
              GitHub
            </a>
          </div>
        </div>
      </footer>
    </main>
  );
}
