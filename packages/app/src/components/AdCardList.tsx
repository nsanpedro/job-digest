'use client';

import { useState } from 'react';
import type { DigestAd } from '@job-digest/db';
import { DismissableAdList } from './DismissableAdList';
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
  const followUps = useDismissFollowUps();

  if (ads.length === 0 && !followUps.has('list')) return <p className={styles.empty}>{empty}</p>;

  return (
    <DismissableAdList
      list="list"
      ads={ads}
      followUps={followUps}
      expandedId={expandedId}
      onToggle={(id) => setExpandedId((cur) => (cur === id ? null : id))}
      className={styles.list}
    />
  );
}
