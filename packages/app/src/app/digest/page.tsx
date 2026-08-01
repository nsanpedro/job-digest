import type { Ruleset } from '@job-digest/core';
import {
  getActiveRuleset,
  getApplicationCounts,
  getDigest,
  getSavedCount,
  getUnreadEmails,
  NoActiveRulesetError,
  weekWindow,
  type Digest,
} from '@job-digest/db';
import { TopBar } from '@/components/Chrome';
import { DigestHeader } from '@/components/DigestHeader';
import { DigestList } from '@/components/DigestList';
import { ParseBanner } from '@/components/ParseBanner';
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
        <>
          <TopBar active="digest" unreadCount={0} savedCount={0} userEmail={user.email} />
          <div className="container">
            <p style={{ marginTop: 48, color: 'var(--text-muted)' }}>
              No rules configured yet for this account. Set them up in{' '}
              <a href="/profile">Profile</a>.
            </p>
          </div>
        </>
      );
    }
    throw err;
  }

  const [unread, savedCount, applications] = await withTenant(user.id, async (tx) => [
    await getUnreadEmails(tx, user.id, weekWindow(new Date())),
    await getSavedCount(tx, user.id),
    await getApplicationCounts(tx, user.id),
  ]);

  return (
    <>
      <TopBar
        active="digest"
        unreadCount={unread.length}
        savedCount={savedCount}
        applicationCount={applications.open}
        userEmail={user.email}
      />
      <div className="container">
        <DigestHeader digest={digest} rules={rules} />
        <DigestList digest={digest} rules={rules} />
        <ParseBanner parse={digest.parse} />
      </div>
    </>
  );
}
