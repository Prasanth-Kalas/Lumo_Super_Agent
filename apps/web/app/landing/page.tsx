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
    "Lumo's specialist agents do what your other apps do — order food, book flights, grab tickets, plan trips, post to your channels — all in one chat.",
};

const VALUE_PROPS: Array<{ eyebrow: string; title: string; emphasis: string; body: string }> = [
  {
    eyebrow: "Errands",
    title: "Order food,",
    emphasis: "without seven apps.",
    body: "Groceries, delivery, take-out, household basics. Lumo reads menus and shelves, builds the order, places it through the fastest merchant.",
  },
  {
    eyebrow: "Tickets & travel",
    title: "Book the flight,",
    emphasis: "the movie, the hotel.",
    body: "Lumo prices a flight, picks the seat, books the room, reserves the dinner — and grabs the movie ticket on the way home.",
  },
  {
    eyebrow: "Channels",
    title: "Post to your",
    emphasis: "Meta, LinkedIn, X.",
    body: "Draft the caption, schedule the cross-post, reply to the comments. The same conversation that booked your flight runs your launch.",
  },
];

const HOW_IT_WORKS: Array<{ step: string; body: string }> = [
  {
    step: "Ask",
    body: "Type a complete intent: 'Order Thai for two by 7, book the IMAX showing of Dune at 9:30, and post the launch teaser to LinkedIn at 8.'",
  },
  {
    step: "Review",
    body: "Lumo plans the work, picks the right specialist agent for each step, and surfaces one card with the full breakdown. Nothing is committed yet — the card is a tamper-resistant summary.",
  },
  {
    step: "Confirm",
    body: "One click. Lumo dispatches each agent in dependency order. If a step fails, the Saga rolls back committed steps so you never end up half-done.",
  },
];

export default function LandingPage() {
  return (
    <main className="min-h-dvh bg-lumo-bg text-lumo-fg">
      {/* Header — minimal lockup, sticks to top with hairline. */}
      <header className="sticky top-0 z-10 border-b border-lumo-hair bg-lumo-bg/85 backdrop-blur-md">
        <div className="flex w-full items-center justify-between px-6 h-14">
          <Link href="/landing" className="flex items-center gap-2 text-lumo-fg">
            <LumoWordmark height={22} />
            <span className="text-[12.5px] text-lumo-fg-mid hidden sm:inline">
              · one app, any task
            </span>
          </Link>
          <nav className="flex items-center gap-1">
            <Link
              href="/developer"
              className="h-9 px-3 rounded-full text-[13px] font-medium text-lumo-fg-mid hover:text-lumo-fg hover:bg-lumo-elevated transition-colors inline-flex items-center"
            >
              Developer
            </Link>
            <a
              href="https://docs.lumo.rentals"
              target="_blank"
              rel="noreferrer"
              className="h-9 px-3 rounded-full text-[13px] font-medium text-lumo-fg-mid hover:text-lumo-fg hover:bg-lumo-elevated transition-colors inline-flex items-center"
            >
              Docs
            </a>
            <Link
              href="/"
              className="ml-1 h-9 px-4 rounded-full text-[13px] font-semibold bg-lumo-fg text-lumo-bg hover:bg-lumo-accent hover:text-lumo-accent-ink transition-colors inline-flex items-center"
            >
              Open Lumo
            </Link>
          </nav>
        </div>
      </header>

      {/* Hero — display serif carries the page. No eyebrow / dash-line
          accents; the headline IS the page. */}
      <section className="max-w-6xl mx-auto px-6 pt-24 pb-20 md:pt-32 md:pb-28">
        <div className="max-w-4xl">
          <h1 className="font-display text-[68px] md:text-[112px] leading-[0.95] tracking-[-0.022em] text-lumo-fg">
            Plan anything,
            <br />
            <span className="italic text-lumo-accent">in one sentence.</span>
          </h1>
          <p className="mt-9 text-[17px] md:text-[19px] text-lumo-fg-mid max-w-2xl leading-[1.6]">
            Lumo&apos;s specialist agents do what your other apps do — order
            food, book a flight, grab tickets, plan a trip, post to your
            channels. One conversation handles them all; if any step fails,
            Lumo rolls the rest back so you&apos;re never half-done.
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

      {/* Product surface preview — honest tiny render of the actual
          chat turn at `/`. Lifts off the page with shadow-lift,
          rounded-3xl for App Store-y polish. */}
      <section className="max-w-6xl mx-auto px-6 pb-24">
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
                Order Thai for two by 7, and post the launch teaser to LinkedIn at 8.
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
                Pad thai + green curry from{" "}
                <span className="text-lumo-fg">Lotus of Siam</span>, ETA{" "}
                <span className="text-lumo-fg num">6:54 PM</span> · LinkedIn
                post drafted with last week&apos;s preview reel — review
                before I schedule?
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
              <h3 className="font-display text-[30px] md:text-[34px] leading-[1.05] tracking-[-0.01em] text-lumo-fg">
                {v.title}
                <br />
                <span className="italic text-lumo-accent">{v.emphasis}</span>
              </h3>
              <p className="mt-5 text-[14px] text-lumo-fg-mid leading-[1.65]">
                {v.body}
              </p>
              <div className="mt-6 text-[12.5px] text-lumo-fg-low">
                {v.eyebrow}
              </div>
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
        <h2 className="font-display text-[44px] md:text-[64px] leading-[1.0] tracking-[-0.02em] text-lumo-fg">
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
