import { getApplications } from '@job-digest/db';
import { ApplicationCard } from '@/components/ApplicationCard';
import { currentUser, withTenant } from '@/lib/session';
import styles from './page.module.css';

export const dynamic = 'force-dynamic';

/**
 * The record of a search (design §9, I15/I16).
 *
 * A standing view, never window-scoped: a search runs for months. Nothing here
 * is filtered by rule verdicts or by dismissal — that is I16, and it is what
 * stops a tightened rule from erasing the user's own history.
 */
export default async function ApplicationsPage() {
  const user = await currentUser();
  const applications = await withTenant(user.id, (tx) => getApplications(tx, user.id));

  const open = applications.filter((a) => a.open);
  const closed = applications.filter((a) => !a.open);
  const waiting = open.filter((a) => a.needsFollowUp).length;

  return (
    <div className="container">
      <h1 className={styles.h1}>Applications</h1>
      <p className={styles.subtitle}>
        {applications.length === 0
          ? 'Everything you have applied to, once you start recording it.'
          : `${open.length} still open${waiting > 0 ? `, ${waiting} with nothing new in a while` : ''}. This is your record — nothing here is detected, and nothing is filtered by your rules.`}
      </p>

      {applications.length === 0 ? (
        <p className={styles.empty}>Nothing recorded yet — press “I applied” on a card in the digest.</p>
      ) : (
        <>
          <div className={styles.list}>
            {open.map((app) => (
              <ApplicationCard key={app.id} app={app} />
            ))}
          </div>

          {closed.length > 0 && (
            <>
              <p className={styles.sectionLabel}>Closed</p>
              <div className={styles.list}>
                {closed.map((app) => (
                  <ApplicationCard key={app.id} app={app} />
                ))}
              </div>
            </>
          )}
        </>
      )}

      <p className={styles.footnote}>
        Every entry here was recorded by you. This app reads job-alert emails and nothing else — it
        never sees an application you sent or a reply you received, and it never writes to your
        mailbox or answers anyone on your behalf.
      </p>
    </div>
  );
}
