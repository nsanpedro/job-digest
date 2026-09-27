import { useCallback, useState } from 'react';
import type { DigestAd } from '@job-digest/db';

/**
 * Keeps a just-dismissed card's place in its list as a DismissFollowUp row
 * (ADR-003 §8.x), so the optional "why?" sits where the user was looking.
 *
 * Needed because a dismiss moves the ad out of its list as soon as the
 * server re-splits the digest (I10) — without this, the follow-up would
 * vanish with the card. The row stays until the user closes it or leaves
 * the page; nothing about it is stored.
 */
interface RecentDismissal {
  ad: DigestAd;
  /** Position in the displayed list when it was dismissed. */
  index: number;
}

export type ListItem = { kind: 'card'; ad: DigestAd } | { kind: 'followUp'; ad: DigestAd };

/**
 * The displayed list: cards, with each recent dismissal shown in its card's
 * place — in place if the ad is still in `ads` (Saved keeps dismissed ads),
 * re-inserted at its old position if the server already moved it out.
 */
export function interleaveFollowUps(
  ads: readonly DigestAd[],
  recent: ReadonlyMap<string, RecentDismissal>,
): ListItem[] {
  const items: ListItem[] = ads.map((ad) =>
    recent.has(ad.id) ? { kind: 'followUp', ad: recent.get(ad.id)!.ad } : { kind: 'card', ad },
  );
  const present = new Set(ads.map((a) => a.id));
  const moved = [...recent.values()].filter((r) => !present.has(r.ad.id)).sort((a, b) => a.index - b.index);
  for (const r of moved) items.splice(Math.min(r.index, items.length), 0, { kind: 'followUp', ad: r.ad });
  return items;
}

export function useDismissFollowUps(ads: readonly DigestAd[]) {
  const [recent, setRecent] = useState<ReadonlyMap<string, RecentDismissal>>(new Map());
  const onDismissed = useCallback((ad: DigestAd, index: number) => {
    setRecent((prev) => new Map(prev).set(ad.id, { ad, index }));
  }, []);
  const close = useCallback((id: string) => {
    setRecent((prev) => {
      const next = new Map(prev);
      next.delete(id);
      return next;
    });
  }, []);
  return { items: interleaveFollowUps(ads, recent), onDismissed, close };
}
