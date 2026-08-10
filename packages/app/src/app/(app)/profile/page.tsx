import { DEFAULT_MODE, DEFAULT_RULESET, type Mode } from '@job-digest/core';
import { getAccountOverview, getActiveProfile, getActiveRuleset, listDirections, NoActiveRulesetError } from '@job-digest/db';
import { signIn } from '@/auth';
import { CvIntake } from '@/components/CvIntake';
import { DirectionCard } from '@/components/DirectionCard';
import { ForwardingConnect } from '@/components/ForwardingConnect';
import { ModePicker } from '@/components/ModePicker';
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

  const [ruleset, account, profile, directions] = await withTenant(user.id, async (tx) => {
    let rs: { version: number; savedRules: typeof DEFAULT_RULESET; mode: Mode };
    try {
      rs = await getActiveRuleset(tx, user.id);
    } catch (err) {
      if (!(err instanceof NoActiveRulesetError)) throw err;
      rs = { version: 0, savedRules: DEFAULT_RULESET, mode: DEFAULT_MODE };
    }
    const acct = await getAccountOverview(tx, user.id);
    // Role discovery from a CV (docs/adr-001-role-discovery.md §3) — no
    // active profile yet just means nobody has uploaded a CV, not an error.
    const prof = await getActiveProfile(tx, user.id);
    const dirs = prof ? await listDirections(tx, user.id, prof.version) : [];
    return [rs, acct, prof, dirs] as const;
  });

  return (
    <div className="container">
        <h1 className={styles.h1}>Profile</h1>

        <div className={styles.section}>
          <p className={styles.sectionLabel}>Role discovery</p>
          <CvIntake />
          {directions.length > 0 && profile && (
            <div style={{ marginTop: 4 }}>
              {directions.map((d) => (
                <DirectionCard key={d.id} direction={d} skills={profile.skills} />
              ))}
            </div>
          )}
        </div>

        <div className={styles.section}>
          <p className={styles.sectionLabel}>Search mode</p>
          <ModePicker mode={ruleset.mode} rules={ruleset.savedRules} />
        </div>

        <div className={styles.section}>
          <p className={styles.sectionLabel}>Filtering rules</p>
          {ruleset.version === 0 && (
            <p style={{ fontSize: 13, color: 'var(--text-muted)', marginBottom: 14 }}>
              No rules saved yet — starting from sensible defaults. Adjust and save to activate
              them.
            </p>
          )}
          {/*
            The authored rules, deliberately — not the mode-adjusted ones from
            getActiveRuleset().rules. Editing the demoted copy would rewrite
            every hard rule into a preference the moment someone saved while in
            urgent mode.
          */}
          <RulesEditor initialRules={ruleset.savedRules} version={ruleset.version} />
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
              <p className={styles.empty}>No mailbox connected yet.</p>
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

          <div style={{ marginTop: 16, display: 'flex', flexDirection: 'column', gap: 16 }}>
            <div>
              <form
                action={async () => {
                  'use server';
                  await signIn('google-gmail', { redirectTo: '/profile' });
                }}
              >
                <button
                  type="submit"
                  style={{
                    padding: '9px 16px',
                    borderRadius: 5,
                    border: '1px solid var(--border)',
                    background: '#fff',
                    fontSize: 13,
                    fontWeight: 500,
                    cursor: 'pointer',
                    fontFamily: 'var(--font-sans)',
                  }}
                >
                  Connect Gmail
                </button>
              </form>
              <p style={{ fontSize: 12, color: 'var(--text-faint)', marginTop: 8, maxWidth: 480 }}>
                Read-only OAuth access to Gmail. Only works today for accounts added as test users
                in Google Cloud Console — Testing-mode grants also expire roughly every 7 days
                until the app is verified (design §4.1); reconnect here to renew.
              </p>
            </div>

            <div>
              <ForwardingConnect
                existingAddress={
                  account?.mailboxes.find((mb) => mb.authKind === 'forwarding')?.emailAddress ?? null
                }
              />
            </div>
          </div>
        </div>
      </div>
  );
}
