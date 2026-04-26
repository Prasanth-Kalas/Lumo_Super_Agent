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
 * "LUMO" wordmark — chunky geometric letters in bright cyan with
 * crisp polygon fold-bands that cross U, M, and the right side
 * of O. L stays clean (its silhouette already carries the weight).
 *
 * Each fold is a hard-edged parallelogram filled with a darker
 * shade of the same hue — no soft gradient, because the source
 * artwork uses crisp paper-fold creases, not glow halos.
 *
 * Colors are hardcoded (NOT CSS variables). The wordmark is a
 * brand asset and shouldn't follow theme drift if the rest of
 * the UI's accent token changes.
 *
 * Drawn at viewBox 100×24; width auto-scales to preserve aspect.
 */
export function LumoWordmark({
  height = 22,
  className = "",
}: {
  height?: number;
  className?: string;
}) {
  const w = (height * 100) / 24;
  // Sampled directly from the source artwork — bright cyan body
  // with a darker same-hue fold/crease. Not the navy --g-blue
  // accent the rest of the UI uses.
  const BASE = "#1FB8E8";
  const FOLD = "#0F7FAE";
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
        {/* Per-letter clip paths so each glyph's base rect and
            fold polygons stay inside the silhouette. */}
        <clipPath id="lw3-clip-l">
          <path d="M0 1 H6 V18 H17 V23 H0 Z" />
        </clipPath>
        <clipPath id="lw3-clip-u">
          <path d="M22 1 H28 V15.5 a4 4 0 0 0 8 0 V1 H42 V16 a10 10 0 0 1 -20 0 Z" />
        </clipPath>
        <clipPath id="lw3-clip-m">
          <path d="M48 23 V1 H54 L60 11 L66 1 H72 V23 H66 V11 L62 17 H58 L54 11 V23 Z" />
        </clipPath>
        <clipPath id="lw3-clip-o">
          <path d="M88 12 a10 10 0 1 1 -20 0 a10 10 0 0 1 20 0 Z M82 12 a4 4 0 1 0 -8 0 a4 4 0 0 0 8 0 Z" />
        </clipPath>
      </defs>

      {/* L — solid, no fold */}
      <g clipPath="url(#lw3-clip-l)">
        <rect x="0" y="0" width="22" height="24" fill={BASE} />
      </g>

      {/* U — single diagonal fold parallelogram sweeping from
          the upper-left corner of the bowl down to the lower-
          right exit. Hard edges (no gradient). */}
      <g clipPath="url(#lw3-clip-u)">
        <rect x="22" y="0" width="22" height="24" fill={BASE} />
        <polygon points="24,1 31,1 42,23 35,23" fill={FOLD} />
      </g>

      {/* M — single diagonal fold across the whole letter. The
          M's V notch naturally splits the band into two visible
          pieces (left arm, right arm + foot), which mimics how
          a real fold disappears into a crease. */}
      <g clipPath="url(#lw3-clip-m)">
        <rect x="48" y="0" width="24" height="24" fill={BASE} />
        <polygon points="52,1 59,1 70,23 63,23" fill={FOLD} />
      </g>

      {/* O — fold is a vertical slice on the right side, inset
          slightly from the edge so it reads as a paper fold,
          not a hard right-edge stroke. */}
      <g clipPath="url(#lw3-clip-o)">
        <rect x="68" y="2" width="20" height="20" fill={BASE} />
        <rect x="83" y="2" width="5" height="20" fill={FOLD} />
      </g>
    </svg>
  );
}
