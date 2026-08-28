'use client';

import { useState } from 'react';
import type { DigestAd } from '@job-digest/db';
import { AdCard } from './AdCard';

/**
 * Client wrapper for the explore page — manages the per-card accordion state
 * so the Server Component (ExplorePage) can pass serializable DigestAd[] without
 * crossing the Server→Client function-prop boundary that Next.js prohibits.
 */
export function ExploreList({ ads }: { ads: DigestAd[] }) {
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const toggle = (id: string) => setExpandedId((cur) => (cur === id ? null : id));

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {ads.map((ad) => (
        <AdCard
          key={ad.id}
          ad={ad}
          expanded={expandedId === ad.id}
          onToggle={() => toggle(ad.id)}
        />
      ))}
    </div>
  );
}
