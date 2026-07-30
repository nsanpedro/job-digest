/**
 * Rule evaluation — a pure function of (facts, ruleset), computed at read time
 * (I6). Verdicts are never stored: rule accountability is a replay of this
 * function over stored facts under a versioned ruleset (design §7.4).
 *
 * Evaluation order per rule is fixed (I11): waived → unread → exception → base.
 */
import { describeCondition, describePredicate, eur, predicateFactName } from './describe';
import {
  LEVELS,
  RULE_KEYS,
  type ConditionByKey,
  type Facts,
  type Predicate,
  type Rule,
  type RuleKey,
  type RuleState,
  type Ruleset,
  type Step,
  type Verdict,
} from './types';

/** Three-valued logic: a predicate over a fact that was not read is `'unknown'`. */
type Tri = boolean | 'unknown';

export function evalPredicate(p: Predicate, f: Facts): Tri {
  switch (p.kind) {
    case 'homeAtLeast':
      return f.home === null ? 'unknown' : f.home >= p.days;
    case 'payAtLeast': {
      // FTE-equivalent when available: "pays at least X" on a part-time ad
      // means the scaled figure, matching the Pay rule's default basis.
      const v = f.payFte ?? f.pay;
      return v === null ? 'unknown' : v >= p.amount;
    }
    case 'commuteUnder':
      return f.commuteMin === null ? 'unknown' : f.commuteMin < p.minutes;
  }
}

type CondResult =
  | { kind: 'met'; fact: string }
  | { kind: 'failed'; fact: string }
  | { kind: 'unread'; field: string };

function evalShift(c: ConditionByKey['Shift'], f: Facts): CondResult {
  const clauses = [
    { active: c.noRotating, value: f.rotating, name: 'rotating shifts', cleared: 'no rotation' },
    { active: c.noWeekend, value: f.weekend, name: 'weekend work', cleared: 'no weekend work' },
  ].filter((cl) => cl.active);
  if (clauses.length === 0) return { kind: 'met', fact: 'no working-time limit set' };
  // Kleene OR over the active clauses: one clause known to fire decides
  // `failed` even while the other is unread; `unread` only when nothing fired
  // and something is null. (The prototype checked `rotating` alone, letting
  // rotating=false + weekend=null slip through as a pass — fixed here.)
  const fired = clauses.filter((cl) => cl.value === true);
  if (fired.length > 0) return { kind: 'failed', fact: fired.map((cl) => cl.name).join(' and ') };
  if (clauses.some((cl) => cl.value === null)) return { kind: 'unread', field: 'working time' };
  return { kind: 'met', fact: clauses.map((cl) => cl.cleared).join(', ') };
}

function evalGerman(c: ConditionByKey['German'], f: Facts): CondResult {
  if (f.german === null) return { kind: 'unread', field: 'German level' };
  const fact = `${f.german} demanded`;
  return LEVELS[f.german] > LEVELS[c.maxDemanded] ? { kind: 'failed', fact } : { kind: 'met', fact };
}

function evalOnsite(c: ConditionByKey['Onsite'], f: Facts): CondResult {
  // A zero minimum cannot fail, so it is met even when the fact is unread —
  // three-valued logic, not a shortcut: no value of `home` could fail it.
  if (c.minHomeDays <= 0) return { kind: 'met', fact: 'no home-office minimum set' };
  if (f.home === null) return { kind: 'unread', field: 'home-office days' };
  const fact = `${f.home} home-office day${f.home === 1 ? '' : 's'} a week`;
  return f.home < c.minHomeDays ? { kind: 'failed', fact } : { kind: 'met', fact };
}

function evalPay(c: ConditionByKey['Pay'], f: Facts): CondResult {
  const usesFte = c.basis === 'fte';
  const v = usesFte ? (f.payFte ?? f.pay) : f.pay;
  if (v === null) return { kind: 'unread', field: 'pay' };
  const fact = eur(v) + (usesFte && f.payFte !== null ? ' full-time equivalent' : '');
  return v < c.minMonthly ? { kind: 'failed', fact } : { kind: 'met', fact };
}

function evalContract(c: ConditionByKey['Contract'], f: Facts): CondResult {
  if (!c.permanentOnly) return { kind: 'met', fact: 'any contract accepted' };
  if (f.permanent === null) return { kind: 'unread', field: 'contract type' };
  return f.permanent
    ? { kind: 'met', fact: 'unbefristet (permanent)' }
    : { kind: 'failed', fact: 'befristet (fixed-term)' };
}

function evalCondition(key: RuleKey, condition: ConditionByKey[RuleKey], f: Facts): CondResult {
  switch (key) {
    case 'Shift':
      return evalShift(condition as ConditionByKey['Shift'], f);
    case 'German':
      return evalGerman(condition as ConditionByKey['German'], f);
    case 'Onsite':
      return evalOnsite(condition as ConditionByKey['Onsite'], f);
    case 'Pay':
      return evalPay(condition as ConditionByKey['Pay'], f);
    case 'Contract':
      return evalContract(condition as ConditionByKey['Contract'], f);
  }
}

export function evaluateRule<K extends RuleKey>(rule: Rule<K>, facts: Facts): Verdict {
  const { key, severity } = rule;
  const verdict = (state: RuleState, because: Step[]): Verdict => ({ key, severity, state, because });

  // Set when an exception predicate could not be evaluated; consumed at the
  // failure branch below (I12).
  let undecidable: { when: string; missing: string } | null = null;

  const exc = rule.exception;

  // I11 step 1 — waiver. When the rule does not apply, the base condition is
  // never evaluated, so an unread field on a waived rule cannot produce a
  // spurious unknown.
  if (exc?.mode === 'waive') {
    const applies = evalPredicate(exc.when, facts);
    if (applies === true) {
      return verdict('pass', [{ kind: 'waived', when: describePredicate(exc.when) }]);
    }
    if (applies === 'unknown') {
      undecidable = { when: describePredicate(exc.when), missing: predicateFactName(exc.when) };
    }
  }

  // I11 step 2 — unread. Not read is unknown, never a default and never a
  // block (I4). Checked before exceptions: without the fact, not even a
  // relaxed condition could be evaluated.
  const base = evalCondition(key, rule.condition, facts);
  if (base.kind === 'unread') {
    return verdict('unknown', [{ kind: 'unread', field: base.field }]);
  }

  // I11 step 3 — relax exception.
  if (exc?.mode === 'relax') {
    const applies = evalPredicate(exc.when, facts);
    if (applies === true) {
      const steps: Step[] = [
        {
          kind: 'exception',
          when: describePredicate(exc.when),
          relaxedTo: describeCondition(key, exc.condition),
        },
      ];
      const relaxed = evalCondition(key, exc.condition, facts);
      if (relaxed.kind === 'unread') {
        // Reachable when the relaxed condition consults a fact the base one
        // did not — e.g. Pay basis 'fte' relaxed to basis 'actual'.
        return verdict('unknown', [...steps, { kind: 'unread', field: relaxed.field }]);
      }
      steps.push({
        kind: 'compared',
        fact: relaxed.fact,
        against: describeCondition(key, exc.condition),
        met: relaxed.kind === 'met',
      });
      if (relaxed.kind === 'met') return verdict('pass', steps);
      steps.push({ kind: 'severity', severity });
      return verdict(severity === 'hard' ? 'block' : 'warn', steps);
    }
    if (applies === 'unknown') {
      undecidable = { when: describePredicate(exc.when), missing: predicateFactName(exc.when) };
    }
  }

  // I11 step 4 — base condition.
  const steps: Step[] = [
    { kind: 'compared', fact: base.fact, against: describeCondition(key, rule.condition), met: base.kind === 'met' },
  ];
  if (base.kind === 'met') return verdict('pass', steps);

  if (undecidable !== null) {
    // I12 — the escape hatch could not be checked, so the system does not get
    // to claim a disqualification it cannot prove: a hard block degrades to
    // unknown. A preference stays warn (same outcome either way), but the
    // undecidable step is still recorded so the prose can say so.
    steps.push({ kind: 'undecidable', when: undecidable.when, missing: undecidable.missing });
    if (severity === 'hard') return verdict('unknown', steps);
    steps.push({ kind: 'severity', severity });
    return verdict('warn', steps);
  }

  steps.push({ kind: 'severity', severity });
  return verdict(severity === 'hard' ? 'block' : 'warn', steps);
}

/** Evaluate all five rules, always in RULE_KEYS order. Pure (I6). */
export function evaluate(facts: Facts, ruleset: Ruleset): Verdict[] {
  return RULE_KEYS.map((key) => evaluateRule(ruleset[key], facts));
}

const STATE_ORDER: Record<RuleState, number> = { pass: 0, unknown: 1, warn: 2, block: 3 };

/** Worst state across verdicts: block > warn > unknown > pass. Drives the card's left edge. */
export function worstState(verdicts: readonly Verdict[]): RuleState {
  return verdicts.reduce<RuleState>(
    (worst, v) => (STATE_ORDER[v.state] > STATE_ORDER[worst] ? v.state : worst),
    'pass',
  );
}

export function blockers(verdicts: readonly Verdict[]): Verdict[] {
  return verdicts.filter((v) => v.state === 'block');
}

/** I4 corollary: only a proven hard failure blocks an ad; `unknown` never does. */
export function isBlocked(verdicts: readonly Verdict[]): boolean {
  return verdicts.some((v) => v.state === 'block');
}
