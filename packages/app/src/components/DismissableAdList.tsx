'use client';

import type { CSSProperties } from 'react';
import type { DigestAd } from '@job-digest/db';
import { AdCard } from './AdCard';
import { DismissFollowUp } from './DismissFollowUp';
import type { DismissFollowUps } from './dismiss-follow-ups';

/**
 * One list of ad cards where a dismissed card becomes its follow-up row in
 * place. Renders nothing when the list has neither cards nor rows, so a
 * caller can always mount it — which is what keeps a follow-up visible
 * after the server has emptied the list.
 */
export function DismissableAdList({
  list,
  ads,
  followUps,
  expandedId,
  onToggle,
  className,
  style,
}: {
  /** Key of this list among the page's lists (see useDismissFollowUps). */
  list: string;
  ads: readonly DigestAd[];
  followUps: DismissFollowUps;
  expandedId: string | null;
  onToggle: (id: string) => void;
  className?: string;
  style?: CSSProperties;
}) {
  const items = followUps.itemsFor(list, ads);
  if (items.length === 0) return null;
  return (
    <div className={className} style={style}>
      {items.map((item, i) =>
        item.kind === 'followUp' ? (
          <DismissFollowUp
            key={item.ad.id}
            ad={item.ad}
            initialReason={item.reason}
            onClose={() => followUps.close(item.ad.id)}
          />
        ) : (
          <AdCard
            key={item.ad.id}
            ad={item.ad}
            expanded={expandedId === item.ad.id}
            onToggle={() => onToggle(item.ad.id)}
            onDismissed={(ad, reason) => followUps.onDismissed(list, ad, i, reason)}
          />
        ),
      )}
    </div>
  );
}
