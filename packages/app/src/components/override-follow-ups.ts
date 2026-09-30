import { useCallback, useState } from 'react';
import type { DigestAd, DismissedAd } from '@job-digest/db';

/**
 * "Show anyway" makes a rule-blocked ad eligible again, not guaranteed a slot
 * (ADR-003 §8.14): once the server re-splits the digest it may be among the
 * matches, in "Worth a look", or folded into the collapsed "Hidden" list.
 * Without a trace in the section the user clicked in, the last case reads as
 * the ad vanishing. This keeps the row's place as an OverrideFollowUp that
 * says where the ad went, until the user closes it or leaves the page;
 * nothing about it is stored.
 */

/** Where an ad sits on the digest page. `null`: not placed yet (the re-split is in flight). */
export type Placement = 'matches' | 'worthALook' | 'hidden';

/**
 * Pure, so the page can compute it from the digest it already holds. Mirrors
 * how DigestList lays out the page: every tier plus Still open in one list,
 * then the first `worthALookN` of Explore, then the rest behind a disclosure.
 */
export function placementOf(
  adId: string,
  matches: readonly Pick<DigestAd, 'id'>[],
  explore: readonly Pick<DigestAd, 'id'>[],
  worthALookN: number,
): Placement | null {
  if (matches.some((a) => a.id === adId)) return 'matches';
  const i = explore.findIndex((a) => a.id === adId);
  if (i === -1) return null;
  return i < worthALookN ? 'worthALook' : 'hidden';
}

interface RecentOverride {
  ad: DismissedAd;
  /** Position in the displayed list when it was overridden. */
  index: number;
}

export type HeldItem = { kind: 'row'; ad: DismissedAd } | { kind: 'followUp'; ad: DismissedAd };

/**
 * Same shape as `interleaveFollowUps` for dismissals: each recent override
 * shown in its row's place — in place while the ad is still listed as held,
 * re-inserted at its old position once the server has moved it out.
 */
export function interleaveOverrides(
  held: readonly DismissedAd[],
  recent: ReadonlyMap<string, RecentOverride>,
): HeldItem[] {
  const items: HeldItem[] = held.map((ad) =>
    recent.has(ad.id) ? { kind: 'followUp', ad: recent.get(ad.id)!.ad } : { kind: 'row', ad },
  );
  const present = new Set(held.map((a) => a.id));
  const moved = [...recent.values()].filter((r) => !present.has(r.ad.id)).sort((a, b) => a.index - b.index);
  for (const r of moved) items.splice(Math.min(r.index, items.length), 0, { kind: 'followUp', ad: r.ad });
  return items;
}

export function useOverrideFollowUps(held: readonly DismissedAd[]) {
  const [recent, setRecent] = useState<ReadonlyMap<string, RecentOverride>>(new Map());
  const onOverridden = useCallback((ad: DismissedAd, index: number) => {
    setRecent((prev) => new Map(prev).set(ad.id, { ad, index }));
  }, []);
  const close = useCallback((id: string) => {
    setRecent((prev) => {
      const next = new Map(prev);
      next.delete(id);
      return next;
    });
  }, []);
  return { items: interleaveOverrides(held, recent), count: recent.size, onOverridden, close };
}
