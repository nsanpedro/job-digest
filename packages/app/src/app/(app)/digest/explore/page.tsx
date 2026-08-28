import { getActiveRuleset, getDigest, NoActiveRulesetError } from '@job-digest/db';
import { ExploreList } from '@/components/ExploreList';
import { currentUser, withTenant } from '@/lib/session';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

export default async function ExplorePage() {
  const user = await currentUser();

  let explore: Awaited<ReturnType<typeof getDigest>>['explore'];
  let preFilterMisses: number;
  let belowThreshold: number;

  try {
    const loaded = await withTenant(user.id, async (tx) => {
      const d = await getDigest(tx, user.id);
      await getActiveRuleset(tx, user.id); // validates ruleset exists
      return d;
    });
    explore = loaded.explore;
    preFilterMisses = loaded.metrics.explore?.preFilterMisses ?? 0;
    belowThreshold = loaded.metrics.explore?.belowThreshold ?? 0;
  } catch (err) {
    if (err instanceof NoActiveRulesetError) {
      return (
        <div className="container">
          <p style={{ marginTop: 48, color: 'var(--text-muted)' }}>
            No rules configured. Set them up in <a href="/profile">Profile</a>.
          </p>
        </div>
      );
    }
    throw err;
  }

  return (
    <div className="container">
      <div style={{ marginBottom: 32 }}>
        <a
          href="/digest"
          style={{ fontSize: 13, color: 'var(--text-muted)', textDecoration: 'none' }}
        >
          ← Back to digest
        </a>
      </div>

      <h1 style={{ fontSize: 20, fontWeight: 600, marginBottom: 8 }}>Everything we filtered out</h1>

      {explore.length === 0 ? (
        <p style={{ color: 'var(--text-muted)', fontSize: 14, marginTop: 24 }}>
          Nothing was filtered out this week.
        </p>
      ) : (
        <>
          <p style={{ fontSize: 13, color: 'var(--text-muted)', marginBottom: 24, lineHeight: 1.5 }}>
            {preFilterMisses > 0 && (
              <>{preFilterMisses} removed by location or direction filter. </>
            )}
            {belowThreshold > 0 && (
              <>{belowThreshold} scored below the match threshold.</>
            )}
          </p>

          <ExploreList ads={explore} />
        </>
      )}
    </div>
  );
}
