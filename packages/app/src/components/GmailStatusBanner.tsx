import { cookies } from 'next/headers';
import { connectGmail, SKIP_GMAIL_COOKIE } from '@/lib/gmail-actions';
import { getGmailMailboxStatus } from '@/lib/mailbox-status';
import styles from './GmailStatusBanner.module.css';

/**
 * Persistent post-login banner for Gmail state.
 *
 * Not rendered when Gmail is healthy (active + unexpired). Two visible
 * shapes otherwise:
 *
 *   amber — the connection is not there (user is onboarded and has
 *           dismissed the connect page for a week; the /digest gate
 *           in B1 has stopped bouncing them but they still lack
 *           Gmail-sourced alerts, which is worth naming in situ)
 *   block — the connection existed and stopped working (auth_failed
 *           after a scan, or the Testing-mode 7-day cliff hit
 *           credentialExpiresAt); reconnect is the only path back
 *
 * The 'missing' + no-skip-cookie case renders nothing here — the
 * DigestPage redirect owns that path, and rendering both would flash
 * a banner during the redirect.
 *
 * A single Reconnect button on the block variant; a lower-weight
 * "Connect Gmail" on the amber variant — same server action, same
 * consent grant, different framing per how the user got here.
 */
export async function GmailStatusBanner({ userId }: { userId: string }) {
  const [state, cookieStore] = await Promise.all([getGmailMailboxStatus(userId), cookies()]);
  const skipped = cookieStore.get(SKIP_GMAIL_COOKIE)?.value === '1';

  if (state.status === 'active') return null;
  if (state.status === 'missing' && !skipped) return null;

  if (state.status === 'missing') {
    return (
      <div className={styles.amber}>
        <p className={styles.text}>
          <span className={styles.headline}>You are seeing public jobs only.</span>{' '}
          <span className={styles.detail}>
            Connect Gmail to also read the LinkedIn / Indeed alerts you already receive
            — read-only access, revocable any time.
          </span>
        </p>
        <form action={connectGmail}>
          <button type="submit" className={styles.btnAmber}>
            Connect Gmail
          </button>
        </form>
      </div>
    );
  }

  // 'expired' or 'failed' — both mean the same thing to the user
  // (reconnect required); the copy names which one so support debugging
  // stays possible when they screenshot the banner.
  const address = state.emailAddress;
  const reason =
    state.status === 'expired'
      ? 'Your Gmail connection expired.'
      : 'Your Gmail connection stopped working.';
  const context =
    state.status === 'expired'
      ? 'Testing-mode grants expire every 7 days until the app is verified — reconnect to renew.'
      : 'The last scan failed to authenticate. Reconnect to resume reading alerts.';

  return (
    <div className={styles.block}>
      <p className={styles.text}>
        <span className={styles.headline}>{reason}</span>{' '}
        {address && <span className={styles.address}>({address})</span>}{' '}
        <span className={styles.detail}>{context}</span>
      </p>
      <form action={connectGmail}>
        <button type="submit" className={styles.btnBlock}>
          Reconnect Gmail
        </button>
      </form>
    </div>
  );
}
