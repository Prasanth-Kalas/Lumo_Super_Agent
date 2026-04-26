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
          stroke="#1FB8E8"
          strokeOpacity="0.4"
          strokeWidth="1"
        />
        <path
          d="M7 6v10"
          stroke="#1FB8E8"
          strokeWidth="2"
          strokeLinecap="round"
        />
        <path
          d="M7 16h7"
          stroke="#1FB8E8"
          strokeWidth="2"
          strokeLinecap="round"
        />
        <circle cx="15.6" cy="16" r="1.5" fill="#0F7FAE" />
      </svg>
    </span>
  );
}

// ─── Full LUMO wordmark ───────────────────────────────────────

/**
 * "LUMO" wordmark — renders the canonical brand bitmap from
 * /public/lumo-wordmark.png via an <img> tag. The PNG is generated
 * by `scripts/build-wordmark.py` from the reference artwork
 * (bright sky-cyan body + darker same-hue paper-fold creases) at
 * 1600×384 — that's the source of truth for the visual.
 *
 * Why <img> instead of inline SVG: SVG path approximations of a
 * specific bitmap kept producing visible drift (letter spacing,
 * O proportions, fold band geometry). Sourcing from the bitmap
 * itself eliminates that whole class of issue and means the only
 * way the wordmark changes is if someone regenerates the asset.
 *
 * The asset has a 1600:384 aspect ratio (~4.17:1). We scale by
 * height; width auto-derives from the aspect to stay crisp at any
 * size.
 */
const WORDMARK_W = 1600;
const WORDMARK_H = 384;

export function LumoWordmark({
  height = 22,
  className = "",
}: {
  height?: number;
  className?: string;
}) {
  const width = Math.round((height * WORDMARK_W) / WORDMARK_H);
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src="/lumo-wordmark.png"
      alt="Lumo"
      width={width}
      height={height}
      className={className}
      style={{ display: "block" }}
    />
  );
}
