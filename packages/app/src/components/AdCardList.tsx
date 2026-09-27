'use client';

import { useState } from 'react';
import type { DigestAd } from '@job-digest/db';
import { AdCard } from './AdCard';
import { DismissFollowUp } from './DismissFollowUp';
import { useDismissFollowUps } from './dismiss-follow-ups';
import styles from './DigestList.module.css';

/**
 * The accordion behavior factored out of DigestList so Saved (and any
 * future standalone ad list) gets the same "one expanded at a time" rule
 * (design: "Un solo aviso expandido a la vez") without depending on the
 * digest's visible/dismissed split.
 */
export function AdCardList({ ads, empty }: { ads: DigestAd[]; empty: string }) {
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const followUps = useDismissFollowUps(ads);

  if (followUps.items.length === 0) return <p className={styles.empty}>{empty}</p>;

  return (
    <div className={styles.list}>
      {followUps.items.map((item, i) =>
        item.kind === 'followUp' ? (
          <DismissFollowUp key={item.ad.id} ad={item.ad} onClose={() => followUps.close(item.ad.id)} />
        ) : (
          <AdCard
            key={item.ad.id}
            ad={item.ad}
            expanded={expandedId === item.ad.id}
            onToggle={() => setExpandedId((id) => (id === item.ad.id ? null : item.ad.id))}
            onDismissed={(ad) => followUps.onDismissed(ad, i)}
          />
        ),
      )}
    </div>
  );
}
