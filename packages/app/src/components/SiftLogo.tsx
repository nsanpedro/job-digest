/**
 * Sift logo — the sieve mark: three dots above, a dashed rule through the
 * middle, three dots below. The rule is the accent (blue); everything else
 * is ink and neutral. viewBox stays 72×72 regardless of render size.
 */
export function SiftLogo({ size = 24, ariaLabel = 'Sift' }: { size?: number; ariaLabel?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 72 72"
      fill="none"
      aria-label={ariaLabel}
      role="img"
    >
      <rect x="0.75" y="0.75" width="70.5" height="70.5" rx="16.25" fill="oklch(0.15 0.008 260)" />
      <circle cx="20" cy="20" r="4.5" fill="#fff" />
      <circle cx="36" cy="18" r="3.5" fill="oklch(0.5 0.005 260)" />
      <circle cx="52" cy="22" r="5" fill="#fff" />
      <line
        x1="10"
        y1="38"
        x2="62"
        y2="38"
        stroke="oklch(0.5 0.16 250)"
        strokeWidth="2.6"
        strokeLinecap="round"
        strokeDasharray="4 5"
      />
      <circle cx="26" cy="54" r="3" fill="oklch(0.5 0.005 260)" />
      <circle cx="44" cy="56" r="4" fill="oklch(0.5 0.16 250)" />
      <circle cx="58" cy="55" r="2.5" fill="oklch(0.5 0.005 260)" />
    </svg>
  );
}
