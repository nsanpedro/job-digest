import { getSavedAds } from '@job-digest/db';
import { AdCardList } from '@/components/AdCardList';
import { currentUser, withTenant } from '@/lib/session';

export const dynamic = 'force-dynamic';

export default async function SavedPage() {
  const user = await currentUser();
  const saved = await withTenant(user.id, (tx) => getSavedAds(tx, user.id));

  return (
    <div className="container">
      <h1 style={{ fontSize: 27, fontWeight: 600, letterSpacing: '-0.015em', margin: '32px 0 8px' }}>Saved</h1>
      <p style={{ fontSize: 13, color: 'var(--text-muted)', margin: '0 0 28px' }}>
        Ads you saved for later, regardless of which week they arrived in.
      </p>
      <AdCardList ads={saved} empty="Nothing saved yet — use “Save for later” on a card in the digest." />
    </div>
  );
}
