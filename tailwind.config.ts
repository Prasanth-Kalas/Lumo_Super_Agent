import type { Config } from "tailwindcss";
import typography from "@tailwindcss/typography";

/**
 * Lumo Tailwind config — every color is a CSS var, so the light/dark
 * toggle flips the entire product without re-rendering a single node.
 *
 * The `lumo.*` namespace maps onto semantic tokens (bg / surface /
 * elevated / hair / edge / fg / fg-high / fg-mid / fg-low / accent).
 * Existing classes like `bg-lumo-surface`, `text-lumo-ink`,
 * `border-lumo-hairline` keep working — they resolve to the CSS var
 * under the hood. The old keys (`ink`, `paper`, `muted`, `hairline`,
 * `accent`, `accentDeep`) remain as aliases pointing at the new
 * tokens, so no component has to change at once.
 */
const config: Config = {
  content: [
    "./app/**/*.{ts,tsx}",
    "./components/**/*.{ts,tsx}",
    "./lib/**/*.{ts,tsx}",
  ],
  darkMode: ["class", '[data-theme="dark"]'],
  theme: {
    extend: {
      colors: {
        lumo: {
          // New semantic surface tokens
          bg:        "var(--lumo-bg)",
          surface:   "var(--lumo-surface)",
          elevated:  "var(--lumo-elevated)",
          inset:     "var(--lumo-inset)",
          hair:      "var(--lumo-hair)",
          edge:      "var(--lumo-edge)",
          fg:        "var(--lumo-fg)",
          "fg-high": "var(--lumo-fg-high)",
          "fg-mid":  "var(--lumo-fg-mid)",
          "fg-low":  "var(--lumo-fg-low)",
          accent:    "var(--lumo-accent)",
          "accent-dim": "var(--lumo-accent-dim)",
          "accent-ink": "var(--lumo-accent-ink)",
          ok:        "var(--lumo-ok)",
          warn:      "var(--lumo-warn)",
          err:       "var(--lumo-err)",

          // Back-compat aliases — the existing cards use these names.
          ink:        "var(--lumo-fg)",
          paper:      "var(--lumo-bg)",
          muted:      "var(--lumo-fg-mid)",
          hairline:   "var(--lumo-hair)",
          accentDeep: "var(--lumo-accent-dim)",
        },
        // Google-inspired palette. Used sparingly and intentionally —
        // the BrandMark, voice-state dots, source chips, success /
        // error pills. Lookups: text-g-blue, bg-g-green/15, border-g-red/30.
        "g-blue":   "var(--g-blue)",
        "g-red":    "var(--g-red)",
        "g-yellow": "var(--g-yellow)",
        "g-green":  "var(--g-green)",
      },
      fontFamily: {
        sans:    ["var(--font-sans)", "ui-sans-serif", "system-ui", "sans-serif"],
        display: ["var(--font-sans)", "ui-sans-serif", "system-ui", "sans-serif"],
        mono:    ["var(--font-mono)", "ui-monospace", "SFMono-Regular", "monospace"],
      },
      borderRadius: {
        // Restrained radius scale — rounded-3xl is never used.
        sm:    "4px",
        DEFAULT: "6px",
        md:    "6px",
        lg:    "8px",
        xl:    "10px",
        "2xl": "12px",
      },
      boxShadow: {
        // Single lift — 1px hairline + a soft diffusion. No ambient fog.
        card:          "var(--lumo-shadow)",
        cardHero:      "var(--lumo-shadow)",
        ring:          "0 0 0 1px var(--lumo-edge)",
        "ring-accent": "0 0 0 1px var(--lumo-accent)",
      },
      keyframes: {
        "fade-up": {
          "0%":   { opacity: "0", transform: "translateY(4px)" },
          "100%": { opacity: "1", transform: "translateY(0)" },
        },
        "dot-bounce": {
          "0%, 80%, 100%": { opacity: "0.35" },
          "40%":           { opacity: "1" },
        },
      },
      animation: {
        "fade-up": "fade-up 220ms cubic-bezier(0.2, 0.7, 0.2, 1) both",
        "dot-1":   "dot-bounce 1.2s ease-in-out infinite",
        "dot-2":   "dot-bounce 1.2s ease-in-out 160ms infinite",
        "dot-3":   "dot-bounce 1.2s ease-in-out 320ms infinite",
      },
    },
  },
  plugins: [typography],
};

export default config;
