/**
 * Scoring suite — one describe block per component, then composed scoreAd
 * and selectMatches. Same table-driven style as evaluate.test.ts. Every
 * component has a dedicated boundary case; composition tests pin the
 * placement invariant ADR-003 §9 introduces (I29).
 */
import { describe, expect, it } from 'vitest';
import {
  CALIBRATION_V2,
  CALIBRATION_V3,
  CALIBRATION_V4,
  DEFAULT_CALIBRATION,
  directionFit,
  effectiveWeights,
  freshness,
  ruleMargin,
  scoreAd,
  selectMatches,
  seniorityFit,
  signalCompleteness,
  sourceQuality,
  stackFit,
  type Calibration,
  type ScoreBreakdown,
  type ScoredAd,
  type ScoringDirection,
} from '../src/scoring';
import type { Facts, Ruleset, Verdict } from '../src/index';
import { evaluate } from '../src/evaluate';

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

const sumOf = (w: Calibration['weights']): number => Object.values(w).reduce((a, b) => a + b, 0);

/** Mirrors DEFAULT_RULESET: Shift and Pay hard, the rest preferences. */
const defaultRuleset = (): Ruleset => ({
  Shift: { key: 'Shift', severity: 'hard', condition: { noRotating: true, noWeekend: true } },
  German: { key: 'German', severity: 'preference', condition: { maxDemanded: 'B2' } },
  Onsite: { key: 'Onsite', severity: 'preference', condition: { minHomeDays: 2 } },
  Pay: { key: 'Pay', severity: 'hard', condition: { minMonthly: 2600, basis: 'fte' } },
  Contract: { key: 'Contract', severity: 'preference', condition: { permanentOnly: true } },
});

const direction = (p: Partial<ScoringDirection> & Pick<ScoringDirection, 'searchTerms'>): ScoringDirection => ({
  distance: 'adjacent',
  ...p,
});

// ── ruleMargin ───────────────────────────────────────────────────────────────

describe('ruleMargin', () => {
  it('averages perfect margins to 1.0 when every fact clears every rule', () => {
    const rs = defaultRuleset();
    const f = facts({
      rotating: false,
      weekend: false,
      german: 'B2',
      home: 5,
      payFte: 6000,
      permanent: true,
    });
    expect(ruleMargin(f, rs)).toBeCloseTo(1);
  });

  it('averages neutral 0.5 when every fact is unread', () => {
    expect(ruleMargin(NO_FACTS, defaultRuleset())).toBeCloseTo(0.5);
  });

  it('Shift with both clauses inactive returns 1 even with rotating=true', () => {
    const rs = defaultRuleset();
    rs.Shift.condition = { noRotating: false, noWeekend: false };
    // Only Shift matters here; other rules unread → 0.5 for each of the four.
    const f = facts({ rotating: true, weekend: true });
    // Shift=1, German=0.5, Onsite=0.5, Pay=0.5, Contract=0.5 → 3/5 = 0.6
    expect(ruleMargin(f, rs)).toBeCloseTo(0.6);
  });

  it('Shift with one clause active and only the other fact known stays neutral 0.5', () => {
    const rs = defaultRuleset();
    rs.Shift.condition = { noRotating: true, noWeekend: false };
    // rotating unread, weekend true — but weekend clause is off, so weekend
    // doesn't decide. rotating unread → 0.5 for Shift.
    const f = facts({ rotating: null, weekend: true });
    // Shift=0.5, others unread=0.5 → 0.5
    expect(ruleMargin(f, rs)).toBeCloseTo(0.5);
  });

  it('German above the ceiling is 0; at ceiling is 1', () => {
    const rs = defaultRuleset();
    // maxDemanded B2 → C1 above = 0
    const above = facts({ german: 'C1', rotating: false, weekend: false, home: 2, payFte: 3000, permanent: true });
    // Shift 1 + German 0 + Onsite 0.5 (at min) + Pay 0.15... + Contract 1
    const mAbove = ruleMargin(above, rs);
    expect(mAbove).toBeLessThan(0.75);

    const at = facts({ german: 'B2', rotating: false, weekend: false, home: 5, payFte: 6000, permanent: true });
    expect(ruleMargin(at, rs)).toBeCloseTo(1);
  });

  it('Onsite scales between 0.5 at floor and 1.0 at fully remote', () => {
    const rs = defaultRuleset();
    // Isolate Onsite: perfect for all others, sweep home.
    const build = (home: number | null) =>
      facts({ rotating: false, weekend: false, german: 'B2', payFte: 6000, permanent: true, home });
    const others = 4; // Shift + German + Pay + Contract, each 1
    const onsite = (h: number | null) => (ruleMargin(build(h), rs) * 5) - others;

    expect(onsite(2)).toBeCloseTo(0.5); // at floor
    expect(onsite(5)).toBeCloseTo(1.0); // fully remote
    expect(onsite(3)).toBeCloseTo(0.5 + 0.5 * (1 / 3));
    expect(onsite(1)).toBeCloseTo(0); // below floor
    expect(onsite(null)).toBeCloseTo(0.5); // unread
  });

  it('Pay scales linearly from 0 at floor to 1 at 2× floor and caps there', () => {
    const rs = defaultRuleset();
    const build = (p: number | null) =>
      facts({ rotating: false, weekend: false, german: 'B2', home: 5, permanent: true, payFte: p });
    const others = 4;
    const pay = (p: number | null) => (ruleMargin(build(p), rs) * 5) - others;

    expect(pay(2600)).toBeCloseTo(0);
    expect(pay(3900)).toBeCloseTo(0.5);
    expect(pay(5200)).toBeCloseTo(1);
    expect(pay(10000)).toBeCloseTo(1); // capped
    expect(pay(2000)).toBeCloseTo(0); // hard-block would filter this out earlier; margin is 0 anyway
    expect(pay(null)).toBeCloseTo(0.5);
  });

  it('Pay falls back to `pay` when basis is `actual`', () => {
    const rs = defaultRuleset();
    rs.Pay.condition = { minMonthly: 2600, basis: 'actual' };
    const f = facts({
      rotating: false, weekend: false, german: 'B2', home: 5, permanent: true,
      pay: 5200, payFte: null,
    });
    expect(ruleMargin(f, rs)).toBeCloseTo(1);
  });

  it('Contract preferenceOnly=false is a no-op (always 1)', () => {
    const rs = defaultRuleset();
    rs.Contract.condition = { permanentOnly: false };
    const f = facts({ rotating: false, weekend: false, german: 'B2', home: 5, payFte: 6000, permanent: false });
    // Every rule 1 → 1.0 average.
    expect(ruleMargin(f, rs)).toBeCloseTo(1);
  });
});

// ── directionFit ─────────────────────────────────────────────────────────────

describe('directionFit', () => {
  it('returns 0 when the user has no directions — nothing to measure', () => {
    // scoreAd compensates by redistributing the directionFit weight across
    // the other four components via `effectiveWeights`, so the ad is not
    // silently penalised — but returning 1.0 here (the old contract) added
    // phantom points that let a stale LinkedIn alert reach topPick on
    // freshness alone. Fixed at the source.
    expect(directionFit('Senior Software Engineer', [])).toBe(0);
  });

  it('full-phrase match on an adjacent direction scores 1.0', () => {
    const dirs = [direction({ searchTerms: ['engineering manager'], distance: 'adjacent' })];
    expect(directionFit('Senior Engineering Manager', dirs)).toBe(1);
  });

  it('full-phrase match on a stretch direction scores 0.5', () => {
    const dirs = [direction({ searchTerms: ['data engineer'], distance: 'stretch' })];
    expect(directionFit('Senior Data Engineer', dirs)).toBeCloseTo(0.5);
  });

  it('long-word match without full phrase scores 0.6 × distance factor', () => {
    // "manager" is 7 chars — below the 8-char threshold. Use a
    // domain-specific long word ("kubernetes", 10) — role suffixes like
    // "engineer" are blocked from the long-word tier (see
    // NON_DISCRIMINATIVE_ROLE_WORDS): a "Sales Engineer" must not count as
    // evidence for a "software engineer" direction. Domain words still do.
    const dirs = [direction({ searchTerms: ['kubernetes engineer'], distance: 'adjacent' })];
    // 'engineer' is blocked; 'kubernetes' (10 chars) is a real domain
    // long-word match — 0.6 × 1.0 = 0.6.
    expect(directionFit('Senior Kubernetes Platform Lead', dirs)).toBeCloseTo(0.6);
  });

  it('picks the best across multiple directions after applying distance factor', () => {
    const dirs = [
      // adjacent direction: phrase fails, and 'engineer' (role suffix) is
      // blocked from long-word — but 'kubernetes' (10, domain) is fine →
      // long-word = 0.6 × 1.0 = 0.6.
      direction({ searchTerms: ['kubernetes engineer'], distance: 'adjacent' }),
      // stretch direction: full-phrase match → 1.0 * 0.5 = 0.5
      direction({ searchTerms: ['product manager'], distance: 'stretch' }),
    ];
    expect(directionFit('Senior Product Manager', dirs)).toBeCloseTo(0.5);
    expect(directionFit('Senior Kubernetes Platform Lead', dirs)).toBeCloseTo(0.6);
  });

  it('title with no signal returns 0', () => {
    const dirs = [direction({ searchTerms: ['engineering manager'], distance: 'adjacent' })];
    expect(directionFit('Marketing Analyst', dirs)).toBe(0);
  });

  it('role synonyms — direction "engineer" matches title "developer" or "entwickler" on full phrase', () => {
    const dirs = [direction({ searchTerms: ['frontend engineer'], distance: 'adjacent' })];
    // Full-phrase match via synonym: "frontend" (substring in title) AND
    // "engineer" (via synonym → "developer" in title).
    expect(directionFit('Senior Frontend Developer', dirs)).toBe(1);
    // Same via German synonym.
    expect(directionFit('Senior Frontend Entwickler', dirs)).toBe(1);
    // Long-word backup is NOT available for role suffixes: "engineer" (via
    // synonym "developer", both ≥8) is a role suffix, so a title with
    // "developer" alone gets nothing. Otherwise every "Salesforce Developer"
    // or "Sales Developer Rep" would score on a Frontend-Eng direction.
    expect(directionFit('Full Stack Developer', dirs)).toBe(0);
  });

  it('role-suffix long words alone do not trigger long-word match (Sales Director regression)', () => {
    // Same regression as directionFitStrength — but on the scoring side.
    // A designer whose CV yields "Creative Director" search terms must not
    // give "Sales Director" a positive score.
    const dirs = [direction({
      searchTerms: ['creative director', 'design director'],
      distance: 'adjacent',
    })];
    expect(directionFit('Sales Director', dirs)).toBe(0);
    expect(directionFit('Marketing Director', dirs)).toBe(0);
    // Full-phrase still lands.
    expect(directionFit('Senior Creative Director', dirs)).toBe(1);
  });

  it('short generic words alone (≤7 chars) do not trigger long-word match', () => {
    // "senior" is 6 chars, "manager" is 7 — both below the 8-char threshold.
    const dirs = [direction({ searchTerms: ['senior manager'], distance: 'adjacent' })];
    // Neither the phrase (needs both) nor a long-word alone matches — the
    // phrase does match here, actually: 'senior' + 'manager' both substrings.
    expect(directionFit('Senior Product Manager', dirs)).toBe(1);
    // But a title missing one of them and lacking a long-word gets nothing:
    expect(directionFit('Senior Analyst', dirs)).toBe(0);
  });
});

// ── effectiveWeights ────────────────────────────────────────────────────────

describe('effectiveWeights', () => {
  const base = DEFAULT_CALIBRATION.weights;

  it('returns the base weights unchanged when there ARE directions', () => {
    expect(effectiveWeights(base, [])).toEqual(base);
  });

  it('zeroes directionFit and redistributes its share when there are NO directions', () => {
    const w = effectiveWeights(base, ['directionFit']);
    expect(w.directionFit).toBe(0);
    // Each other component is scaled by 1 / (1 - directionFit).
    const scale = 1 / (1 - base.directionFit);
    expect(w.ruleMargin).toBeCloseTo(base.ruleMargin * scale);
    expect(w.signalCompleteness).toBeCloseTo(base.signalCompleteness * scale);
    expect(w.freshness).toBeCloseTo(base.freshness * scale);
    expect(w.sourceQuality).toBeCloseTo(base.sourceQuality * scale);
  });

  it('the redistributed weights still sum to 1.0 (score stays in [0, 100])', () => {
    expect(sumOf(effectiveWeights(base, ['directionFit']))).toBeCloseTo(1.0);
    expect(sumOf(effectiveWeights(base, ['seniorityFit', 'stackFit']))).toBeCloseTo(1.0);
    expect(sumOf(effectiveWeights(base, ['directionFit', 'seniorityFit', 'stackFit']))).toBeCloseTo(1.0);
  });

  it('dropping both v3 components from v3 gives back the v2 weights exactly', () => {
    const w = effectiveWeights(CALIBRATION_V3.weights, ['seniorityFit', 'stackFit']);
    for (const [k, v] of Object.entries(CALIBRATION_V2.weights)) {
      expect(w[k as keyof typeof w]).toBeCloseTo(v, 10);
    }
  });

  it('dropping locationFit from v4 gives back the v3 weights exactly', () => {
    const w = effectiveWeights(DEFAULT_CALIBRATION.weights, ['locationFit']);
    for (const [k, v] of Object.entries(CALIBRATION_V3.weights)) {
      expect(w[k as keyof typeof w]).toBeCloseTo(v, 10);
    }
  });

  it('dropping a zero-weight component is a no-op, not a renormalisation', () => {
    const v2 = CALIBRATION_V2.weights;
    expect(effectiveWeights(v2, ['seniorityFit', 'stackFit'])).toBe(v2);
  });

  it('a component with base weight 0 receives no boost', () => {
    // Custom calibration with sourceQuality=0.
    const custom = {
      ...base,
      ruleMargin: 0.35, directionFit: 0.35, signalCompleteness: 0.15, freshness: 0.15, sourceQuality: 0,
      seniorityFit: 0, stackFit: 0,
    };
    const w = effectiveWeights(custom, ['directionFit']);
    expect(w.sourceQuality).toBe(0);
    // The 0.35 directionFit share went to rm/sc/fr proportionally.
    expect(sumOf(w)).toBeCloseTo(1.0);
  });

  it('a calibration with directionFit=0 base is returned unchanged (no divide-by-zero)', () => {
    const degenerate = { ...base, directionFit: 0, ruleMargin: 0.6 };
    expect(effectiveWeights(degenerate, ['directionFit'])).toEqual(degenerate);
  });
});

// ── signalCompleteness ──────────────────────────────────────────────────────

describe('signalCompleteness', () => {
  it('returns 1.0 when every consulted fact is present', () => {
    const rs = defaultRuleset();
    const f = facts({
      rotating: false, weekend: false, german: 'B2', home: 2, payFte: 3000, permanent: true,
    });
    expect(signalCompleteness(f, rs)).toBe(1);
  });

  it('returns 0 when nothing is read', () => {
    expect(signalCompleteness(NO_FACTS, defaultRuleset())).toBe(0);
  });

  it('does not consult fields the ruleset ignores', () => {
    const rs = defaultRuleset();
    rs.Shift.condition = { noRotating: false, noWeekend: false };
    rs.Onsite.condition = { minHomeDays: 0 };
    rs.Contract.condition = { permanentOnly: false };
    // Consulted: German + Pay only.
    const f = facts({ german: 'B2', payFte: 3000 });
    expect(signalCompleteness(f, rs)).toBe(1);
  });

  it('accepts pay OR payFte as the pay signal under basis=fte', () => {
    const rs = defaultRuleset();
    const withFte = facts({ german: 'B2', home: 2, permanent: true, rotating: false, weekend: false, payFte: 3000 });
    const withActual = facts({ german: 'B2', home: 2, permanent: true, rotating: false, weekend: false, pay: 3000, payFte: null });
    expect(signalCompleteness(withFte, rs)).toBe(1);
    expect(signalCompleteness(withActual, rs)).toBe(1);
  });

  it('under basis=actual, payFte does not substitute for pay', () => {
    const rs = defaultRuleset();
    rs.Pay.condition = { minMonthly: 2600, basis: 'actual' };
    // pay unread, payFte present — under 'actual', that is unread pay.
    const f = facts({ german: 'B2', home: 2, permanent: true, rotating: false, weekend: false, payFte: 3000 });
    // 5 consulted (rotating, weekend, german, home, pay, permanent = 6 actually),
    // 5 present, pay missing → 5/6.
    expect(signalCompleteness(f, rs)).toBeCloseTo(5 / 6);
  });
});

// ── freshness ───────────────────────────────────────────────────────────────

describe('freshness', () => {
  const now = new Date('2026-08-24T12:00:00Z');
  const days = (n: number) => new Date(now.getTime() - n * 24 * 60 * 60 * 1000);

  it('day 0 is 1.0', () => {
    expect(freshness(now, now, 7, 0.4)).toBe(1);
  });

  it('day 7 lands on the floor', () => {
    expect(freshness(days(7), now, 7, 0.4)).toBeCloseTo(0.4);
  });

  it('halfway through the window is halfway between 1 and floor', () => {
    expect(freshness(days(3.5), now, 7, 0.4)).toBeCloseTo(0.7);
  });

  it('past the decay window continues to 0 and clamps there', () => {
    expect(freshness(days(14), now, 7, 0.4)).toBe(0);
    expect(freshness(days(30), now, 7, 0.4)).toBe(0);
  });

  it('negative age (receivedAt in the future) clamps to day 0', () => {
    expect(freshness(days(-1), now, 7, 0.4)).toBe(1);
  });

  it('decayDays <= 0 returns the floor without dividing by zero', () => {
    expect(freshness(now, now, 0, 0.4)).toBe(0.4);
  });
});

// ── sourceQuality ───────────────────────────────────────────────────────────

describe('sourceQuality', () => {
  it('API-sourced platforms score 1.0 by default', () => {
    expect(sourceQuality('Greenhouse', DEFAULT_CALIBRATION)).toBe(1);
    expect(sourceQuality('Lever', DEFAULT_CALIBRATION)).toBe(1);
    expect(sourceQuality('Ashby', DEFAULT_CALIBRATION)).toBe(1);
    expect(sourceQuality('Personio', DEFAULT_CALIBRATION)).toBe(1);
  });

  it('email-alert platforms score 0.6 by default', () => {
    expect(sourceQuality('LinkedIn', DEFAULT_CALIBRATION)).toBe(0.6);
    expect(sourceQuality('Xing', DEFAULT_CALIBRATION)).toBe(0.6);
    expect(sourceQuality('StepStone', DEFAULT_CALIBRATION)).toBe(0.6);
  });

  it('unknown sources fall back to defaultSourcePrior (no throw)', () => {
    expect(sourceQuality('FutureBoard', DEFAULT_CALIBRATION)).toBe(DEFAULT_CALIBRATION.defaultSourcePrior);
  });
});

// ── DEFAULT_CALIBRATION invariants ──────────────────────────────────────────

describe('DEFAULT_CALIBRATION', () => {
  it('every calibration\'s weights sum to 1.0', () => {
    expect(sumOf(DEFAULT_CALIBRATION.weights)).toBeCloseTo(1, 10);
    expect(sumOf(CALIBRATION_V2.weights)).toBeCloseTo(1, 10);
    expect(sumOf(CALIBRATION_V3.weights)).toBeCloseTo(1, 10);
  });

  it('every weight is in [0, 1]', () => {
    for (const value of Object.values(DEFAULT_CALIBRATION.weights)) {
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThanOrEqual(1);
    }
  });

  it('the match threshold is in [0, 100]', () => {
    expect(DEFAULT_CALIBRATION.matchThreshold).toBeGreaterThanOrEqual(0);
    expect(DEFAULT_CALIBRATION.matchThreshold).toBeLessThanOrEqual(100);
  });
});

// ── scoreAd (composition) ────────────────────────────────────────────────────

describe('scoreAd', () => {
  const now = new Date('2026-08-24T12:00:00Z');

  it('produces a total in [0, 100]', () => {
    const rs = defaultRuleset();
    const result = scoreAd({
      facts: NO_FACTS,
      verdicts: [],
      ruleset: rs,
      directions: [],
      title: 'anything',
      source: 'LinkedIn',
      receivedAt: now,
      now,
      calibration: DEFAULT_CALIBRATION,
    });
    expect(result.total).toBeGreaterThanOrEqual(0);
    expect(result.total).toBeLessThanOrEqual(100);
  });

  it('a perfect ad on every axis scores 100', () => {
    const rs = defaultRuleset();
    const result = scoreAd({
      facts: facts({
        rotating: false, weekend: false, german: 'B2', home: 5, payFte: 6000, permanent: true,
      }),
      verdicts: [],
      ruleset: rs,
      directions: [direction({ searchTerms: ['engineering manager'], distance: 'adjacent' })],
      title: 'Engineering Manager',
      source: 'Greenhouse',
      receivedAt: now,
      now,
      calibration: DEFAULT_CALIBRATION,
    });
    expect(result.total).toBe(100);
    expect(result.ruleMargin).toBe(1);
    expect(result.directionFit).toBe(1);
    expect(result.signalCompleteness).toBe(1);
    expect(result.freshness).toBe(1);
    expect(result.sourceQuality).toBe(1);
  });

  it('an empty-facts LinkedIn ad with no directions and 7-day age does NOT reach topPick', () => {
    const rs = defaultRuleset();
    const receivedAt = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    const result = scoreAd({
      facts: NO_FACTS,
      verdicts: [],
      ruleset: rs,
      directions: [],
      title: 'Anything',
      source: 'LinkedIn',
      receivedAt,
      now,
      calibration: DEFAULT_CALIBRATION,
    });
    // No directions → directionFit weight (0.35) redistributed across the
    // other four. Effective weights: rm 0.385, sc 0.154, fr 0.308, sq 0.154.
    // Values: rm 0.5, sc 0, fr 0.4, sq 0.6.
    // total = 0.385*0.5 + 0.154*0 + 0.308*0.4 + 0.154*0.6 ≈ 0.408 → 41.
    //
    // Was 62 under the old contract (directionFit=1.0 as a free 35 pts) —
    // a phantom near-topPick for a stale, empty ad from a user who never
    // gave a signal. 41 is the honest number: well below both topPick (70)
    // and worthAReading (50), so this ad correctly lands in explore.
    expect(result.total).toBe(41);
    expect(result.directionFit).toBe(0);
  });

  it('is deterministic (same input → same output)', () => {
    const rs = defaultRuleset();
    const input = {
      facts: facts({ payFte: 4000, home: 3, german: 'B2' as const }),
      verdicts: [],
      ruleset: rs,
      directions: [direction({ searchTerms: ['engineer'], distance: 'adjacent' })],
      title: 'Software Engineer',
      source: 'Greenhouse',
      receivedAt: new Date(now.getTime() - 3 * 24 * 60 * 60 * 1000),
      now,
      calibration: DEFAULT_CALIBRATION,
    };
    expect(scoreAd(input)).toEqual(scoreAd(input));
  });
});

// ── seniorityFit / stackFit ─────────────────────────────────────────────────

describe('seniorityFit', () => {
  it('null when the ad states no rung, or the user targets none — no signal, not a guess', () => {
    expect(seniorityFit(null, ['senior'])).toBeNull();
    expect(seniorityFit('senior', [])).toBeNull();
  });

  it('same rung is 1.0', () => {
    expect(seniorityFit('senior', ['senior'])).toBe(1);
  });

  it('one step up (a normal next move) outranks one step down (a step back)', () => {
    expect(seniorityFit('lead', ['senior'])).toBeCloseTo(0.6);
    expect(seniorityFit('senior', ['lead'])).toBeCloseTo(0.4);
  });

  it('two or more steps apart is 0 — "Junior" for a senior, "Head of" for a senior IC', () => {
    expect(seniorityFit('junior', ['senior'])).toBe(0);
    expect(seniorityFit('head', ['senior'])).toBe(0);
  });

  it('principal and head share a rank but are different jobs — one step, not a match', () => {
    expect(seniorityFit('head', ['principal'])).toBeCloseTo(0.6);
  });

  it('takes the best fit across several targeted rungs', () => {
    expect(seniorityFit('lead', ['senior', 'lead'])).toBe(1);
    expect(seniorityFit('junior', ['senior', 'lead'])).toBe(0);
  });
});

describe('stackFit', () => {
  it('null when either side names no technology', () => {
    expect(stackFit([], ['React'])).toBeNull();
    expect(stackFit(['React'], [])).toBeNull();
  });

  it('share of the ad\'s technologies the user covers', () => {
    expect(stackFit(['React', 'TypeScript'], ['React'])).toBeCloseTo(0.5);
    expect(stackFit(['React'], ['React', 'Node', 'Python'])).toBe(1);
    expect(stackFit(['Java'], ['React'])).toBe(0);
  });
});

describe('scoreAd with a candidate profile (v3)', () => {
  const now = new Date('2026-08-24T12:00:00Z');
  const base = {
    facts: NO_FACTS,
    verdicts: [],
    ruleset: defaultRuleset(),
    directions: [direction({ searchTerms: ['frontend engineer'] })],
    source: 'LinkedIn',
    receivedAt: new Date(now.getTime() - 2 * 24 * 60 * 60 * 1000),
    now,
  };
  const candidate = {
    seniorities: ['senior'] as const,
    stack: ['React', 'TypeScript'],
    location: { city: null, remoteOk: false },
  };

  it('a title stating neither rung nor stack scores exactly as under v2', () => {
    for (const title of ['Frontend Engineer', 'Frontend Developer (m/w/d)', 'Marketing Analyst']) {
      const v2 = scoreAd({ ...base, title, calibration: CALIBRATION_V2 });
      const v3 = scoreAd({ ...base, title, candidate, calibration: DEFAULT_CALIBRATION });
      expect(v3.seniorityFit).toBeNull();
      expect(v3.stackFit).toBeNull();
      expect(v3.total).toBe(v2.total);
    }
  });

  it('without a candidate, v3 reduces to v2 on every title', () => {
    for (const title of ['Senior React Engineer', 'Junior Frontend Engineer', 'Frontend Engineer']) {
      const v2 = scoreAd({ ...base, title, calibration: CALIBRATION_V2 });
      const v3 = scoreAd({ ...base, title, calibration: DEFAULT_CALIBRATION });
      expect(v3.total).toBe(v2.total);
    }
  });

  it('breaks the directionFit tie: matching rung + stack > silent title > mismatched rung', () => {
    const score = (title: string) =>
      scoreAd({ ...base, title, candidate, calibration: DEFAULT_CALIBRATION }).total;
    const match = score('Senior Frontend Engineer (React)');
    const silent = score('Frontend Engineer');
    const mismatch = score('Junior Frontend Engineer');
    // All three are full-phrase direction matches (directionFit = 1.0) —
    // under v2 they tie; v3 orders them by who the user is.
    expect(match).toBeGreaterThan(silent);
    expect(silent).toBeGreaterThan(mismatch);
  });

  it('carries the effective weights, and the rows add up to the total', () => {
    const r = scoreAd({ ...base, title: 'Senior Frontend Engineer', candidate, calibration: DEFAULT_CALIBRATION });
    // Stack is silent on this title → its weight was handed back.
    expect(r.weights.stackFit).toBe(0);
    expect(sumOf(r.weights)).toBeCloseTo(1, 10);
    const rows =
      r.weights.ruleMargin * r.ruleMargin +
      r.weights.directionFit * r.directionFit +
      r.weights.signalCompleteness * r.signalCompleteness +
      r.weights.freshness * r.freshness +
      r.weights.sourceQuality * r.sourceQuality +
      r.weights.seniorityFit * (r.seniorityFit ?? 0);
    expect(Math.round(100 * rows)).toBe(r.total);
  });

  it('seniority and stack stay silent when no direction matched the role', () => {
    // "Senior" on an unrelated role is a rung on the wrong ladder — the
    // real-account eval showed v3 lifting "Senior Consultant" ads without this.
    const r = scoreAd({ ...base, title: 'Senior Consultant Digitalisierung (React)', candidate, calibration: DEFAULT_CALIBRATION });
    expect(r.directionFit).toBe(0);
    expect(r.seniorityFit).toBeNull();
    expect(r.stackFit).toBeNull();
    const v2 = scoreAd({ ...base, title: 'Senior Consultant Digitalisierung (React)', calibration: CALIBRATION_V2 });
    expect(r.total).toBe(v2.total);
  });

  it('reports the components it used, null for the ones without signal', () => {
    const r = scoreAd({
      ...base,
      title: 'Senior Frontend Engineer – React / Vue',
      candidate,
      calibration: DEFAULT_CALIBRATION,
    });
    expect(r.seniorityFit).toBe(1);
    expect(r.stackFit).toBeCloseTo(0.5);
  });
});

describe('scoreAd with a location (v4)', () => {
  const now = new Date('2026-08-24T12:00:00Z');
  const hamburg = {
    seniorities: [] as const,
    stack: [] as const,
    location: { city: 'Hamburg', remoteOk: true },
  };
  const score = (locationRaw: string | null) =>
    scoreAd({
      facts: NO_FACTS,
      verdicts: [],
      ruleset: defaultRuleset(),
      directions: [direction({ searchTerms: ['engineering manager'] })],
      candidate: hamburg,
      title: 'Engineering Manager',
      locationRaw,
      source: 'StepStone',
      receivedAt: now,
      now,
      calibration: DEFAULT_CALIBRATION,
    });

  it('orders an equal role match by distance from home, without dropping any', () => {
    const home = score('Hamburg').total;
    const country = score('Köln').total;
    const europe = score('Zurich').total;
    const far = score('San Francisco, CA').total;
    expect(home).toBeGreaterThan(country);
    expect(country).toBeGreaterThan(europe);
    expect(europe).toBeGreaterThan(far);
    // A strong role match abroad still clears a match — ranked lower,
    // not filtered out (the whole point of v4).
    expect(far).toBeGreaterThanOrEqual(DEFAULT_CALIBRATION.matchThreshold);
  });

  it('an unplaceable location scores exactly as under v3', () => {
    const v3 = scoreAd({
      facts: NO_FACTS,
      verdicts: [],
      ruleset: defaultRuleset(),
      directions: [direction({ searchTerms: ['engineering manager'] })],
      title: 'Engineering Manager',
      source: 'StepStone',
      receivedAt: now,
      now,
      calibration: CALIBRATION_V3,
    });
    const r = score('N/A');
    expect(r.locationFit).toBeNull();
    expect(r.total).toBe(v3.total);
  });
});

// ── selectMatches (I29) ──────────────────────────────────────────────────────

describe('selectMatches', () => {
  const mk = (id: string, total: number): ScoredAd => ({
    id,
    score: {
      ruleMargin: 1,
      directionFit: 1,
      signalCompleteness: 1,
      freshness: 1,
      sourceQuality: 1,
      seniorityFit: null,
      stackFit: null,
      total,
    } as ScoreBreakdown,
  });
  const cut = DEFAULT_CALIBRATION.matchThreshold;

  it('splits at the threshold: at or above is a match, below is explore', () => {
    const r = selectMatches([mk('a', cut), mk('b', cut - 1), mk('c', 100), mk('d', 0)], DEFAULT_CALIBRATION);
    expect(r.matches.map((a) => a.id)).toEqual(['c', 'a']);
    expect(r.explore.map((a) => a.id)).toEqual(['b', 'd']);
  });

  it('has no slot cap: every ad over the bar is a match', () => {
    const pool = Array.from({ length: 40 }, (_, i) => mk(`ad-${i}`, 60 + (i % 10)));
    const r = selectMatches(pool, DEFAULT_CALIBRATION);
    expect(r.matches).toHaveLength(40);
    expect(r.explore).toHaveLength(0);
  });

  it('two ads with the same score always land in the same section (the Figma case)', () => {
    // Same company, same title, same score — under the old caps one of them
    // went to Explore. Placement now depends on the score and nothing else.
    const r = selectMatches([mk('figma-a', 74), mk('figma-b', 74), mk('figma-c', 74)], DEFAULT_CALIBRATION);
    expect(r.matches.map((a) => a.id)).toEqual(['figma-a', 'figma-b', 'figma-c']);
    expect(r.explore).toHaveLength(0);
  });

  it('I29: no explore ad outscores a match, for any pool', () => {
    // Deterministic pseudo-random pool; the property is what is under test.
    let seed = 7;
    const rand = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
    for (let round = 0; round < 50; round++) {
      const pool = Array.from({ length: 30 }, (_, i) => mk(`r${round}-${i}`, Math.floor(rand() * 101)));
      const r = selectMatches(pool, DEFAULT_CALIBRATION);
      const lowestMatch = Math.min(...r.matches.map((a) => a.score.total), Infinity);
      const highestExplore = Math.max(...r.explore.map((a) => a.score.total), -Infinity);
      expect(highestExplore).toBeLessThan(lowestMatch);
      expect(r.matches.length + r.explore.length).toBe(pool.length);
    }
  });

  it('orders each section by score desc, then id asc, whatever the input order', () => {
    const r = selectMatches([mk('zebra', 80), mk('alpha', 80), mk('mid', 90), mk('low-b', 10), mk('low-a', 10)], DEFAULT_CALIBRATION);
    expect(r.matches.map((a) => a.id)).toEqual(['mid', 'alpha', 'zebra']);
    expect(r.explore.map((a) => a.id)).toEqual(['low-a', 'low-b']);
  });

  it('does not mutate its input', () => {
    const pool = [mk('b', 10), mk('a', 90)];
    selectMatches(pool, DEFAULT_CALIBRATION);
    expect(pool.map((a) => a.id)).toEqual(['b', 'a']);
  });

  it('an empty pool is empty output, not an error', () => {
    expect(selectMatches([], DEFAULT_CALIBRATION)).toEqual({ matches: [], explore: [] });
  });
});
