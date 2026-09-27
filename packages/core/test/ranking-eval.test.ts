import { describe, expect, it } from 'vitest';
import {
  aggregateMetrics,
  labelFromState,
  rankingMetrics,
  type Label,
  type RankedItem,
} from '../src/ranking-eval';

const list = (...labels: Array<Label | null>): RankedItem[] =>
  labels.map((label, i) => ({ id: `ad-${i}`, label }));

describe('labelFromState', () => {
  it('applied wins over everything, dismissed over saved', () => {
    expect(labelFromState({ applied: true, saved: false, dismissed: true })).toBe('applied');
    expect(labelFromState({ applied: false, saved: true, dismissed: true })).toBe('dismissed');
    expect(labelFromState({ applied: false, saved: true, dismissed: false })).toBe('saved');
    expect(labelFromState({ applied: false, saved: false, dismissed: false })).toBeNull();
  });
});

describe('rankingMetrics', () => {
  it('a perfect ordering scores 1.0 on pairs and nDCG', () => {
    const m = rankingMetrics(list('applied', 'saved', null, 'dismissed'), 10);
    expect(m.pairwiseAccuracy).toBe(1);
    expect(m.ndcgAtK).toBeCloseTo(1);
    expect(m.recallAtK).toBe(1);
  });

  it('a fully inverted ordering scores 0 on pairs', () => {
    const m = rankingMetrics(list('dismissed', 'dismissed', 'saved'), 10);
    expect(m.pairwiseAccuracy).toBe(0);
    expect(m.concordantPairs).toBe(0);
    expect(m.totalPairs).toBe(2);
  });

  it('counts only the pairs a positive actually wins', () => {
    // saved beats the dismissed below it, loses to the one above.
    const m = rankingMetrics(list('dismissed', 'saved', 'dismissed'), 10);
    expect(m.concordantPairs).toBe(1);
    expect(m.pairwiseAccuracy).toBeCloseTo(0.5);
  });

  it('unlabelled ads are neither hits nor misses', () => {
    const withGaps = rankingMetrics(list(null, null, 'saved', null, 'dismissed'), 10);
    expect(withGaps.pairwiseAccuracy).toBe(1);
    expect(withGaps.negativesAtK).toBe(1);
  });

  it('respects k for the top-of-list counts', () => {
    const m = rankingMetrics(list(null, 'dismissed', 'saved', 'applied'), 2);
    expect(m.positivesAtK).toBe(0);
    expect(m.negativesAtK).toBe(1);
    expect(m.recallAtK).toBe(0);
    expect(m.ndcgAtK).toBe(0);
  });

  it('applied outweighs saved in nDCG', () => {
    const appliedFirst = rankingMetrics(list('applied', 'saved'), 1).ndcgAtK!;
    const savedFirst = rankingMetrics(list('saved', 'applied'), 1).ndcgAtK!;
    expect(appliedFirst).toBeGreaterThan(savedFirst);
  });

  it('undefined metrics are null, not 0 — no labels is not a bad ranking', () => {
    const m = rankingMetrics(list(null, null), 10);
    expect(m.pairwiseAccuracy).toBeNull();
    expect(m.ndcgAtK).toBeNull();
    expect(m.recallAtK).toBeNull();
  });
});

describe('aggregateMetrics', () => {
  it('pools pairs across weeks so a week with more pairs weighs more', () => {
    const a = rankingMetrics(list('saved', 'dismissed', 'dismissed', 'dismissed'), 10); // 3/3
    const b = rankingMetrics(list('dismissed', 'saved'), 10); // 0/1
    const agg = aggregateMetrics([a, b]);
    expect(agg.pairwiseAccuracy).toBeCloseTo(3 / 4);
    expect(agg.positives).toBe(2);
    expect(agg.weeks).toBe(2);
  });

  it('averages nDCG only over weeks where it is defined', () => {
    const agg = aggregateMetrics([
      rankingMetrics(list('saved'), 10),
      rankingMetrics(list(null), 10),
    ]);
    expect(agg.ndcgAtK).toBeCloseTo(1);
  });
});
