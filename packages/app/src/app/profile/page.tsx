import { DEFAULT_RULESET } from '@job-digest/core';
import {
  getAccountOverview,
  getActiveRuleset,
  getSavedCount,
  getUnreadEmails,
  NoActiveRulesetError,
  weekWindow,
} from '@job-digest/db';
import { TopBar } from '@/components/Chrome';
import { RulesEditor } from '@/components/RulesEditor';
import { currentUser, withTenant } from '@/lib/session';
import styles from './page.module.css';

export const dynamic = 'force-dynamic';

function isExpiringSoon(d: Date | null): boolean {
  if (!d) return false;
  return d.getTime() - Date.now() < 2 * 24 * 60 * 60 * 1000; // under 2 days left
}

export default async function ProfilePage() {
  const user = await currentUser();

  const [ruleset, account, unread, savedCount] = await withTenant(user.id, async (tx) => {
    let rs: { version: number; rules: typeof DEFAULT_RULESET };
    try {
      rs = await getActiveRuleset(tx, user.id);
    } catch (err) {
      if (!(err instanceof NoActiveRulesetError)) throw err;
      rs = { version: 0, rules: DEFAULT_RULESET };
    }
    return [
      rs,
      await getAccountOverview(tx, user.id),
      await getUnreadEmails(tx, user.id, weekWindow(new Date())),
      await getSavedCount(tx, user.id),
    ] as const;
  });

  return (
    <>
      <TopBar active="profile" unreadCount={unread.length} savedCount={savedCount} userEmail={user.email} />
      <div className="container">
        <h1 className={styles.h1}>Profile</h1>

        <div className={styles.section}>
          <p className={styles.sectionLabel}>Filtering rules</p>
          {ruleset.version === 0 && (
            <p style={{ fontSize: 13, color: 'var(--text-muted)', marginBottom: 14 }}>
              No rules saved yet — starting from sensible defaults. Adjust and save to activate
              them.
            </p>
          )}
          <RulesEditor initialRules={ruleset.rules} version={ruleset.version} />
        </div>

        <div className={styles.section}>
          <p className={styles.sectionLabel}>Account</p>
          <div className={styles.accountCard}>
            <div className={styles.row}>
              <span className={styles.rowLabel}>Signed in as</span>
              <span className={styles.rowValue}>{account?.email ?? user.email}</span>
            </div>
            <div className={styles.row}>
              <span className={styles.rowLabel}>Subscription</span>
              <span className={styles.rowValue}>{account?.subscriptionStatus ?? 'None — free tier'}</span>
            </div>
            <div className={styles.row}>
              <span className={styles.rowLabel}>Account created</span>
              <span className={styles.rowValue}>
                {account?.createdAt ? account.createdAt.toISOString().slice(0, 10) : '—'}
              </span>
            </div>
          </div>
        </div>

        <div className={styles.section}>
          <p className={styles.sectionLabel}>Connected mailboxes</p>
          <div className={styles.accountCard}>
            {!account || account.mailboxes.length === 0 ? (
              <p className={styles.empty}>No mailbox connected.</p>
            ) : (
              account.mailboxes.map((mb) => {
                const expiring = isExpiringSoon(mb.credentialExpiresAt);
                return (
                  <div key={mb.id} className={styles.mailboxRow}>
                    <div>
                      <div className={styles.mailboxEmail}>{mb.emailAddress}</div>
                      <div className={styles.mailboxMeta}>
                        {mb.provider} · {mb.authKind}
                        {mb.credentialExpiresAt && (
                          <> · renews by {mb.credentialExpiresAt.toISOString().slice(0, 10)}</>
                        )}
                      </div>
                    </div>
                    <span
                      className={`${styles.statusPill} ${expiring ? styles.statusWarn : styles.statusOk}`}
                    >
                      {expiring ? 'renew soon' : mb.status}
                    </span>
                  </div>
                );
              })
            )}
          </div>
          <p style={{ fontSize: 12, color: 'var(--text-faint)', marginTop: 10 }}>
            Google Testing-mode grants expire roughly every 7 days until the app is verified
            (design §4.1) — sign out and back in with Google to renew.
          </p>
        </div>
      </div>
    </>
  );
}
