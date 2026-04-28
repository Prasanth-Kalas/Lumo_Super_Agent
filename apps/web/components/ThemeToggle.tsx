"use client";

/**
 * ThemeToggle — flips data-theme on <html> between "dark" and "light".
 *
 * The pre-hydration boot script in layout.tsx reads localStorage and
 * sets the attribute synchronously, so this component only needs to
 * mirror the current state and write updates back. No context, no
 * provider — the whole theme system is one attribute on <html>, read
 * by CSS variables.
 *
 * Rendered as a 28×28 icon button. The two icons are drawn inline so
 * we don't bring in an icon library just for two glyphs.
 */

import { useEffect, useState } from "react";

type Theme = "dark" | "light";

export function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>("dark");

  // Mirror whatever the boot script set. We read from the DOM rather
  // than localStorage directly so the component agrees with the
  // rendered state even if localStorage was cleared mid-session.
  useEffect(() => {
    const t = document.documentElement.getAttribute("data-theme");
    setTheme(t === "light" ? "light" : "dark");
  }, []);

  function toggle() {
    const next: Theme = theme === "dark" ? "light" : "dark";
    document.documentElement.setAttribute("data-theme", next);
    try {
      localStorage.setItem("lumo-theme", next);
    } catch {
      /* private-browsing or disabled storage — theme just doesn't persist */
    }
    setTheme(next);
  }

  return (
    <button
      type="button"
      onClick={toggle}
      aria-label={`Switch to ${theme === "dark" ? "light" : "dark"} mode`}
      title={`Switch to ${theme === "dark" ? "light" : "dark"} mode`}
      className="h-7 w-7 rounded-md inline-flex items-center justify-center text-lumo-fg-mid hover:text-lumo-fg hover:bg-lumo-elevated transition-colors"
    >
      {theme === "dark" ? (
        // Sun — simplified rays, 4x4 grid.
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden>
          <circle cx="8" cy="8" r="3" stroke="currentColor" strokeWidth="1.4" />
          <path
            d="M8 1.5v1.8M8 12.7v1.8M1.5 8h1.8M12.7 8h1.8M3.4 3.4l1.3 1.3M11.3 11.3l1.3 1.3M3.4 12.6l1.3-1.3M11.3 4.7l1.3-1.3"
            stroke="currentColor"
            strokeWidth="1.4"
            strokeLinecap="round"
          />
        </svg>
      ) : (
        // Moon — crescent, solid stroke.
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden>
          <path
            d="M13.5 10.2A5.6 5.6 0 0 1 5.8 2.5a5.6 5.6 0 1 0 7.7 7.7z"
            stroke="currentColor"
            strokeWidth="1.4"
            strokeLinejoin="round"
          />
        </svg>
      )}
    </button>
  );
}
