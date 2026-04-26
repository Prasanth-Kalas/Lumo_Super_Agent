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
 * "LUMO" wordmark — chunky geometric letters with a prominent
 * diagonal fold that crosses U, M, and O (the L stays clean
 * because its silhouette already provides the visual weight).
 *
 * The fold is a single rotated band — base blue underneath, a
 * darker overlay on top — clipped to each glyph so the band
 * "flows" continuously across letters instead of being a
 * separate stripe per letter. That's the origami / folded-paper
 * feel from the artwork.
 *
 * Drawn at viewBox 100×24; width auto-scales to keep aspect.
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
        {/* Per-letter clip paths. Each defines the silhouette of
            one glyph; the base blue rect and the dark fold band
            both render inside this clip, so neither bleeds. */}
        <clipPath id="lw2-clip-l">
          <path d="M0 1 H6 V18 H17 V23 H0 Z" />
        </clipPath>
        <clipPath id="lw2-clip-u">
          <path d="M22 1 H28 V15.5 a4 4 0 0 0 8 0 V1 H42 V16 a10 10 0 0 1 -20 0 Z" />
        </clipPath>
        <clipPath id="lw2-clip-m">
          <path d="M48 23 V1 H54 L60 11 L66 1 H72 V23 H66 V11 L62 17 H58 L54 11 V23 Z" />
        </clipPath>
        <clipPath id="lw2-clip-o">
          <path d="M88 12 a10 10 0 1 1 -20 0 a10 10 0 0 1 20 0 Z M82 12 a4 4 0 1 0 -8 0 a4 4 0 0 0 8 0 Z" />
        </clipPath>

        {/* The fold gradient. Crisp dark blue at center, fading
            quickly on each side — reads as a definite band, not
            a soft halo. Same hex on both edges so the glyph
            silhouette stays the dominant shape. */}
        <linearGradient
          id="lw2-fold"
          gradientUnits="userSpaceOnUse"
          x1="0"
          y1="0"
          x2="0"
          y2="6"
        >
          <stop offset="0%" stopColor="#1557B0" stopOpacity="0" />
          <stop offset="35%" stopColor="#1557B0" stopOpacity="0.95" />
          <stop offset="65%" stopColor="#1557B0" stopOpacity="0.95" />
          <stop offset="100%" stopColor="#1557B0" stopOpacity="0" />
        </linearGradient>
      </defs>

      {/* L — solid, no fold (the negative space carries the weight) */}
      <g clipPath="url(#lw2-clip-l)">
        <rect x="0" y="0" width="22" height="24" fill="var(--g-blue)" />
      </g>

      {/* U */}
      <g clipPath="url(#lw2-clip-u)">
        <rect x="22" y="0" width="22" height="24" fill="var(--g-blue)" />
        <rect
          x="14"
          y="2"
          width="38"
          height="6"
          fill="url(#lw2-fold)"
          transform="rotate(28 33 12)"
        />
      </g>

      {/* M */}
      <g clipPath="url(#lw2-clip-m)">
        <rect x="48" y="0" width="24" height="24" fill="var(--g-blue)" />
        <rect
          x="40"
          y="2"
          width="40"
          height="6"
          fill="url(#lw2-fold)"
          transform="rotate(28 60 12)"
        />
      </g>

      {/* O — fold becomes a vertical slice on the right side,
          mirroring the artwork (the O reads as a sliced disc
          rather than an angled fold). */}
      <g clipPath="url(#lw2-clip-o)">
        <rect x="68" y="2" width="20" height="20" fill="var(--g-blue)" />
        <rect x="83" y="2" width="5" height="20" fill="#1557B0" opacity="0.95" />
      </g>
    </svg>
  );
}
