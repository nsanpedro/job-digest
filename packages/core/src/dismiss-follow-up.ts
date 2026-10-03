/**
 * Where a just-dismissed card's follow-up row sits (ADR-003 §8.11, and the
 * "Dismiss reason UX" amendment after it). Pure list bookkeeping, kept here
 * rather than in the app because the app has no test runner.
 *
 * A dismiss moves the ad out of its list as soon as the server re-splits the
 * digest (I10). Without this, the optional "why?" row would vanish with the
 * card. The row keeps the card's place until the user closes it (or Undo) or
 * leaves the page; nothing about it is stored.
 *
 * One state holds every list on a page, each dismissal tagged with the list
 * it came from. The state lives above the lists, so a list that the server
 * empties (the last curated ad dismissed → the digest's empty layout) does
 * not take its follow-up rows with it.
 */
import type { DismissReason } from './feedback';

export interface RecentDismissal<T extends { id: string }> {
  /** The ad as it was shown when dismissed — the row outlives the server's copy. */
  ad: T;
  /** Which list on the page it was dismissed from (e.g. "curated", "worth"). */
  list: string;
  /** Position among the displayed items when it was dismissed. */
  index: number;
  /** Set when the user dismissed with a reason from the card itself. */
  reason: DismissReason | null;
}

/** Keyed by ad id. */
export type FollowUpState<T extends { id: string }> = ReadonlyMap<string, RecentDismissal<T>>;

export type FollowUpAction<T extends { id: string }> =
  | { type: 'dismissed'; ad: T; list: string; index: number; reason: DismissReason | null }
  | { type: 'closed'; id: string };

export function followUpReducer<T extends { id: string }>(
  state: FollowUpState<T>,
  action: FollowUpAction<T>,
): FollowUpState<T> {
  switch (action.type) {
    case 'dismissed': {
      const next = new Map(state);
      next.set(action.ad.id, { ad: action.ad, list: action.list, index: action.index, reason: action.reason });
      return next;
    }
    case 'closed': {
      if (!state.has(action.id)) return state;
      const next = new Map(state);
      next.delete(action.id);
      return next;
    }
  }
}

export type FollowUpItem<T> =
  | { kind: 'card'; ad: T }
  | { kind: 'followUp'; ad: T; reason: DismissReason | null };

/**
 * The displayed items of one list: its cards, with each of this list's
 * recent dismissals in its card's place — in place if the ad is still in
 * `ads` (Saved keeps dismissed ads), re-inserted at its old position if the
 * server already moved it out. With `ads` empty, only the follow-up rows.
 */
export function followUpItems<T extends { id: string }>(
  ads: readonly T[],
  state: FollowUpState<T>,
  list: string,
): FollowUpItem<T>[] {
  const mine = [...state.values()].filter((r) => r.list === list);
  const byId = new Map(mine.map((r) => [r.ad.id, r]));
  const items: FollowUpItem<T>[] = ads.map((ad) => {
    const r = byId.get(ad.id);
    return r ? { kind: 'followUp', ad: r.ad, reason: r.reason } : { kind: 'card', ad };
  });
  const present = new Set(ads.map((a) => a.id));
  const moved = mine.filter((r) => !present.has(r.ad.id)).sort((a, b) => a.index - b.index);
  for (const r of moved) {
    items.splice(Math.min(r.index, items.length), 0, { kind: 'followUp', ad: r.ad, reason: r.reason });
  }
  return items;
}

/** True when `list` still has a follow-up row to show, whatever its ads. */
export function hasFollowUps<T extends { id: string }>(state: FollowUpState<T>, list: string): boolean {
  for (const r of state.values()) if (r.list === list) return true;
  return false;
}
