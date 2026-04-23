import type { Config } from "tailwindcss";
import typography from "@tailwindcss/typography";

const config: Config = {
  content: [
    "./app/**/*.{ts,tsx}",
    "./components/**/*.{ts,tsx}",
    "./lib/**/*.{ts,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        lumo: {
          ink: "#0B0E14",
          // Warm off-white paper + a slightly lifted surface the chat
          // bubbles sit on. Two tones matter — one flat background can't
          // carry depth without shadows, and shadows look heavy on chat.
          paper: "#F7F7F5",
          surface: "#FFFFFF",
          accent: "#FF6B2C",
          // Tuned-up secondary accent for hover states + "live" dots.
          accentDeep: "#E85A1B",
          muted: "#8A8F99",
          // Hairline border used on cards — darker than default border-black/5
          // so edges read cleanly on warm paper without feeling heavy.
          hairline: "rgba(11, 14, 20, 0.08)",
        },
      },
      fontFamily: {
        sans: ["var(--font-sans)", "ui-sans-serif", "system-ui", "sans-serif"],
        display: ["var(--font-sans)", "ui-sans-serif", "system-ui", "sans-serif"],
        mono: ["var(--font-mono)", "ui-monospace", "SFMono-Regular", "monospace"],
      },
      boxShadow: {
        // Lumo cards sit on paper — default md shadows look too ambient.
        // This is a tight, offset-down shadow that reads as "lifted but
        // not floating".
        card: "0 1px 2px rgba(11,14,20,0.04), 0 8px 24px -12px rgba(11,14,20,0.10)",
        // A deeper shadow for the active confirmation card so the eye
        // lands there first.
        cardHero: "0 1px 3px rgba(11,14,20,0.06), 0 24px 48px -20px rgba(11,14,20,0.18)",
      },
      keyframes: {
        "fade-up": {
          "0%": { opacity: "0", transform: "translateY(6px)" },
          "100%": { opacity: "1", transform: "translateY(0)" },
        },
        "dot-bounce": {
          "0%, 80%, 100%": { transform: "translateY(0)", opacity: "0.5" },
          "40%": { transform: "translateY(-3px)", opacity: "1" },
        },
      },
      animation: {
        "fade-up": "fade-up 260ms cubic-bezier(0.2, 0.8, 0.2, 1) both",
        "dot-1": "dot-bounce 1.1s ease-in-out infinite",
        "dot-2": "dot-bounce 1.1s ease-in-out 150ms infinite",
        "dot-3": "dot-bounce 1.1s ease-in-out 300ms infinite",
      },
    },
  },
  plugins: [typography],
};

export default config;
