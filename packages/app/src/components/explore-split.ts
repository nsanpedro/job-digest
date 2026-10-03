import type { DigestAd } from '@job-digest/db';

/**
 * How the explore list is laid out on the digest page (ADR-003 §9): the first
 * `n` *scored* ads are "Worth a look", everything else — the rest of the
 * scored ads and every unscored pre-filter miss — sits under "Hidden".
 *
 * Only a scored ad can be a near-miss: a pre-filter miss (wrong direction,
 * below the target level, muted company) has no score to be close to the bar
 * with. Explore arrives sorted by score desc, so the scored ads that qualify
 * are the n strongest, each below every match (I29).
 *
 * One function so the page and `placementOf` ("where did my overridden ad
 * go?") cannot disagree about which section an ad is in.
 */
export function splitExplore<T extends Pick<DigestAd, 'id' | 'scoreBreakdown'>>(
  explore: readonly T[],
  n: number,
): { worthALook: T[]; hidden: T[] } {
  const worthALook = explore.filter((a) => a.scoreBreakdown !== null).slice(0, n);
  const lookIds = new Set(worthALook.map((a) => a.id));
  return { worthALook, hidden: explore.filter((a) => !lookIds.has(a.id)) };
}
