'use client';

import { useState } from 'react';
import type { DigestAd } from '@job-digest/db';
import { AdCard } from './AdCard';
import { DismissFollowUp } from './DismissFollowUp';
import { useDismissFollowUps } from './dismiss-follow-ups';

/**
 * Client wrapper for the explore page — manages the per-card accordion state
 * so the Server Component (ExplorePage) can pass serializable DigestAd[] without
 * crossing the Server→Client function-prop boundary that Next.js prohibits.
 */
export function ExploreList({ ads }: { ads: DigestAd[] }) {
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const toggle = (id: string) => setExpandedId((cur) => (cur === id ? null : id));
  const followUps = useDismissFollowUps(ads);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {followUps.items.map((item, i) =>
        item.kind === 'followUp' ? (
          <DismissFollowUp key={item.ad.id} ad={item.ad} onClose={() => followUps.close(item.ad.id)} />
        ) : (
          <AdCard
            key={item.ad.id}
            ad={item.ad}
            expanded={expandedId === item.ad.id}
            onToggle={() => toggle(item.ad.id)}
            onDismissed={(ad) => followUps.onDismissed(ad, i)}
          />
        ),
      )}
    </div>
  );
}
