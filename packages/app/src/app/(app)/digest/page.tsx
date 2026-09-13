import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { eur, type Ruleset } from '@job-digest/core';
import { getActiveRuleset, getDigest, NoActiveRulesetError, summarizeWeek, type Digest } from '@job-digest/db';
import { DigestHeader } from '@/components/DigestHeader';
import { DigestList } from '@/components/DigestList';
import { ParseBanner } from '@/components/ParseBanner';
import { WeekSummary } from '@/components/WeekSummary';
import { SKIP_GMAIL_COOKIE } from '@/lib/gmail-actions';
import { getGmailMailboxStatus } from '@/lib/mailbox-status';
import { getIsOnboarded } from '@/lib/onboarding-actions';
import { currentUser, withTenant } from '@/lib/session';

// Reads live data and drives server-action revalidation — never statically cached.
export const dynamic = 'force-dynamic';
// "Update now" schedules its Gmail fetch via after() (see startRefresh in
// lib/actions.ts), which keeps running past the client's request but is
// still bounded by this route's execution budget. 60s is Vercel Hobby's
// ceiling — raise it if the plan changes, and this is still unverified
// against a mailbox large enough to actually hit it.
export const maxDuration = 60;

export default async function DigestPage() {
  const user = await currentUser();

  // B1: bounce onboarded users without a working Gmail to the connect
  // page — the "no mailbox / expired / auth_failed" case that made the
  // PM test user autoconclude "no habrá mucho esta semana" when the
  // real cause was Testing-mode's 7-day cliff and a missing token.
  //
  // Only fires for onboarded users: a fresh account still has the
  // OnboardingModal in front of it (layout.tsx:37), and that modal owns
  // the first-time Gmail grant. Bouncing them here would race that flow.
  // The dismiss cookie stops the loop for a week (see gmail-actions.ts);
  // the status banner in the (app) layout keeps the state visible until
  // the user acts.
  const [isOnboarded, gmailState, cookieStore] = await Promise.all([
    getIsOnboarded(),
    getGmailMailboxStatus(user.id),
    cookies(),
  ]);
  const skipped = cookieStore.get(SKIP_GMAIL_COOKIE)?.value === '1';
  if (isOnboarded && gmailState.status === 'missing' && !skipped) {
    redirect('/onboarding/connect-gmail');
  }

  let digest: Digest;
  let rules: Ruleset;
  try {
    const loaded = await withTenant(user.id, async (tx) => {
      const d = await getDigest(tx, user.id);
      const r = await getActiveRuleset(tx, user.id);
      return { d, r: r.rules };
    });
    digest = loaded.d;
    rules = loaded.r;
  } catch (err) {
    if (err instanceof NoActiveRulesetError) {
      return (
        <div className="container">
          <p style={{ marginTop: 48, color: 'var(--text-muted)' }}>
            No rules configured yet for this account. Set them up in <a href="/profile">Profile</a>.
          </p>
        </div>
      );
    }
    throw err;
  }

  return (
    <div className="container">
      <DigestHeader digest={digest} rules={rules} />
      {/*
        Pure derivation over the digest already loaded — no second query. The
        floor is passed rather than looked up inside so the summary stays a
        function of what the page already knows (I6's shape).
      */}
      <WeekSummary summary={summarizeWeek(digest)} payFloor={eur(rules.Pay.condition.minMonthly)} />
      <DigestList digest={digest} rules={rules} />
      {digest.explore.length > 0 && (
        <p style={{ marginTop: 8, fontSize: 13, color: 'var(--text-faint)' }}>
          <a href="/digest/explore" style={{ color: 'var(--text-muted)', textDecoration: 'none' }}>
            See everything we filtered out ({digest.explore.length} ad{digest.explore.length === 1 ? '' : 's'}) →
          </a>
        </p>
      )}
      <ParseBanner parse={digest.parse} />
    </div>
  );
}
