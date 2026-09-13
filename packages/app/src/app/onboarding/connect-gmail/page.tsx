import { redirect } from 'next/navigation';
import { connectGmail, dismissGmailPromptForAWeek } from '@/lib/gmail-actions';
import { getGmailMailboxStatus } from '@/lib/mailbox-status';
import { currentUser } from '@/lib/session';
import styles from './page.module.css';

/**
 * The post-login Gmail consent page — where /digest's B1 gate routes an
 * onboarded user who has no working Gmail connection.
 *
 * Deliberately outside the (app) group: no TopBar, no OnboardingModal, no
 * competing UI. One decision on the page: grant, or skip for a week.
 *
 * Two exits back to /digest:
 *   - Continue with Google → NextAuth grant → mailbox row written → /digest
 *   - Not now → 7-day cookie set → /digest (with the amber status banner)
 *
 * If the user hits this URL directly while Gmail is already healthy, we
 * bounce to /digest — the page has nothing useful to say in that case.
 */
export default async function ConnectGmailPage() {
  const user = await currentUser();
  const state = await getGmailMailboxStatus(user.id);
  if (state.status === 'active') {
    redirect('/digest');
  }

  const isReconnect = state.status === 'expired' || state.status === 'failed';

  return (
    <div className={styles.wrap}>
      <div className={styles.card}>
        <div className={styles.brand}>
          <span className={styles.logo}>J</span>
          <span className={styles.brandLabel}>Job alert digest</span>
        </div>

        <h1 className={styles.h1}>
          {isReconnect ? 'Reconnect Gmail' : 'One more step: connect Gmail'}
        </h1>
        <p className={styles.intro}>
          {isReconnect
            ? 'Your Gmail connection is not working anymore. Google needs a fresh grant so we can keep reading the alerts you already receive.'
            : 'To also include the LinkedIn / Indeed alerts you already receive, we need a separate read-only grant for Gmail — Google keeps sign-in and mailbox access on different consent screens.'}
        </p>

        <form action={connectGmail}>
          <button type="submit" className={styles.googleBtn}>
            <GoogleMark />
            {isReconnect ? 'Reconnect with Google' : 'Continue with Google'}
          </button>
        </form>

        <div className={styles.scopes}>
          <ScopeRow ok>Read-only access to your Gmail messages — we never send, delete, or reply.</ScopeRow>
          <ScopeRow ok>Revocable any time from your Google Account.</ScopeRow>
        </div>

        <p className={styles.note}>
          Testing-mode grants expire roughly every 7 days until the app is
          verified — you may need to come back through this page.
        </p>

        <form
          action={async () => {
            'use server';
            await dismissGmailPromptForAWeek();
            redirect('/digest');
          }}
          className={styles.skipForm}
        >
          <button type="submit" className={styles.skipBtn}>
            Not now — see public jobs only
          </button>
        </form>
      </div>
    </div>
  );
}

function ScopeRow({ ok, children }: { ok: boolean; children: React.ReactNode }) {
  return (
    <div className={styles.scopeRow}>
      <span
        className={styles.scopeGlyph}
        style={
          ok
            ? { background: 'var(--pass-bg)', color: 'var(--pass-fg)' }
            : { background: 'var(--unknown-bg)', color: 'var(--unknown-fg)' }
        }
      >
        {ok ? '✓' : '?'}
      </span>
      {children}
    </div>
  );
}

function GoogleMark() {
  return (
    <svg width="16" height="16" viewBox="0 0 48 48" aria-hidden="true">
      <path
        fill="#FFC107"
        d="M43.6 20.5H42V20H24v8h11.3c-1.6 4.7-6.1 8-11.3 8-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.9 1.2 8 3.1l5.7-5.7C34.6 6.1 29.6 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.7-.4-3.5z"
      />
      <path
        fill="#FF3D00"
        d="M6.3 14.7l6.6 4.8C14.6 15.9 18.9 13 24 13c3.1 0 5.9 1.2 8 3.1l5.7-5.7C34.6 6.1 29.6 4 24 4c-7.4 0-13.8 4.2-17.7 10.7z"
      />
      <path
        fill="#4CAF50"
        d="M24 44c5.5 0 10.4-2.1 14.1-5.6l-6.5-5.5C29.6 34.8 26.9 36 24 36c-5.2 0-9.6-3.3-11.3-8l-6.5 5C10.2 39.7 16.6 44 24 44z"
      />
      <path
        fill="#1976D2"
        d="M43.6 20.5H42V20H24v8h11.3c-.8 2.3-2.2 4.2-4.1 5.6l6.5 5.5C41.4 36.1 44 30.6 44 24c0-1.3-.1-2.7-.4-3.5z"
      />
    </svg>
  );
}
