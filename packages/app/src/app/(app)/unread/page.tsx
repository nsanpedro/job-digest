import { getUnreadEmailsCached } from '@/lib/nav-data';
import { UnreadCard } from '@/components/UnreadCard';
import { currentUser } from '@/lib/session';
import styles from './page.module.css';

export const dynamic = 'force-dynamic';

export default async function UnreadPage() {
  const user = await currentUser();
  // Same cache()-wrapped call the layout makes for the nav badge — one query
  // per request either way, this just avoids a second one for the list.
  const unread = await getUnreadEmailsCached(user.id);

  const partial = unread.filter((u) => u.inDigest).length;

  return (
    <div className="container">
      <h1 className={styles.h1}>Emails we couldn't read</h1>
      <p className={styles.subtitle}>
        {unread.length} email{unread.length === 1 ? '' : 's'} this week{' '}
        {unread.length === 1 ? 'was' : 'were'} not fully read.{' '}
        {partial > 0 && (
          <>
            {partial} of them still put something into the digest, marked
            <span className={styles.badgeInline}>partly read</span>.
          </>
        )}
      </p>

      {unread.length === 0 ? (
        <p className={styles.empty}>Every alert email this week was read in full.</p>
      ) : (
        <div className={styles.list}>
          {unread.map((email) => (
            <UnreadCard key={email.id} email={email} />
          ))}
        </div>
      )}

      <p className={styles.footnote}>
        Anything half-read still goes into the digest, marked incomplete. We would rather show you
        an ad with a missing field than hide a job you would have wanted.
      </p>
    </div>
  );
}
