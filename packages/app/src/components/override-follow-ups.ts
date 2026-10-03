import { useCallback, useEffect, useState } from 'react';
import type { DigestAd, DismissedAd } from '@job-digest/db';
import { splitExplore } from './explore-split';

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
 * how DigestList lays out the page: the matches in one list, then the first
 * `worthALookN` scored ads of Explore, then the rest behind a disclosure
 * (`splitExplore`).
 */
export function placementOf(
  adId: string,
  matches: readonly Pick<DigestAd, 'id'>[],
  explore: readonly Pick<DigestAd, 'id' | 'scoreBreakdown'>[],
  worthALookN: number,
): Placement | null {
  if (matches.some((a) => a.id === adId)) return 'matches';
  const { worthALook, hidden } = splitExplore(explore, worthALookN);
  if (worthALook.some((a) => a.id === adId)) return 'worthALook';
  return hidden.some((a) => a.id === adId) ? 'hidden' : null;
}

interface RecentOverride {
  ad: DismissedAd;
  /** Position in the displayed list when it was overridden. */
  index: number;
  /** The re-split has placed the ad somewhere on the page at least once. */
  placed: boolean;
}

/**
 * The next follow-up map after a re-split, or `null` when nothing changed.
 * A follow-up is marked placed once its ad shows up on the page. A placed ad
 * that is held again was un-overridden (Hide again on its card): the
 * follow-up has nothing true left to say, so it closes. Before the first
 * placement the ad is still held because the re-split has not happened yet,
 * and the follow-up stays.
 */
export function settleOverrides(
  recent: ReadonlyMap<string, RecentOverride>,
  heldIds: ReadonlySet<string>,
  placementOf: (adId: string) => Placement | null,
): ReadonlyMap<string, RecentOverride> | null {
  let next: Map<string, RecentOverride> | null = null;
  for (const [id, r] of recent) {
    if (!r.placed && placementOf(id) !== null) {
      next ??= new Map(recent);
      next.set(id, { ...r, placed: true });
    } else if (r.placed && heldIds.has(id)) {
      next ??= new Map(recent);
      next.delete(id);
    }
  }
  return next;
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

export function useOverrideFollowUps(
  held: readonly DismissedAd[],
  placementOf: (adId: string) => Placement | null,
) {
  const [recent, setRecent] = useState<ReadonlyMap<string, RecentOverride>>(new Map());
  useEffect(() => {
    const next = settleOverrides(recent, new Set(held.map((a) => a.id)), placementOf);
    if (next) setRecent(next);
  }, [held, recent, placementOf]);
  const onOverridden = useCallback((ad: DismissedAd, index: number) => {
    setRecent((prev) => new Map(prev).set(ad.id, { ad, index, placed: false }));
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
