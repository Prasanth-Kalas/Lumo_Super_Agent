/**
 * BrandMark — the Lumo logomark.
 *
 * Replaces the old "lit orange disc" avatar with a typographic mark:
 * a square 20×20 tile rendering a monoline "L" with a trailing dot,
 * in the current foreground color. Works in light and dark without a
 * color swap because it uses `currentColor`.
 *
 * Usage:
 *    <BrandMark />                 // 20px square, inline text color
 *    <BrandMark size={14} />       // smaller, used in message prefixes
 *    <BrandMark className="text-lumo-accent" />  // tinted
 */

export function BrandMark({
  size = 20,
  className = "",
}: {
  size?: number;
  className?: string;
}) {
  return (
    <span
      className={`inline-flex items-center justify-center ${className}`}
      style={{ width: size, height: size }}
      aria-hidden
    >
      <svg
        width={size}
        height={size}
        viewBox="0 0 20 20"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
      >
        {/* Rounded tile background */}
        <rect
          x="1"
          y="1"
          width="18"
          height="18"
          rx="5"
          stroke="currentColor"
          strokeOpacity="0.18"
          strokeWidth="1"
        />
        {/* Mono "L" — strict verticals, tight terminal */}
        <path
          d="M6.4 5.2v9.2h5.3"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        {/* Accent dot — the "o" in Lumo, miniature */}
        <circle cx="13.6" cy="14.4" r="1.1" fill="currentColor" />
      </svg>
    </span>
  );
}
