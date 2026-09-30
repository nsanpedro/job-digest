import { useCallback, useReducer } from 'react';
import { followUpItems, followUpReducer, hasFollowUps, type DismissReason } from '@job-digest/core';
import type { DigestAd } from '@job-digest/db';

/**
 * Keeps a just-dismissed card's place in its list as a DismissFollowUp row
 * (ADR-003 §8.11 and its "Dismiss reason UX" amendment), so the optional
 * "why?" sits where the user was looking. The bookkeeping is
 * `followUpReducer` / `followUpItems` in @job-digest/core (pure, tested);
 * this is only the React wiring.
 *
 * Call it once per page, above every list that can dismiss: a list the
 * server empties (the last curated ad dismissed) must not take its
 * follow-up rows with it, so the state cannot live inside the list.
 */
export function useDismissFollowUps() {
  const [state, dispatch] = useReducer(followUpReducer<DigestAd>, new Map());
  const onDismissed = useCallback(
    (list: string, ad: DigestAd, index: number, reason: DismissReason | null) =>
      dispatch({ type: 'dismissed', ad, list, index, reason }),
    [],
  );
  const close = useCallback((id: string) => dispatch({ type: 'closed', id }), []);
  return {
    itemsFor: (list: string, ads: readonly DigestAd[]) => followUpItems(ads, state, list),
    has: (list: string) => hasFollowUps(state, list),
    onDismissed,
    close,
  };
}

export type DismissFollowUps = ReturnType<typeof useDismissFollowUps>;
