/**
 * BrandMark — the Lumo logomark.
 *
 * A monoline "L" with a Google-style four-color dot stack: blue
 * stem, red anchor, yellow turn, green dot. Subtle but unmistakably
 * "tech utility" — same visual family as Gmail / Drive / Calendar
 * marks without copying them.
 *
 * `monochrome` flag ships a single-color version (current foreground)
 * for places where the colorful mark would compete — small inline
 * "Lumo" labels above messages, for instance.
 *
 * Usage:
 *    <BrandMark />                       // 22px colored
 *    <BrandMark size={14} monochrome />  // small inline label
 *    <BrandMark className="text-lumo-accent" />  // tint override
 */

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
          stroke="currentColor"
          strokeOpacity="0.18"
          strokeWidth="1"
        />
        {/* L's vertical stroke — Google blue. */}
        <path
          d="M7 6v10"
          stroke="var(--g-blue)"
          strokeWidth="1.8"
          strokeLinecap="round"
        />
        {/* Bottom horizontal — Google green to red gradient via two strokes. */}
        <path
          d="M7 16h3"
          stroke="var(--g-green)"
          strokeWidth="1.8"
          strokeLinecap="round"
        />
        <path
          d="M10 16h3.2"
          stroke="var(--g-yellow)"
          strokeWidth="1.8"
          strokeLinecap="round"
        />
        {/* Terminal dot — Google red. The "o" in Lumo, miniature. */}
        <circle cx="15.6" cy="16" r="1.4" fill="var(--g-red)" />
      </svg>
    </span>
  );
}
