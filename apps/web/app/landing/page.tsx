/**
 * /landing — first-impression page for people who arrive at the root
 * domain without a deep link. Server component; zero client JS.
 *
 * WEB-DESIGN-OVERHAUL-1 — editorial flat-bold direction.
 *
 *   - Display headlines pull from `font-display` (Instrument Serif),
 *     mixed with sans body so the contrast carries the page.
 *   - Italic serif emphasis is the only "decorative" move.
 *   - Solid color BLOCKS — never gradients — for hero accents.
 *   - Generous whitespace; large, confident type scale.
 *   - Hairlines stay; depth reaches via shadow-card on key surfaces.
 *
 * The "preview" block is a tiny, honest render of the actual chat
 * turn the user will see at `/`.
 */

import Link from "next/link";
import { BrandMark, LumoWordmark } from "@/components/BrandMark";

export const metadata = {
  title: "Lumo — one app, any task",
  description:
    "Lumo plans and books your trip in one conversation. Flights, hotels, dinner — across specialist agents, one confirmation.",
};

const VALUE_PROPS: Array<{ eyebrow: string; title: string; emphasis: string; body: string }> = [
  {
    eyebrow: "Flights",
    title: "One sentence,",
    emphasis: "a real fare.",
    body: "Describe the trip. Lumo prices against a live offer pool, shows the itinerary, and only books when you say so.",
  },
  {
    eyebrow: "Food",
    title: "Skip",
    emphasis: "the app tax.",
    body: "No switching between seven delivery apps. Lumo reads the menu, builds your order, places it through the fastest merchant.",
  },
  {
    eyebrow: "Compound",
    title: "One confirmation,",
    emphasis: "all legs.",
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
      {/* Header — minimal lockup, sticks to top with hairline. */}
      <header className="sticky top-0 z-10 border-b border-lumo-hair bg-lumo-bg/85 backdrop-blur-md">
        <div className="max-w-6xl mx-auto flex items-center justify-between px-6 h-14">
          <Link href="/landing" className="flex items-center gap-2 text-lumo-fg">
            <LumoWordmark height={22} />
            <span className="text-[12.5px] text-lumo-fg-mid hidden sm:inline">
              · one app, any task
            </span>
          </Link>
          <Link
            href="/"
            className="h-9 px-4 rounded-full text-[13px] font-semibold bg-lumo-fg text-lumo-bg hover:bg-lumo-accent hover:text-lumo-accent-ink transition-colors inline-flex items-center"
          >
            Open Lumo
          </Link>
        </div>
      </header>

      {/* Hero — display serif carries the page. Solid cyan rule as the
          only color move; no gradients. */}
      <section className="max-w-6xl mx-auto px-6 pt-24 pb-20 md:pt-32 md:pb-28">
        <div className="max-w-4xl">
          <span className="inline-flex items-center gap-2 text-[10.5px] uppercase tracking-[0.18em] text-lumo-fg-mid font-medium font-mono">
            <span className="h-[2px] w-6 bg-lumo-accent" aria-hidden />
            Research preview
          </span>
          <h1 className="mt-7 font-display text-[68px] md:text-[112px] leading-[0.95] tracking-[-0.022em] text-lumo-fg">
            Plan anything,
            <br />
            <span className="italic text-lumo-accent">in one sentence.</span>
          </h1>
          <p className="mt-9 text-[17px] md:text-[19px] text-lumo-fg-mid max-w-2xl leading-[1.6]">
            Lumo is a conversational layer over specialist agents — flights,
            hotels, food, more on the way. One confirmation books everything;
            if a leg fails, Lumo rolls the rest back so you&apos;re never
            half-paid.
          </p>
          <div className="mt-10 flex flex-wrap items-center gap-3">
            <Link
              href="/"
              className="h-11 px-6 rounded-full text-[14px] font-semibold bg-lumo-fg text-lumo-bg hover:bg-lumo-accent hover:text-lumo-accent-ink transition-colors inline-flex items-center shadow-card-lift"
            >
              Try it now
            </Link>
            <a
              href="#how-it-works"
              className="h-11 px-5 rounded-full text-[14px] font-medium text-lumo-fg-mid hover:text-lumo-fg hover:bg-lumo-elevated transition-colors inline-flex items-center"
            >
              How it works →
            </a>
          </div>
        </div>
      </section>

      {/* Bold solid cyan rule — flat color block, no gradients. Acts as
          a visual divider and a brand statement. */}
      <div aria-hidden className="max-w-6xl mx-auto px-6">
        <div className="h-[6px] bg-lumo-accent rounded-full" />
      </div>

      {/* Product surface preview — honest tiny render of the actual
          chat turn at `/`. Lifts off the page with shadow-lift now,
          rounded-3xl for App Store-y polish. */}
      <section className="max-w-6xl mx-auto px-6 pt-16 pb-24">
        <div className="rounded-3xl border border-lumo-hair bg-lumo-surface overflow-hidden shadow-lift">
          <div className="flex items-center gap-1.5 px-5 h-11 border-b border-lumo-hair bg-lumo-elevated">
            <span className="h-2.5 w-2.5 rounded-full bg-lumo-fg-low" aria-hidden />
            <span className="h-2.5 w-2.5 rounded-full bg-lumo-fg-low" aria-hidden />
            <span className="h-2.5 w-2.5 rounded-full bg-lumo-fg-low" aria-hidden />
            <span className="ml-3 text-[11.5px] text-lumo-fg-mid font-mono">
              lumo.rentals/chat
            </span>
          </div>
          <div className="px-6 py-10 md:px-12 md:py-14 space-y-6">
            <div className="flex justify-end">
              <div className="max-w-[82%] rounded-2xl border border-lumo-hair bg-lumo-elevated px-4 py-2.5 text-[14.5px] text-lumo-fg leading-relaxed">
                Flight to Vegas next Friday, under $300.
              </div>
            </div>
            <div>
              <div className="flex items-center gap-1.5 text-lumo-fg-mid mb-2">
                <BrandMark size={12} />
                <span className="text-[10.5px] uppercase tracking-[0.14em] font-medium font-mono">
                  LUMO
                </span>
              </div>
              <div className="pl-[18px] text-[15px] text-lumo-fg-high leading-[1.65]">
                Found 12 offers SFO → LAS next Friday. Cheapest nonstop is{" "}
                <span className="text-lumo-fg num">Spirit NK 1202</span> at{" "}
                <span className="text-lumo-fg num">$147</span>. Want the
                breakdown, or should I pick the best direct?
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* Value props — three columns, serif italic emphasis on the
          phrase that lands. Hairline-separated, no boxes. */}
      <section className="max-w-6xl mx-auto px-6 border-t border-lumo-hair">
        <div className="grid grid-cols-1 md:grid-cols-3 md:divide-x md:divide-lumo-hair">
          {VALUE_PROPS.map((v) => (
            <div key={v.title} className="px-0 md:px-10 py-12 first:pl-0 last:pr-0">
              <div className="text-[10.5px] uppercase tracking-[0.18em] text-lumo-fg-mid font-medium font-mono">
                {v.eyebrow}
              </div>
              <h3 className="mt-4 font-display text-[30px] md:text-[34px] leading-[1.05] tracking-[-0.01em] text-lumo-fg">
                {v.title}
                <br />
                <span className="italic text-lumo-accent">{v.emphasis}</span>
              </h3>
              <p className="mt-5 text-[14px] text-lumo-fg-mid leading-[1.65]">
                {v.body}
              </p>
            </div>
          ))}
        </div>
      </section>

      {/* How it works — numbered grid. Numbers in serif italic for
          editorial weight; copy in sans for legibility. */}
      <section
        id="how-it-works"
        className="max-w-6xl mx-auto px-6 pt-24 pb-12 border-t border-lumo-hair"
      >
        <div className="text-[10.5px] uppercase tracking-[0.18em] text-lumo-fg-mid font-medium font-mono">
          Flow
        </div>
        <h2 className="mt-3 font-display text-[44px] md:text-[64px] leading-[1.0] tracking-[-0.02em] text-lumo-fg">
          How it <span className="italic text-lumo-accent">works.</span>
        </h2>
        <ol className="mt-14 divide-y divide-lumo-hair border-y border-lumo-hair">
          {HOW_IT_WORKS.map((s, i) => (
            <li
              key={s.step}
              className="py-8 md:py-10 grid grid-cols-[80px_1fr] md:grid-cols-[160px_1fr] gap-6 md:gap-12"
            >
              <div className="font-display italic text-[44px] md:text-[64px] leading-[0.9] tracking-[-0.02em] text-lumo-accent">
                {String(i + 1).padStart(2, "0")}
              </div>
              <div>
                <div className="font-display text-[26px] md:text-[34px] leading-[1.1] tracking-[-0.01em] text-lumo-fg">
                  {s.step}.
                </div>
                <p className="mt-3 text-[15px] md:text-[16px] text-lumo-fg-mid leading-[1.65] max-w-[58ch]">
                  {s.body}
                </p>
              </div>
            </li>
          ))}
        </ol>
      </section>

      {/* Closing CTA — display serif again, large and confident. */}
      <section className="max-w-6xl mx-auto px-6 pt-24 pb-28 border-t border-lumo-hair">
        <div className="max-w-3xl">
          <h2 className="font-display text-[44px] md:text-[64px] leading-[1.0] tracking-[-0.02em] text-lumo-fg">
            Start with{" "}
            <span className="italic text-lumo-accent">a single sentence.</span>
          </h2>
          <p className="mt-6 text-[16px] md:text-[17px] text-lumo-fg-mid leading-[1.65] max-w-2xl">
            No onboarding. No downloads. Just a chat — and it&apos;s free while
            we&apos;re in preview.
          </p>
          <div className="mt-9 flex items-center gap-4">
            <Link
              href="/"
              className="h-12 px-7 rounded-full text-[14.5px] font-semibold bg-lumo-fg text-lumo-bg hover:bg-lumo-accent hover:text-lumo-accent-ink transition-colors inline-flex items-center shadow-card-lift"
            >
              Open Lumo →
            </Link>
            <span className="text-[12.5px] text-lumo-fg-low">
              No credit card. No signup.
            </span>
          </div>
        </div>
      </section>

      {/* Footer — honest, tiny. */}
      <footer className="border-t border-lumo-hair">
        <div className="max-w-6xl mx-auto px-6 h-14 flex flex-wrap items-center justify-between gap-3 text-[11.5px] text-lumo-fg-mid">
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
