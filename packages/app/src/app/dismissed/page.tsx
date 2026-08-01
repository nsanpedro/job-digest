import {
  getActiveRuleset,
  getApplicationCounts,
  getDismissedAds,
  getSavedCount,
  getUnreadEmails,
  weekWindow,
} from '@job-digest/db';
import { TopBar } from '@/components/Chrome';
import { DismissedRow } from '@/components/DismissedRow';
import { currentUser, withTenant } from '@/lib/session';
import styles from './page.module.css';

export const dynamic = 'force-dynamic';

/**
 * All-time record of ads you dismissed yourself (I10) — separate from the
 * weekly digest's "Filtered out" section, which is about checking this
 * week's rule outcomes, not auditing your own past decisions.
 */
export default async function DismissedPage() {
  const user = await currentUser();

  const [dismissed, unread, savedCount, ruleset, applications] = await withTenant(user.id, async (tx) => [
    await getDismissedAds(tx, user.id),
    await getUnreadEmails(tx, user.id, weekWindow(new Date())),
    await getSavedCount(tx, user.id),
    await getActiveRuleset(tx, user.id),
    await getApplicationCounts(tx, user.id),
  ]);

  return (
    <>
      <TopBar
        active="dismissed"
        unreadCount={unread.length}
        savedCount={savedCount}
        applicationCount={applications.open}
        userEmail={user.email}
      />
      <div className="container">
        <h1 className={styles.h1}>Dismissed</h1>
        <p className={styles.subtitle}>
          Ads you dismissed yourself, across every week — undo any of these any time.
        </p>
        {dismissed.length === 0 ? (
          <p className={styles.empty}>Nothing dismissed yet.</p>
        ) : (
          <div className={styles.list}>
            {dismissed.map((ad) => (
              <DismissedRow key={ad.id} ad={ad} rules={ruleset.rules} rulesetVersion={ruleset.version} />
            ))}
          </div>
        )}
      </div>
    </>
  );
}
