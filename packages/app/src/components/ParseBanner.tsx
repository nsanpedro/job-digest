import Link from 'next/link';
import type { ParseSummary } from '@job-digest/db';
import styles from './ParseBanner.module.css';

/**
 * Assembled from real counts, not authored per-incident prose (design's copy
 * rule: explain the mechanism, never apologize — which only works when the
 * mechanism named is one we actually observed). The prototype's example
 * ("Xing changed its alert layout on 24 Jul…") names a specific date and
 * platform; this app doesn't yet track cause_code per platform in the
 * summary, so the banner says only what the data supports.
 */
export function ParseBanner({ parse }: { parse: ParseSummary }) {
  if (parse.emailsNotFullyRead === 0) return null;

  const fragments: string[] = [];
  if (parse.hasUnknownLayout) {
    fragments.push('At least one used a page layout we don’t recognize yet.');
  }
  if (parse.adsUnaccountedFor > 0) {
    fragments.push(
      `${parse.adsUnaccountedFor} ad${parse.adsUnaccountedFor === 1 ? '' : 's'} could not be extracted at all — they are not in the list above.`,
    );
  }

  return (
    <div className={styles.banner}>
      <p className={styles.text}>
        <span className={styles.headline}>
          {parse.emailsNotFullyRead} alert email{parse.emailsNotFullyRead === 1 ? '' : 's'}{' '}
          {parse.emailsNotFullyRead === 1 ? 'was' : 'were'} not fully read this week.
        </span>{' '}
        {fragments.length > 0 && <span className={styles.detail}>{fragments.join(' ')}</span>}
      </p>
      <Link href="/unread" className={styles.btn}>
        See the {parse.emailsNotFullyRead} email{parse.emailsNotFullyRead === 1 ? '' : 's'}
      </Link>
    </div>
  );
}
