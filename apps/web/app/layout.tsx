import type { Metadata, Viewport } from "next";
import { Inter, Instrument_Serif, JetBrains_Mono } from "next/font/google";
import "./globals.css";

/**
 * Inter at the weights we actually use. 400/500/600/700 — extra
 * weights slow first paint for no visible gain in a chat UI. JetBrains
 * Mono is used for hashes, kbd chips, and the deterministic fields
 * on confirmation cards.
 *
 * WEB-DESIGN-OVERHAUL-1 — Instrument Serif joins the family as the
 * `--font-display` value. Used only for hero/editorial copy on
 * landing, login, and section heroes; body text stays Inter so the
 * chat surface keeps its current voice.
 */
const sans = Inter({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  variable: "--font-sans",
  display: "swap",
});

const display = Instrument_Serif({
  subsets: ["latin"],
  weight: ["400"],
  style: ["normal", "italic"],
  variable: "--font-display",
  display: "swap",
});

const mono = JetBrains_Mono({
  subsets: ["latin"],
  weight: ["400", "500"],
  variable: "--font-mono",
  display: "swap",
});

export const metadata: Metadata = {
  title: "Lumo — one app, any task",
  description:
    "Lumo's specialist agents do what your other apps do — order food, book flights, grab tickets, plan trips, post to your channels — all in one chat.",
  icons: { icon: "/icon.svg" },
  openGraph: {
    title: "Lumo — one app, any task",
    description:
      "One conversation. Order, book, post, plan — handled by specialist agents working together.",
    type: "website",
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
  // Matches --lumo-bg in the dark theme so the mobile chrome disappears
  // into the app canvas. Flipped by the client-side theme toggle in-app.
  themeColor: "#07080A",
};

/**
 * Root layout. `data-theme="dark"` is the default; a client-side
 * toggle flips it to "light" by writing the same attribute. Nothing
 * in the tree reads theme directly — every surface color is a CSS
 * variable defined in globals.css.
 *
 * `suppressHydrationWarning` on <html> is required because the toggle
 * reads localStorage before hydration to avoid a flash-of-wrong-theme,
 * which means the server-rendered attribute may differ from the final
 * client attribute. That's expected; no dynamic children care.
 */
export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html
      lang="en"
      data-theme="dark"
      className={`${sans.variable} ${display.variable} ${mono.variable}`}
      suppressHydrationWarning
    >
      <head>
        {/* Pre-hydration theme boot — reads localStorage and sets the
            `data-theme` attribute synchronously so the first paint is
            correct. Runs before React hydrates; safe to be inline. */}
        <script
          dangerouslySetInnerHTML={{
            __html: `
              (function () {
                try {
                  var t = localStorage.getItem('lumo-theme');
                  if (t === 'light' || t === 'dark') {
                    document.documentElement.setAttribute('data-theme', t);
                  }
                } catch (e) {}
              })();
            `,
          }}
        />
      </head>
      <body className="font-sans antialiased bg-lumo-bg text-lumo-fg-high">
        {children}
      </body>
    </html>
  );
}
