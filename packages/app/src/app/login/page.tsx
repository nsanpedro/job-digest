import { signIn } from '@/auth';
import styles from './page.module.css';

/**
 * Real sign-in (design's login screen, redefined 30 Jul): Google only, no
 * IMAP path. One consent grants both the app session and mailbox read
 * access (see src/auth.ts) — there is nothing else to choose here, so the
 * prototype's provider chooser and app-password form are gone, not stubbed.
 */

const ERROR_COPY: Record<string, string> = {
  AccessDenied:
    'Google refused this sign-in. While this app is in testing mode, only accounts added as test users in the Google Cloud Console can sign in — ask Nico to add yours.',
  Configuration: 'The Google sign-in is not configured yet (missing client ID/secret on the server).',
  OAuthAccountNotLinked: 'This Google account is already linked to a different sign-in method.',
};

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const { error } = await searchParams;
  const errorMessage = error ? (ERROR_COPY[error] ?? `Sign-in failed (${error}).`) : null;

  return (
    <div className={styles.wrap}>
      <div className={styles.card}>
        <div className={styles.brand}>
          <span className={styles.logo}>J</span>
          <span className={styles.brandLabel}>Job alert digest · Hamburg</span>
        </div>

        <h1 className={styles.h1}>Sign in</h1>
        <p className={styles.intro}>
          Sign in with Google to see your weekly digest. The same step connects the mailbox this
          reads from — Gmail, read-only.
        </p>

        {errorMessage && <div className={styles.errorBox}>{errorMessage}</div>}

        <form
          action={async () => {
            'use server';
            await signIn('google', { redirectTo: '/digest' });
          }}
        >
          <button type="submit" className={styles.googleBtn}>
            <GoogleMark />
            Continue with Google
          </button>
        </form>

        <div className={styles.scopes}>
          <ScopeRow ok>Read Gmail, read-only — nothing is sent, deleted, or moved.</ScopeRow>
          <ScopeRow ok={false}>
            Extraction is not wired up yet — connecting today does not read anything from the
            inbox on its own.
          </ScopeRow>
          <ScopeRow ok>Never applies to a job or answers a recruiter on your behalf.</ScopeRow>
        </div>

        <p className={styles.note}>
          This app is in Google&apos;s testing mode: sign-in only works for accounts explicitly
          added as test users, and the mailbox connection needs renewing roughly every 7 days
          until the app is verified.
        </p>
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
