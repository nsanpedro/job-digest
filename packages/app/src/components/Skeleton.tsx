/**
 * Loading-state primitives (design: perf pass, Aug 2026). Each route's
 * loading.tsx composes these into a rough approximation of its real layout —
 * close enough that the swap from skeleton to real content doesn't jump, not
 * a pixel-perfect double of every component.
 */
import styles from './Skeleton.module.css';

export function SkeletonBar({ width, height = 14, style }: { width: string | number; height?: number; style?: React.CSSProperties }) {
  return <div className={styles.bar} style={{ width, height, ...style }} />;
}

/** One ad-card-shaped block: title, meta line, a row of chips. */
export function SkeletonAdCard() {
  return (
    <div className={styles.card}>
      <SkeletonBar width="70%" height={17} style={{ marginBottom: 10 }} />
      <SkeletonBar width="40%" height={12} style={{ marginBottom: 16 }} />
      <div style={{ display: 'flex', gap: 6 }}>
        {Array.from({ length: 5 }, (_, i) => (
          <SkeletonBar key={i} width={72} height={22} style={{ borderRadius: 'var(--radius-pill)' }} />
        ))}
      </div>
    </div>
  );
}

/** A stack of ad-card skeletons — the shape of digest/saved/dismissed/applications lists. */
export function SkeletonAdCardList({ count = 5 }: { count?: number }) {
  return (
    <div className={styles.cardRow}>
      {Array.from({ length: count }, (_, i) => (
        <SkeletonAdCard key={i} />
      ))}
    </div>
  );
}

export function SkeletonPageHeader() {
  return (
    <>
      <SkeletonBar width={220} height={27} style={{ margin: '32px 0 8px' }} />
      <SkeletonBar width={360} height={13} style={{ marginBottom: 28 }} />
    </>
  );
}
