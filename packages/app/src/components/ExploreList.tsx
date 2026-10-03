'use client';

import { useState } from 'react';
import type { DigestAd } from '@job-digest/db';
import { DismissableAdList } from './DismissableAdList';
import { useDismissFollowUps } from './dismiss-follow-ups';

/**
 * Client wrapper for the explore page — manages the per-card accordion state
 * so the Server Component (ExplorePage) can pass serializable DigestAd[] without
 * crossing the Server→Client function-prop boundary that Next.js prohibits.
 *
 * Owns the empty line too: the page keeps this mounted when the server
 * empties the list, so dismissing the last ad keeps its follow-up row.
 */
export function ExploreList({ ads, empty }: { ads: DigestAd[]; empty: string }) {
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const followUps = useDismissFollowUps();

  if (ads.length === 0 && !followUps.has('explore')) {
    return <p style={{ color: 'var(--text-muted)', fontSize: 14, marginTop: 24 }}>{empty}</p>;
  }

  return (
    <DismissableAdList
      list="explore"
      ads={ads}
      followUps={followUps}
      expandedId={expandedId}
      onToggle={(id) => setExpandedId((cur) => (cur === id ? null : id))}
      style={{ display: 'flex', flexDirection: 'column', gap: 12 }}
    />
  );
}
