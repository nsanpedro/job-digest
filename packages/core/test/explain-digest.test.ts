import { describe, expect, it } from 'vitest';
import { DIAGNOSTIC_MIN_CURATED, explainDigest, type BlockedAdSummary } from '../src/explain-digest';
import type { RuleKey, Verdict } from '../src/types';

function blockedBy(rule: RuleKey): BlockedAdSummary {
  const v: Verdict = { key: rule, severity: 'hard', state: 'block', because: [] };
  return { blockers: [v] };
}

describe('explainDigest', () => {
  it('returns [] when the digest is healthy (>= DIAGNOSTIC_MIN_CURATED curated)', () => {
    const result = explainDigest({
      inDigest: DIAGNOSTIC_MIN_CURATED,
      adsReceived: 100,
      belowThreshold: 50,
      preFilterMisses: 20,
      ruleBlocked: [blockedBy('Pay')],
    });
    expect(result).toEqual([]);
  });

  it('names the top blocking rule when it blocked ≥3 ads', () => {
    const result = explainDigest({
      inDigest: 1,
      adsReceived: 100,
      belowThreshold: 20,
      preFilterMisses: 10,
      ruleBlocked: [blockedBy('Pay'), blockedBy('Pay'), blockedBy('Pay'), blockedBy('German')],
    });
    const ruleInsight = result.find((i) => i.kind === 'rule-blocked');
    expect(ruleInsight).toBeDefined();
    expect(ruleInsight!.message).toContain('3 ads');
    expect(ruleInsight!.message).toContain('Pay');
  });

  it('does not name a rule that blocked fewer than 3 ads (avoid noise)', () => {
    const result = explainDigest({
      inDigest: 0,
      adsReceived: 10,
      belowThreshold: 5,
      preFilterMisses: 3,
      ruleBlocked: [blockedBy('Pay'), blockedBy('German')],
    });
    expect(result.every((i) => i.kind !== 'rule-blocked')).toBe(true);
  });

  it('flags pre-filter miss when it accounts for ≥50% of the corpus', () => {
    const result = explainDigest({
      inDigest: 1,
      adsReceived: 100,
      belowThreshold: 5,
      preFilterMisses: 80,
      ruleBlocked: [],
    });
    const miss = result.find((i) => i.kind === 'pre-filter-miss');
    expect(miss).toBeDefined();
    expect(miss!.message).toContain('80');
  });

  it('caps the diagnostic at two insights so the header stays scannable', () => {
    const result = explainDigest({
      inDigest: 0,
      adsReceived: 100,
      belowThreshold: 30,
      preFilterMisses: 60,
      ruleBlocked: [blockedBy('Pay'), blockedBy('Pay'), blockedBy('Pay')],
    });
    expect(result.length).toBeLessThanOrEqual(2);
  });

  it('emits the healthy fallback when nothing else applies', () => {
    const result = explainDigest({
      inDigest: 1,
      adsReceived: 3,
      belowThreshold: 0,
      preFilterMisses: 0,
      ruleBlocked: [],
    });
    expect(result).toEqual([
      expect.objectContaining({ kind: 'healthy' }),
    ]);
  });

  it('ignores verdicts whose state is not "block"', () => {
    const warnOnly: BlockedAdSummary = {
      blockers: [{ key: 'Pay', severity: 'preference', state: 'warn', because: [] }],
    };
    const result = explainDigest({
      inDigest: 0,
      adsReceived: 10,
      belowThreshold: 5,
      preFilterMisses: 2,
      ruleBlocked: [warnOnly, warnOnly, warnOnly, warnOnly],
    });
    expect(result.every((i) => i.kind !== 'rule-blocked')).toBe(true);
  });
});
