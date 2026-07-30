'use client';

import { useState } from 'react';
import type { DigestAd } from '@job-digest/db';
import { AdCard } from './AdCard';
import styles from './DigestList.module.css';

/**
 * The accordion behavior factored out of DigestList so Saved (and any
 * future standalone ad list) gets the same "one expanded at a time" rule
 * (design: "Un solo aviso expandido a la vez") without depending on the
 * digest's visible/dismissed split.
 */
export function AdCardList({ ads, empty }: { ads: DigestAd[]; empty: string }) {
  const [expandedId, setExpandedId] = useState<string | null>(null);

  if (ads.length === 0) return <p className={styles.empty}>{empty}</p>;

  return (
    <div className={styles.list}>
      {ads.map((ad) => (
        <AdCard
          key={ad.id}
          ad={ad}
          expanded={expandedId === ad.id}
          onToggle={() => setExpandedId((id) => (id === ad.id ? null : ad.id))}
        />
      ))}
    </div>
  );
}
