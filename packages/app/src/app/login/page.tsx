import { signIn } from '@/auth';
import styles from './page.module.css';

/**
 * Real sign-in. Identity only (openid/email/profile) — this does NOT grant
 * mailbox access (design §4.1/§4.5, split 31 Jul). Signing in and connecting
 * a mailbox used to be the same OAuth grant; that meant Google's
 * restricted-scope gate (Testing mode's test-user list, or a paid CASA
 * assessment to go public) blocked *signing in at all*, not just connecting
 * Gmail. Splitting them means anyone can create an account — connecting a
 * mailbox (Gmail via "Connect Gmail" in Profile, or forwarding, which needs
 * no Google involvement at all) is a separate, later, opt-in step.
 */

const ERROR_COPY: Record<string, string> = {
  AccessDenied: 'Google refused this sign-in. Try again, or use a different Google account.',
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
          Sign in with Google to create your account and see your weekly digest. This step alone
          never touches a mailbox — you connect one afterward, from Profile.
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
          <ScopeRow ok>Just your name and email — this app never sees your mailbox yet.</ScopeRow>
          <ScopeRow ok>Never applies to a job or answers a recruiter on your behalf.</ScopeRow>
        </div>

        <p className={styles.note}>
          After signing in, connect a mailbox from Profile — Gmail (read-only, revocable any
          time) or a forwarding address that works with any provider and never grants us access
          at all.
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
