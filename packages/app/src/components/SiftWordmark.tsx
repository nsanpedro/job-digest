/**
 * "Sift" wordmark — the "ft" is the accent (same blue as the logo's
 * dashed rule). Kept in a single component so the split never drifts.
 */
export function SiftWordmark({ size = 15 }: { size?: number }) {
  return (
    <span
      style={{
        fontSize: size,
        fontWeight: 600,
        letterSpacing: '-0.02em',
        color: 'var(--text-strong)',
      }}
    >
      Si<span style={{ color: 'var(--link)' }}>ft</span>
    </span>
  );
}
