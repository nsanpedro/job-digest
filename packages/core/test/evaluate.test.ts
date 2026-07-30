/**
 * Table-driven suite over evaluate(): every branch of the I11 evaluation
 * order, dedicated I12 cases (design §14 — "the invariant most likely to be
 * broken by a well-meaning refactor"), and the prototype's fixture ads as
 * end-to-end checks of the whole ruleset.
 */
import { describe, expect, it } from 'vitest';
import {
  blockers,
  evaluate,
  evaluateRule,
  isBlocked,
  worstState,
  type Facts,
  type Rule,
  type RuleState,
  type Ruleset,
  type Step,
  type Verdict,
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

/** Mirrors the prototype's DEFAULT_CFG: Shift and Pay hard, the rest preferences. */
const defaultRuleset = (): Ruleset => ({
  Shift: { key: 'Shift', severity: 'hard', condition: { noRotating: true, noWeekend: true } },
  German: { key: 'German', severity: 'preference', condition: { maxDemanded: 'B2' } },
  Onsite: { key: 'Onsite', severity: 'preference', condition: { minHomeDays: 2 } },
  Pay: { key: 'Pay', severity: 'hard', condition: { minMonthly: 2600, basis: 'fte' } },
  Contract: { key: 'Contract', severity: 'preference', condition: { permanentOnly: true } },
});

interface Case {
  name: string;
  rule: Rule;
  facts: Facts;
  state: RuleState;
  /** When given, the exact ordered `kind` sequence of the because steps. */
  steps?: Array<Step['kind']>;
}

/** "Pay ≥ 2.600 FTE — or 2.300 if fully remote", the doc's running example (§7.3). */
const payWithRemoteRelax = (severity: 'hard' | 'preference'): Rule<'Pay'> => ({
  key: 'Pay',
  severity,
  condition: { minMonthly: 2600, basis: 'fte' },
  exception: { mode: 'relax', when: { kind: 'homeAtLeast', days: 5 }, condition: { minMonthly: 2300, basis: 'fte' } },
});

/** "Permanent only — waived when fully remote." */
const contractWithRemoteWaiver = (severity: 'hard' | 'preference'): Rule<'Contract'> => ({
  key: 'Contract',
  severity,
  condition: { permanentOnly: true },
  exception: { mode: 'waive', when: { kind: 'homeAtLeast', days: 5 } },
});

const cases: Case[] = [
  // ── I11 step 1: waiver ────────────────────────────────────────────────────
  {
    name: 'waive: predicate true → pass, base never evaluated',
    rule: contractWithRemoteWaiver('hard'),
    facts: facts({ home: 5, permanent: false }),
    state: 'pass',
    steps: ['waived'],
  },
  {
    name: 'waive: predicate true + base fact unread → still pass, no spurious unknown (I11 rationale)',
    rule: contractWithRemoteWaiver('hard'),
    facts: facts({ home: 5, permanent: null }),
    state: 'pass',
    steps: ['waived'],
  },
  {
    name: 'waive: predicate false → base applies and blocks',
    rule: contractWithRemoteWaiver('hard'),
    facts: facts({ home: 2, permanent: false }),
    state: 'block',
    steps: ['compared', 'severity'],
  },
  {
    name: 'waive: predicate unknown + base met → pass (exception not needed)',
    rule: contractWithRemoteWaiver('hard'),
    facts: facts({ home: null, permanent: true }),
    state: 'pass',
    steps: ['compared'],
  },
  {
    name: 'waive: predicate unknown + base fails on hard → unknown, not block (I12)',
    rule: contractWithRemoteWaiver('hard'),
    facts: facts({ home: null, permanent: false }),
    state: 'unknown',
    steps: ['compared', 'undecidable'],
  },
  {
    name: 'waive: predicate unknown + base fails on preference → warn, undecidable recorded',
    rule: contractWithRemoteWaiver('preference'),
    facts: facts({ home: null, permanent: false }),
    state: 'warn',
    steps: ['compared', 'undecidable', 'severity'],
  },
  {
    name: 'waive: predicate unknown + base unread → unknown via unread',
    rule: contractWithRemoteWaiver('hard'),
    facts: facts({ home: null, permanent: null }),
    state: 'unknown',
    steps: ['unread'],
  },

  // ── I11 step 2: unread (I4) ───────────────────────────────────────────────
  {
    name: 'unread precedes exception: pay unread even though relax predicate is true (I11)',
    rule: payWithRemoteRelax('hard'),
    facts: facts({ pay: null, home: 5 }),
    state: 'unknown',
    steps: ['unread'],
  },

  // ── I11 step 3: relax exception ───────────────────────────────────────────
  {
    name: 'relax: predicate true + relaxed met → pass with exception step',
    rule: payWithRemoteRelax('hard'),
    facts: facts({ pay: 2400, home: 5 }),
    state: 'pass',
    steps: ['exception', 'compared'],
  },
  {
    name: 'relax: predicate true + relaxed still failed on hard → block',
    rule: payWithRemoteRelax('hard'),
    facts: facts({ pay: 2200, home: 5 }),
    state: 'block',
    steps: ['exception', 'compared', 'severity'],
  },
  {
    name: 'relax: predicate false → base applies and blocks',
    rule: payWithRemoteRelax('hard'),
    facts: facts({ pay: 2400, home: 2 }),
    state: 'block',
    steps: ['compared', 'severity'],
  },
  {
    name: 'relax: predicate unknown + base met → pass (exception not needed)',
    rule: payWithRemoteRelax('hard'),
    facts: facts({ pay: 2700, home: null }),
    state: 'pass',
    steps: ['compared'],
  },
  {
    name: 'relax: predicate unknown + base fails on hard → unknown, not block (I12 core case)',
    rule: payWithRemoteRelax('hard'),
    facts: facts({ pay: 2400, home: null }),
    state: 'unknown',
    steps: ['compared', 'undecidable'],
  },
  {
    name: 'relax: predicate unknown + base fails on preference → warn',
    rule: payWithRemoteRelax('preference'),
    facts: facts({ pay: 2400, home: null }),
    state: 'warn',
    steps: ['compared', 'undecidable', 'severity'],
  },
  {
    name: 'relax: relaxed condition consults a fact the base did not → unread inside exception',
    rule: {
      key: 'Pay',
      severity: 'hard',
      condition: { minMonthly: 2600, basis: 'fte' },
      exception: {
        mode: 'relax',
        when: { kind: 'homeAtLeast', days: 5 },
        condition: { minMonthly: 2300, basis: 'actual' },
      },
    },
    // base (fte) reads payFte=2500 and fails; relaxed (actual) needs pay, which is unread
    facts: facts({ pay: null, payFte: 2500, home: 5 }),
    state: 'unknown',
    steps: ['exception', 'unread'],
  },

  // ── I11 step 4: base conditions per key ───────────────────────────────────
  {
    name: 'Shift: rotating fires → block',
    rule: { key: 'Shift', severity: 'hard', condition: { noRotating: true, noWeekend: true } },
    facts: facts({ rotating: true, weekend: false }),
    state: 'block',
  },
  {
    name: 'Shift: one clause fires while the other is unread → still a decidable block (Kleene OR)',
    rule: { key: 'Shift', severity: 'hard', condition: { noRotating: true, noWeekend: true } },
    facts: facts({ rotating: true, weekend: null }),
    state: 'block',
  },
  {
    name: 'Shift: nothing fired but weekend unread → unknown (fix over the prototype)',
    rule: { key: 'Shift', severity: 'hard', condition: { noRotating: true, noWeekend: true } },
    facts: facts({ rotating: false, weekend: null }),
    state: 'unknown',
    steps: ['unread'],
  },
  {
    name: 'Shift: both clauses off → met even with all facts unread (no constraint to fail)',
    rule: { key: 'Shift', severity: 'hard', condition: { noRotating: false, noWeekend: false } },
    facts: NO_FACTS,
    state: 'pass',
  },
  {
    name: 'German: demanded above ceiling on a preference → warn',
    rule: { key: 'German', severity: 'preference', condition: { maxDemanded: 'B2' } },
    facts: facts({ german: 'C1' }),
    state: 'warn',
  },
  {
    name: 'German: at the ceiling → pass',
    rule: { key: 'German', severity: 'preference', condition: { maxDemanded: 'B2' } },
    facts: facts({ german: 'B2' }),
    state: 'pass',
  },
  {
    name: 'German: unread → unknown',
    rule: { key: 'German', severity: 'hard', condition: { maxDemanded: 'B2' } },
    facts: NO_FACTS,
    state: 'unknown',
    steps: ['unread'],
  },
  {
    name: 'Onsite: zero minimum cannot fail → met without reading the fact',
    rule: { key: 'Onsite', severity: 'preference', condition: { minHomeDays: 0 } },
    facts: NO_FACTS,
    state: 'pass',
  },
  {
    name: 'Onsite: below minimum on a preference → warn',
    rule: { key: 'Onsite', severity: 'preference', condition: { minHomeDays: 2 } },
    facts: facts({ home: 1 }),
    state: 'warn',
  },
  {
    name: 'Pay: fte basis uses the scaled figure → part-time ad passes',
    rule: { key: 'Pay', severity: 'hard', condition: { minMonthly: 2600, basis: 'fte' } },
    facts: facts({ pay: 2250, payFte: 3000 }),
    state: 'pass',
  },
  {
    name: 'Pay: actual basis ignores the scaled figure → same ad blocks',
    rule: { key: 'Pay', severity: 'hard', condition: { minMonthly: 2600, basis: 'actual' } },
    facts: facts({ pay: 2250, payFte: 3000 }),
    state: 'block',
  },
  {
    name: 'Contract: permanentOnly off → met even when the fact is unread',
    rule: { key: 'Contract', severity: 'preference', condition: { permanentOnly: false } },
    facts: NO_FACTS,
    state: 'pass',
  },
];

describe('evaluateRule — every branch of the I11 order', () => {
  for (const c of cases) {
    it(c.name, () => {
      const v = evaluateRule(c.rule, c.facts);
      expect(v.state).toBe(c.state);
      if (c.steps) {
        expect(v.because.map((s) => s.kind)).toEqual(c.steps);
      }
    });
  }
});

describe('evaluate — prototype fixtures under the default ruleset', () => {
  // Facts transcribed from the prototype's ADS array (design handoff fixtures).
  const j1 = facts({ rotating: false, weekend: false, german: 'C1', home: 2, pay: 2900, permanent: true });
  const j3 = facts({ rotating: false, weekend: false, german: 'B2', home: 0, pay: 2250, payFte: 3000, fteNote: 'at 30h', permanent: false });
  const j7 = facts({ rotating: null, weekend: null, german: 'B2', home: 0, pay: 2930, permanent: null });
  const j8 = facts({ rotating: false, weekend: false, german: 'C1', home: 5, pay: 2700, permanent: false });
  const d1 = facts({ rotating: true, weekend: true, german: 'B2', home: 0, pay: 3400, permanent: true });
  const d2 = facts({ rotating: false, weekend: false, german: 'B2', home: 2, pay: 1250, payFte: 2500, fteNote: 'at 20h', permanent: true });
  const d4 = facts({ rotating: true, weekend: true, german: 'B2', home: 0, pay: 1450, payFte: 2200, fteNote: 'at 25h', permanent: true });

  const states = (f: Facts): RuleState[] => evaluate(f, defaultRuleset()).map((v) => v.state);

  it('verdicts always come back in canonical rule order', () => {
    expect(evaluate(j1, defaultRuleset()).map((v) => v.key)).toEqual([
      'Shift', 'German', 'Onsite', 'Pay', 'Contract',
    ]);
  });

  it('j1 Hansa Logistik: C1 ask is the only wrinkle', () => {
    expect(states(j1)).toEqual(['pass', 'warn', 'pass', 'pass', 'pass']);
  });

  it('j3 HR-Assistenz: part-time passes Pay on the FTE basis; befristet and onsite warn', () => {
    expect(states(j3)).toEqual(['pass', 'pass', 'warn', 'pass', 'warn']);
  });

  it('j7 Klinik am Stadtpark: unread working time on a hard rule stays in the list (I4)', () => {
    const vs = evaluate(j7, defaultRuleset());
    expect(vs.map((v) => v.state)).toEqual(['unknown', 'pass', 'warn', 'pass', 'unknown']);
    expect(isBlocked(vs)).toBe(false);
  });

  it('j8 Fjordline: fixed-term and C1 both warn, nothing blocks', () => {
    expect(states(j8)).toEqual(['pass', 'warn', 'pass', 'pass', 'warn']);
  });

  it('d1 Filialleitung: Wechselschicht + Samstag → Shift blocks', () => {
    const vs = evaluate(d1, defaultRuleset());
    expect(vs.map((v) => v.state)).toEqual(['block', 'pass', 'warn', 'pass', 'pass']);
    expect(isBlocked(vs)).toBe(true);
  });

  it('d2 Kontor Nord: Pay is the sole blocker — the guillotine-proof case', () => {
    const vs = evaluate(d2, defaultRuleset());
    expect(vs.map((v) => v.state)).toEqual(['pass', 'pass', 'pass', 'block', 'pass']);
    expect(blockers(vs)).toHaveLength(1);
    expect(blockers(vs)[0]?.key).toBe('Pay');
  });

  it('d4 Bäckerei: shift pattern and scaled pay both block', () => {
    expect(blockers(evaluate(d4, defaultRuleset()))).toHaveLength(2);
  });
});

describe('worstState — block > warn > unknown > pass', () => {
  const v = (state: RuleState): Verdict => ({ key: 'Shift', severity: 'hard', state, because: [] });

  it('warn outranks unknown (a visible card with unknowns still edges warn)', () => {
    expect(worstState([v('unknown'), v('warn'), v('pass')])).toBe('warn');
  });
  it('block outranks everything', () => {
    expect(worstState([v('warn'), v('block'), v('unknown')])).toBe('block');
  });
  it('unknown outranks pass', () => {
    expect(worstState([v('pass'), v('unknown')])).toBe('unknown');
  });
  it('empty input is pass', () => {
    expect(worstState([])).toBe('pass');
  });
});

describe('explanation content', () => {
  it('a relax pass names the predicate and the relaxed condition', () => {
    const v = evaluateRule(payWithRemoteRelax('hard'), facts({ pay: 2400, home: 5 }));
    const step = v.because[0];
    expect(step).toMatchObject({ kind: 'exception', when: 'fully remote' });
    expect(step && 'relaxedTo' in step ? step.relaxedTo : '').toContain('2.300 €');
  });

  it('an I12 unknown names the missing fact', () => {
    const v = evaluateRule(payWithRemoteRelax('hard'), facts({ pay: 2400, home: null }));
    expect(v.because.at(-1)).toMatchObject({ kind: 'undecidable', missing: 'home-office days' });
  });
});
