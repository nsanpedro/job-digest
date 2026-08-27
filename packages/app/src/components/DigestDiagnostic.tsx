import Link from 'next/link';
import type { Insight, InsightKind } from '@job-digest/core';
import styles from './DigestDiagnostic.module.css';

/**
 * The digest's built-in explanation for a thin week. Rendered only when
 * `explainDigest()` from the core returns non-empty — a healthy digest
 * shows nothing here.
 *
 * Each insight comes with a message and (optionally) a call-to-action
 * that points at the page where the user can act. The mapping from
 * `InsightKind` to a destination lives here (UI concern), not in the core
 * (pure derivation).
 */
const ACTION_HREF: Record<InsightKind, string> = {
  'rule-blocked': '/profile',
  'pre-filter-miss': '/profile',
  'below-threshold': '#explore',
  healthy: '#',
};

export function DigestDiagnostic({ insights }: { insights: readonly Insight[] }) {
  if (insights.length === 0) return null;

  return (
    <aside className={styles.card} aria-label="Why this digest is short">
      <p className={styles.title}>Digest notes</p>
      <ul className={styles.list}>
        {insights.map((insight, i) => (
          <li key={i} className={styles.item}>
            <span className={styles.message}>{insight.message}</span>
            {insight.action && insight.kind !== 'below-threshold' && (
              <Link href={ACTION_HREF[insight.kind]} className={styles.action}>
                {insight.action.label} →
              </Link>
            )}
            {insight.action && (
              <span className={styles.hint}>{insight.action.hint}</span>
            )}
          </li>
        ))}
      </ul>
    </aside>
  );
}
