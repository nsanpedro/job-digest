import type { Ruleset } from '@job-digest/core';
import {
  getActiveRuleset,
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

  const [unread, savedCount] = await withTenant(user.id, async (tx) => [
    await getUnreadEmails(tx, user.id, weekWindow(new Date())),
    await getSavedCount(tx, user.id),
  ]);

  return (
    <>
      <TopBar active="digest" unreadCount={unread.length} savedCount={savedCount} userEmail={user.email} />
      <div className="container">
        <DigestHeader digest={digest} rules={rules} />
        <DigestList digest={digest} rules={rules} />
        <ParseBanner parse={digest.parse} />
      </div>
    </>
  );
}
