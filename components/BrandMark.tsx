/**
 * Lumo brand marks — two components.
 *
 *   <BrandMark size={N} />       Square-tile icon (the small L+dot
 *                                mark). Used for chips, message
 *                                prefixes, buttons. Backwards
 *                                compatible — every existing caller
 *                                keeps working.
 *
 *   <LumoWordmark height={N} /> Full chunky "LUMO" wordmark, drawn
 *                               in Google blue with a diagonal
 *                               shine band. Use in headers and
 *                               anywhere the brand should be the
 *                               focal element.
 *
 * The wordmark + small icon work as a family — both blue body, both
 * geometric, same visual weight per unit area. Headers should use
 * one OR the other, never both.
 */

// ─── Square-tile icon ─────────────────────────────────────────

export function BrandMark({
  size = 22,
  className = "",
  monochrome = false,
}: {
  size?: number;
  className?: string;
  monochrome?: boolean;
}) {
  if (monochrome) {
    return (
      <span
        className={`inline-flex items-center justify-center ${className}`}
        style={{ width: size, height: size }}
        aria-hidden
      >
        <svg
          width={size}
          height={size}
          viewBox="0 0 22 22"
          fill="none"
          xmlns="http://www.w3.org/2000/svg"
        >
          <rect
            x="1"
            y="1"
            width="20"
            height="20"
            rx="6"
            stroke="currentColor"
            strokeOpacity="0.18"
            strokeWidth="1"
          />
          <path
            d="M7 6v10h6.5"
            stroke="currentColor"
            strokeWidth="1.7"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          <circle cx="15.6" cy="16" r="1.3" fill="currentColor" />
        </svg>
      </span>
    );
  }

  return (
    <span
      className={`inline-flex items-center justify-center ${className}`}
      style={{ width: size, height: size }}
      aria-hidden
    >
      <svg
        width={size}
        height={size}
        viewBox="0 0 22 22"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
      >
        <rect
          x="1"
          y="1"
          width="20"
          height="20"
          rx="6"
          fill="var(--lumo-surface)"
          stroke="var(--g-blue)"
          strokeOpacity="0.4"
          strokeWidth="1"
        />
        <path
          d="M7 6v10"
          stroke="var(--g-blue)"
          strokeWidth="2"
          strokeLinecap="round"
        />
        <path
          d="M7 16h7"
          stroke="var(--g-blue)"
          strokeWidth="2"
          strokeLinecap="round"
        />
        <circle cx="15.6" cy="16" r="1.5" fill="var(--g-red)" />
      </svg>
    </span>
  );
}

// ─── Full LUMO wordmark ───────────────────────────────────────

/**
 * "LUMO" wordmark. Each glyph is a chunky rounded-rect block,
 * spelled out left-to-right with consistent letter spacing. A
 * faint diagonal shine band crosses U, M, and O at ~12° — the
 * detail from the artwork the user uploaded — giving the mark
 * a subtle "lit" quality without becoming a literal stripe.
 *
 * Drawn at viewBox 100×24; width auto-scales to keep aspect.
 * Pass height in pixels.
 */
export function LumoWordmark({
  height = 22,
  className = "",
}: {
  height?: number;
  className?: string;
}) {
  const w = (height * 100) / 24;
  return (
    <svg
      width={w}
      height={height}
      viewBox="0 0 100 24"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      aria-label="Lumo"
      role="img"
    >
      <defs>
        {/* Soft dark band that simulates a lit highlight — the
            diagonal "shine" from the source artwork. Reads as
            depth, not a stripe. */}
        <linearGradient id="lumo-shine" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#000" stopOpacity="0" />
          <stop offset="50%" stopColor="#000" stopOpacity="0.22" />
          <stop offset="100%" stopColor="#000" stopOpacity="0" />
        </linearGradient>

        {/* Each letter is its own clipPath so the shine stays
            inside the glyph and doesn't bleed onto neighbours. */}
        <clipPath id="lw-clip-l">
          <path d="M0 1.5 H6 V18 H17 V22.5 H0 Z" />
        </clipPath>
        <clipPath id="lw-clip-u">
          <path d="M22 1.5 H28 V15.5 a4 4 0 0 0 8 0 V1.5 H42 V16 a10 10 0 0 1 -20 0 Z" />
        </clipPath>
        <clipPath id="lw-clip-m">
          <path d="M48 22.5 V1.5 H54 L60 11 L66 1.5 H72 V22.5 H66 V11 L62 17 H58 L54 11 V22.5 Z" />
        </clipPath>
        <clipPath id="lw-clip-o">
          <path d="M88 12 a10 10 0 1 1 -20 0 a10 10 0 0 1 20 0 Z M82 12 a4 4 0 1 0 -8 0 a4 4 0 0 0 8 0 Z" />
        </clipPath>
      </defs>

      {/* L */}
      <g clipPath="url(#lw-clip-l)">
        <rect x="0" y="0" width="22" height="24" fill="var(--g-blue)" />
        <rect
          x="-4"
          y="-2"
          width="30"
          height="6"
          fill="url(#lumo-shine)"
          transform="rotate(12 11 12)"
        />
      </g>

      {/* U */}
      <g clipPath="url(#lw-clip-u)">
        <rect x="22" y="0" width="22" height="24" fill="var(--g-blue)" />
        <rect
          x="18"
          y="-2"
          width="30"
          height="6"
          fill="url(#lumo-shine)"
          transform="rotate(12 33 12)"
        />
      </g>

      {/* M */}
      <g clipPath="url(#lw-clip-m)">
        <rect x="48" y="0" width="24" height="24" fill="var(--g-blue)" />
        <rect
          x="44"
          y="-2"
          width="32"
          height="6"
          fill="url(#lumo-shine)"
          transform="rotate(12 60 12)"
        />
      </g>

      {/* O */}
      <g clipPath="url(#lw-clip-o)">
        <rect x="68" y="2" width="20" height="20" fill="var(--g-blue)" />
        <rect
          x="64"
          y="0"
          width="28"
          height="6"
          fill="url(#lumo-shine)"
          transform="rotate(12 78 12)"
        />
      </g>
    </svg>
  );
}
