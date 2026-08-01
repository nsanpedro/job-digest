/**
 * Search modes (design §7.7). The claims worth pinning here are behavioural,
 * not structural: urgent mode must stop ads being filtered *without* changing
 * anyone's numbers, and steady mode must be exactly what was authored.
 */
import { describe, expect, it } from 'vitest';
import {
  applyMode,
  blockers,
  evaluate,
  isBlocked,
  isMode,
  rulesAffectedByMode,
  DEFAULT_RULESET,
  RULE_KEYS,
  type Facts,
  type Ruleset,
} from '../src/index';

const NO_FACTS: Facts = {
  rotating: null,
  weekend: null,
  german: null,
  home: null,
  pay: null,
  payMax: null,
  payFte: null,
  fteNote: null,
  permanent: null,
  commuteMin: null,
};

const facts = (p: Partial<Facts>): Facts => ({ ...NO_FACTS, ...p });

/** Fails the hard Pay floor (2600) and the hard Shift rule; passes nothing else notable. */
const failsHardRules = facts({ pay: 2100, payFte: 2100, rotating: true, weekend: false });

describe('applyMode', () => {
  it('steady returns the authored ruleset untouched', () => {
    expect(applyMode(DEFAULT_RULESET, 'steady')).toBe(DEFAULT_RULESET);
  });

  it('urgent demotes every hard rule to a preference', () => {
    const urgent = applyMode(DEFAULT_RULESET, 'urgent');
    for (const key of RULE_KEYS) {
      expect(urgent[key].severity).toBe('preference');
    }
  });

  it('urgent leaves thresholds and exceptions byte-identical', () => {
    const saved: Ruleset = {
      ...DEFAULT_RULESET,
      Pay: {
        key: 'Pay',
        severity: 'hard',
        condition: { minMonthly: 2600, basis: 'fte' },
        exception: { mode: 'relax', when: { kind: 'homeAtLeast', days: 5 }, condition: { minMonthly: 2300, basis: 'fte' } },
      },
    };
    const urgent = applyMode(saved, 'urgent');
    for (const key of RULE_KEYS) {
      expect(urgent[key].condition).toEqual(saved[key].condition);
      expect(urgent[key].exception).toEqual(saved[key].exception);
    }
  });

  it('does not mutate the ruleset it was given', () => {
    const saved = structuredClone(DEFAULT_RULESET);
    applyMode(saved, 'urgent');
    expect(saved).toEqual(DEFAULT_RULESET);
  });
});

describe('what a mode changes downstream', () => {
  it('steady blocks an ad that fails a hard rule', () => {
    const verdicts = evaluate(failsHardRules, applyMode(DEFAULT_RULESET, 'steady'));
    expect(isBlocked(verdicts)).toBe(true);
  });

  it('urgent blocks nothing — the same ad is listed, flagged', () => {
    const verdicts = evaluate(failsHardRules, applyMode(DEFAULT_RULESET, 'urgent'));
    expect(isBlocked(verdicts)).toBe(false);
    expect(blockers(verdicts)).toHaveLength(0);
    // Flagged, not silently passed: the failures are still visible as warnings.
    expect(verdicts.filter((v) => v.state === 'warn').map((v) => v.key)).toEqual(
      expect.arrayContaining(['Shift', 'Pay']),
    );
  });

  it('urgent does not turn a failure into a pass', () => {
    const steady = evaluate(failsHardRules, DEFAULT_RULESET);
    const urgent = evaluate(failsHardRules, applyMode(DEFAULT_RULESET, 'urgent'));
    const passing = (vs: typeof steady) => vs.filter((v) => v.state === 'pass').map((v) => v.key);
    // Exactly the same rules are satisfied either way — only the consequence
    // of failing one differs. This is the claim the mode copy makes.
    expect(passing(urgent)).toEqual(passing(steady));
  });

  it('urgent keeps the explanation tree intact', () => {
    const [shift] = evaluate(failsHardRules, applyMode(DEFAULT_RULESET, 'urgent'));
    expect(shift!.because.some((s) => s.kind === 'compared')).toBe(true);
    expect(shift!.because).toContainEqual({ kind: 'severity', severity: 'preference' });
  });
});

describe('rulesAffectedByMode', () => {
  it('names the hard rules urgent mode would demote', () => {
    expect(rulesAffectedByMode(DEFAULT_RULESET, 'urgent')).toEqual(['Shift', 'Pay']);
  });

  it('is empty in steady mode, and empty when nothing is hard', () => {
    expect(rulesAffectedByMode(DEFAULT_RULESET, 'steady')).toEqual([]);
    const allSoft = applyMode(DEFAULT_RULESET, 'urgent');
    expect(rulesAffectedByMode(allSoft, 'urgent')).toEqual([]);
  });
});

describe('isMode', () => {
  it('accepts the two modes and rejects anything else', () => {
    expect(isMode('steady')).toBe(true);
    expect(isMode('urgent')).toBe(true);
    expect(isMode('panic')).toBe(false);
    expect(isMode(undefined)).toBe(false);
  });
});
