/**
 * Offline ranking metrics — the number a calibration change has to move
 * before we call it better (ADR-003's "read the top pick and ask whether it
 * looks right", made countable).
 *
 * The labels are the user's own actions on ads: applied and saved are
 * positives (applied weighs more), dismissed is a negative, everything else
 * is unlabelled. Unlabelled is NOT a negative — most ads in a week were never
 * looked at, and scoring them as misses would punish a ranking for surfacing
 * something the user simply hasn't opened yet. So the headline metric is
 * `pairwiseAccuracy`: of every (positive, negative) pair in the week, how
 * often the ranking put the positive above. It uses only labelled ads and is
 * the least sensitive to how sparse labels are.
 *
 * Known bias, stated so nobody over-reads a small delta: the labels were
 * collected under whatever ranking was live at the time. An ad the old
 * ranking buried was less likely to be seen, so less likely to be labelled
 * at all. The eval favours the incumbent calibration; a challenger that wins
 * anyway is winning against the current.
 *
 * Pure. The I/O (which ads, which labels, which weeks) is the caller's —
 * `packages/worker/scripts/eval-ranking.ts`.
 */

export type Label = 'applied' | 'saved' | 'dismissed';

/** Graded relevance for nDCG. Dismissed is 0 — present in the pairs, absent from the gain. */
export const LABEL_GAIN: Readonly<Record<Label, number>> = { applied: 2, saved: 1, dismissed: 0 };

export const isPositive = (l: Label | null): boolean => l === 'applied' || l === 'saved';

/**
 * One ad's label from the user's state on it. Applied wins (the strongest
 * signal, and it outlives a later dismissal of the card). Between saved and
 * dismissed, dismissed wins: saving is often a first reaction and a
 * dismissal a later, deliberate one — and we store no timestamp for the
 * save to say otherwise.
 */
export function labelFromState(s: { applied: boolean; saved: boolean; dismissed: boolean }): Label | null {
  if (s.applied) return 'applied';
  if (s.dismissed) return 'dismissed';
  if (s.saved) return 'saved';
  return null;
}

export interface RankedItem {
  id: string;
  label: Label | null;
}

export interface RankingMetrics {
  k: number;
  items: number;
  positives: number;
  negatives: number;
  /** Positives in the first k. */
  positivesAtK: number;
  /** Negatives (dismissed) in the first k — the "why is this here?" count. */
  negativesAtK: number;
  /** positivesAtK / positives. Null when the week has no positives. */
  recallAtK: number | null;
  /** Graded nDCG over the first k. Null when the week has no positives. */
  ndcgAtK: number | null;
  /** Concordant (positive-above-negative) pairs. */
  concordantPairs: number;
  /** positives × negatives. */
  totalPairs: number;
  /** concordantPairs / totalPairs. Null when there is no pair to order. */
  pairwiseAccuracy: number | null;
}

function dcg(gains: readonly number[]): number {
  let sum = 0;
  for (let i = 0; i < gains.length; i++) sum += (2 ** gains[i]! - 1) / Math.log2(i + 2);
  return sum;
}

/** Metrics for one ranked list, best first. */
export function rankingMetrics(ranked: readonly RankedItem[], k: number): RankingMetrics {
  let positives = 0;
  let negatives = 0;
  let positivesAtK = 0;
  let negativesAtK = 0;
  let concordantPairs = 0;
  let positivesSoFar = 0;

  ranked.forEach((item, i) => {
    if (isPositive(item.label)) {
      positives++;
      positivesSoFar++;
      if (i < k) positivesAtK++;
    } else if (item.label === 'dismissed') {
      negatives++;
      if (i < k) negativesAtK++;
      // Every positive already walked past sits above this negative.
      concordantPairs += positivesSoFar;
    }
  });

  const gains = ranked.map((r) => (r.label ? LABEL_GAIN[r.label] : 0));
  const ideal = [...gains].sort((a, b) => b - a);
  const idcg = dcg(ideal.slice(0, k));
  const totalPairs = positives * negatives;

  return {
    k,
    items: ranked.length,
    positives,
    negatives,
    positivesAtK,
    negativesAtK,
    recallAtK: positives > 0 ? positivesAtK / positives : null,
    ndcgAtK: idcg > 0 ? dcg(gains.slice(0, k)) / idcg : null,
    concordantPairs,
    totalPairs,
    pairwiseAccuracy: totalPairs > 0 ? concordantPairs / totalPairs : null,
  };
}

export interface AggregateMetrics {
  weeks: number;
  items: number;
  positives: number;
  negatives: number;
  positivesAtK: number;
  negativesAtK: number;
  /** Pooled: Σ positivesAtK / Σ positives. */
  recallAtK: number | null;
  /** Mean over weeks that have a defined nDCG. */
  ndcgAtK: number | null;
  /** Pooled: Σ concordant / Σ pairs — weeks weigh by how many pairs they carry. */
  pairwiseAccuracy: number | null;
}

export function aggregateMetrics(weeks: readonly RankingMetrics[]): AggregateMetrics {
  const sum = (f: (m: RankingMetrics) => number) => weeks.reduce((a, m) => a + f(m), 0);
  const positives = sum((m) => m.positives);
  const positivesAtK = sum((m) => m.positivesAtK);
  const totalPairs = sum((m) => m.totalPairs);
  const ndcgs = weeks.map((m) => m.ndcgAtK).filter((n): n is number => n !== null);
  return {
    weeks: weeks.length,
    items: sum((m) => m.items),
    positives,
    negatives: sum((m) => m.negatives),
    positivesAtK,
    negativesAtK: sum((m) => m.negativesAtK),
    recallAtK: positives > 0 ? positivesAtK / positives : null,
    ndcgAtK: ndcgs.length > 0 ? ndcgs.reduce((a, b) => a + b, 0) / ndcgs.length : null,
    pairwiseAccuracy: totalPairs > 0 ? sum((m) => m.concordantPairs) / totalPairs : null,
  };
}
