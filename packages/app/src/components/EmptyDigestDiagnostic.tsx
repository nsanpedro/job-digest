import Link from 'next/link';
import type { Ruleset } from '@job-digest/core';
import type { Digest } from '@job-digest/db';
import styles from './EmptyDigestDiagnostic.module.css';

/**
 * Rendered in place of the tier lists when all four curated buckets (top /
 * read / stretch / stillOpen) are empty. Names the mechanism from the counts
 * the digest already carries — never invented numbers.
 *
 * The old empty state was a single line ("No matches this week.") — a PM test
 * user read that and autoconcluded "no habrá mucho esta semana" without any
 * signal about whether the pipeline had actually run. The job here is to make
 * the difference between "quiet week" and "everything got filtered out"
 * legible from the numbers alone, and to offer one primary next step biased
 * toward whichever knob is likeliest to change the outcome next week.
 *
 * Copy voice matches ParseBanner: assembled from counts, no cheerleading, no
 * apology. Every strong number in the body maps to a field already exposed on
 * the Digest read model — see the mapping below each render line.
 */
export function EmptyDigestDiagnostic({
  digest,
  rules,
}: {
  digest: Digest;
  rules: Ruleset;
}) {
  // rules kept in the signature to mirror DigestList and to leave room for
  // ruleset-shaped copy variants (e.g. "your Pay floor blocked most of this
  // week") without a later prop churn. Not read yet.
  void rules;

  // Sum of every ad we surfaced anywhere in the tier ladder — the honest
  // "ads reviewed" number the user can compare against their expectation.
  // Dismissed ads are excluded on purpose: those never entered the ranking.
  const adsReviewed =
    digest.topPicks.length +
    digest.worthAReading.length +
    digest.stretch.length +
    digest.stillOpen.length +
    digest.explore.length;

  // metrics.explore is null when no pre-filter ran (no city, no directions) —
  // in that case every explore entry is a below-threshold miss by construction,
  // so fall back to the raw length.
  const belowThreshold =
    digest.metrics.explore?.belowThreshold ?? digest.explore.length;

  const emailsRead = digest.parse.emailsRead;
  const notFullyRead = digest.parse.emailsNotFullyRead;

  // One primary action, chosen by which knob has more mass to unblock. If
  // neither has any, the honest answer is "it was quiet".
  const primary: 'threshold' | 'unread' | 'quiet' =
    belowThreshold === 0 && notFullyRead === 0
      ? 'quiet'
      : belowThreshold >= notFullyRead
        ? 'threshold'
        : 'unread';

  return (
    <section className={styles.card}>
      <p className={styles.label}>Nothing entered the top tiers this week</p>

      <ul className={styles.list}>
        <li className={styles.line}>
          {/* emailsRead: digest.parse.emailsRead — every parse row in the window */}
          {/* adsReviewed: sum of the four tier lists + explore */}
          <strong>{emailsRead}</strong> alert email{emailsRead === 1 ? '' : 's'} scanned
          {' · '}
          <strong>{adsReviewed}</strong> ad{adsReviewed === 1 ? '' : 's'} reviewed in the window.
        </li>

        {belowThreshold > 0 && (
          <li className={styles.line}>
            {/* belowThreshold: digest.metrics.explore.belowThreshold, or digest.explore.length when no pre-filter ran */}
            <strong>{belowThreshold}</strong> ad{belowThreshold === 1 ? '' : 's'} scored below the tier threshold —{' '}
            <Link href="/digest/explore" className={styles.inlineLink}>
              see them in Explore
            </Link>
            .
          </li>
        )}

        {notFullyRead > 0 && (
          <li className={styles.line}>
            {/* notFullyRead: digest.parse.emailsNotFullyRead */}
            <strong>{notFullyRead}</strong> alert email{notFullyRead === 1 ? '' : 's'}{' '}
            {notFullyRead === 1 ? 'was' : 'were'} not fully parsed — ads inside may exist that never reached the ranking.
          </li>
        )}
      </ul>

      <div className={styles.action}>
        {primary === 'quiet' && (
          <p className={styles.quiet}>
            This was a genuinely quiet week — nothing was filtered out or lost in parsing.
          </p>
        )}
        {primary === 'threshold' && (
          <Link href="/profile" className={styles.btn}>
            Lower the match threshold in Profile
          </Link>
        )}
        {primary === 'unread' && (
          <Link href="/unread" className={styles.btn}>
            Check the {notFullyRead} unread email{notFullyRead === 1 ? '' : 's'}
          </Link>
        )}
      </div>
    </section>
  );
}
