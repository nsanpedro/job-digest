import type { Ruleset } from '@job-digest/core';
import { getActiveRuleset, getDigest, getUnreadEmails, NoActiveRulesetError, weekWindow, type Digest } from '@job-digest/db';
import { TopBar } from '@/components/Chrome';
import { DigestHeader } from '@/components/DigestHeader';
import { DigestList } from '@/components/DigestList';
import { ParseBanner } from '@/components/ParseBanner';
import { currentUserId, withTenant } from '@/lib/session';

// Reads live data and drives server-action revalidation — never statically cached.
export const dynamic = 'force-dynamic';

export default async function DigestPage() {
  const userId = await currentUserId();

  let digest: Digest;
  let rules: Ruleset;
  try {
    const loaded = await withTenant(userId, async (tx) => {
      const d = await getDigest(tx, userId);
      const r = await getActiveRuleset(tx, userId);
      return { d, r: r.rules };
    });
    digest = loaded.d;
    rules = loaded.r;
  } catch (err) {
    if (err instanceof NoActiveRulesetError) {
      return (
        <>
          <TopBar active="digest" unreadCount={0} />
          <div className="container">
            <p style={{ marginTop: 48, color: 'var(--text-muted)' }}>
              No rules configured yet for this account. (Profile / rules screen is not built —
              design §, "Pendiente: pantalla 3".)
            </p>
          </div>
        </>
      );
    }
    throw err;
  }

  const unread = await withTenant(userId, (tx) => getUnreadEmails(tx, userId, weekWindow(new Date())));

  return (
    <>
      <TopBar active="digest" unreadCount={unread.length} />
      <div className="container">
        <DigestHeader digest={digest} rules={rules} />
        <DigestList digest={digest} rules={rules} />
        <ParseBanner parse={digest.parse} />
      </div>
    </>
  );
}
