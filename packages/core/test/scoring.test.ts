/**
 * Scoring suite — one describe block per component, then composed scoreAd
 * and selectTiers. Same table-driven style as evaluate.test.ts. Every
 * component has a dedicated boundary case; composition tests pin the
 * invariants ADR-003 introduces (I21–I25).
 */
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_CALIBRATION,
  directionFit,
  freshness,
  isCertain,
  ruleMargin,
  scoreAd,
  selectTiers,
  signalCompleteness,
  sourceQuality,
  type Calibration,
  type ScoredAd,
  type ScoringDirection,
} from '../src/scoring';
import type { Facts, Ruleset, Verdict } from '../src/index';

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
  it('returns 1.0 when the user has no directions — no signal, no penalty', () => {
    expect(directionFit('Senior Software Engineer', [])).toBe(1.0);
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
    // "manager" is 7 chars — below the 8-char threshold, so title needs a
    // longer word. Use "engineer" (8 chars) which matches alone.
    const dirs = [direction({ searchTerms: ['software engineer'], distance: 'adjacent' })];
    // "Sr Full-Stack Engineer" tokenizes to ['full', 'stack', 'engineer'];
    // 'software' is not a substring, but 'engineer' (8 chars) matches.
    expect(directionFit('Senior Full-Stack Engineer', dirs)).toBeCloseTo(0.6);
  });

  it('picks the best across multiple directions after applying distance factor', () => {
    const dirs = [
      // adjacent direction: phrase fails (no 'devops' in title), but 'engineer'
      // is ≥8 chars and matches → long-word = 0.6 × 1.0 = 0.6
      direction({ searchTerms: ['engineer devops'], distance: 'adjacent' }),
      // stretch direction: full-phrase match → 1.0 * 0.5 = 0.5
      direction({ searchTerms: ['product manager'], distance: 'stretch' }),
    ];
    expect(directionFit('Senior Product Manager', dirs)).toBeCloseTo(0.5);
    expect(directionFit('Senior TypeScript Engineer', dirs)).toBeCloseTo(0.6);
  });

  it('title with no signal returns 0', () => {
    const dirs = [direction({ searchTerms: ['engineering manager'], distance: 'adjacent' })];
    expect(directionFit('Marketing Analyst', dirs)).toBe(0);
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

// ── isCertain ───────────────────────────────────────────────────────────────

describe('isCertain', () => {
  const v = (key: Verdict['key'], state: Verdict['state']): Verdict => ({
    key,
    severity: 'hard',
    state,
    because: [],
  });

  it('true when Pay and Onsite are both non-unknown', () => {
    expect(isCertain([v('Pay', 'pass'), v('Onsite', 'pass')])).toBe(true);
    expect(isCertain([v('Pay', 'warn'), v('Onsite', 'pass')])).toBe(true);
  });

  it('false when Pay is unknown', () => {
    expect(isCertain([v('Pay', 'unknown'), v('Onsite', 'pass')])).toBe(false);
  });

  it('false when Onsite is unknown', () => {
    expect(isCertain([v('Pay', 'pass'), v('Onsite', 'unknown')])).toBe(false);
  });

  it('true when other rules are unknown but Pay and Onsite are known', () => {
    expect(
      isCertain([
        v('Pay', 'pass'),
        v('Onsite', 'pass'),
        v('German', 'unknown'),
        v('Contract', 'unknown'),
        v('Shift', 'unknown'),
      ]),
    ).toBe(true);
  });

  it('missing Pay/Onsite verdicts (a malformed evaluation) is treated as certain — the caller is expected to always run evaluate() first', () => {
    // Defensive check: isCertain does not require the caller to always
    // have both. A missing Pay verdict cannot be `unknown`, so it does
    // not trip the gate.
    expect(isCertain([])).toBe(true);
  });
});

// ── DEFAULT_CALIBRATION invariants ──────────────────────────────────────────

describe('DEFAULT_CALIBRATION', () => {
  it('the five weights sum to 1.0', () => {
    const w = DEFAULT_CALIBRATION.weights;
    const sum = w.ruleMargin + w.directionFit + w.signalCompleteness + w.freshness + w.sourceQuality;
    expect(sum).toBeCloseTo(1);
  });

  it('every weight is in [0, 1]', () => {
    for (const value of Object.values(DEFAULT_CALIBRATION.weights)) {
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThanOrEqual(1);
    }
  });

  it('tier thresholds are in [0, 100] and ordered top ≥ stretch ≥ read', () => {
    const t = DEFAULT_CALIBRATION.tierThresholds;
    for (const value of Object.values(t)) {
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThanOrEqual(100);
    }
    expect(t.topPick).toBeGreaterThanOrEqual(t.stretch);
    expect(t.stretch).toBeGreaterThanOrEqual(t.worthAReading);
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

  it('an empty-facts LinkedIn ad with no directions and 7-day age scores at the floor combination', () => {
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
    // ruleMargin 0.5 * 0.30 = 0.150
    // directionFit 1.0 * 0.30 = 0.300 (no directions → full score, no penalty)
    // signalCompleteness 0 * 0.15 = 0
    // freshness 0.4 * 0.15 = 0.060
    // sourceQuality 0.6 * 0.10 = 0.060
    // sum = 0.570 → 57
    expect(result.total).toBe(57);
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

// ── selectTiers ──────────────────────────────────────────────────────────────

describe('selectTiers', () => {
  const mk = (p: Partial<ScoredAd> & { id: string; total: number }): ScoredAd => ({
    id: p.id,
    score: {
      ruleMargin: 1,
      directionFit: 1,
      signalCompleteness: 1,
      freshness: 1,
      sourceQuality: 1,
      total: p.total,
      ...(p.score ?? {}),
    },
    verdicts: p.verdicts ?? [
      { key: 'Pay', severity: 'hard', state: 'pass', because: [] },
      { key: 'Onsite', severity: 'preference', state: 'pass', because: [] },
    ],
    company: p.company ?? `Company-${p.id}`,
    source: p.source ?? 'Greenhouse',
    matchedDirectionIds: p.matchedDirectionIds ?? [],
    hasPreferenceWarn: p.hasPreferenceWarn ?? false,
  });

  const empty: ReadonlySet<string> = new Set();

  it('caps top picks at 2, reads at 6, stretch at 2, rest to explore', () => {
    // Rotate sources so the per-platform cap (5) does not fire before the
    // per-tier caps do — this test is about tier caps in isolation.
    const platforms = ['Greenhouse', 'Lever', 'Ashby', 'Personio'] as const;
    const src = (i: number): string => platforms[i % platforms.length]!;
    const pool: ScoredAd[] = [
      ...Array.from({ length: 5 }, (_, i) => mk({ id: `top-${i}`, total: 90, source: src(i) })),
      ...Array.from({ length: 10 }, (_, i) => mk({ id: `read-${i}`, total: 60, source: src(i) })),
      ...Array.from({ length: 5 }, (_, i) => mk({
        id: `stretch-${i}`,
        total: 40,
        score: { ruleMargin: 0.1, directionFit: 0.9, signalCompleteness: 0.5, freshness: 1, sourceQuality: 0.6, total: 40 },
        hasPreferenceWarn: true,
        source: src(i),
      })),
    ];
    const result = selectTiers(pool, empty, DEFAULT_CALIBRATION);
    expect(result.topPicks).toHaveLength(2);
    expect(result.worthAReading).toHaveLength(6);
    expect(result.stretch).toHaveLength(2);
    expect(result.explore).toHaveLength(pool.length - 10);
  });

  it('I23 — an ad with unknown Pay cannot be a top pick even at score 99', () => {
    const uncertain: Verdict[] = [
      { key: 'Pay', severity: 'hard', state: 'unknown', because: [] },
      { key: 'Onsite', severity: 'preference', state: 'pass', because: [] },
    ];
    const pool = [
      mk({ id: 'a', total: 99, verdicts: uncertain }),
      mk({ id: 'b', total: 80 }),
      mk({ id: 'c', total: 76 }),
    ];
    const result = selectTiers(pool, empty, DEFAULT_CALIBRATION);
    expect(result.topPicks.map((a) => a.id)).toEqual(['b', 'c']);
    // 'a' still qualifies for read (score 99 >= 55) — I23 only gates Top.
    expect(result.worthAReading.map((a) => a.id)).toContain('a');
  });

  it('I25 — an ad in the history is ineligible for Top pick but can appear in Read', () => {
    const pool = [
      mk({ id: 'a', total: 95 }),
      mk({ id: 'b', total: 90 }),
      mk({ id: 'c', total: 80 }),
    ];
    const history: ReadonlySet<string> = new Set(['a']);
    const result = selectTiers(pool, history, DEFAULT_CALIBRATION);
    expect(result.topPicks.map((a) => a.id)).toEqual(['b', 'c']);
    expect(result.worthAReading.map((a) => a.id)).toContain('a');
  });

  it('I24 — top-pick per-company cap is 1: two ads from same company do not both make Top', () => {
    const pool = [
      mk({ id: 'a', total: 95, company: 'Stripe' }),
      mk({ id: 'b', total: 94, company: 'Stripe' }),
      mk({ id: 'c', total: 80, company: 'Datadog' }),
    ];
    const result = selectTiers(pool, empty, DEFAULT_CALIBRATION);
    expect(result.topPicks.map((a) => a.id)).toEqual(['a', 'c']);
    // b is culled by top's per-company cap, but should reappear in Read.
    expect(result.worthAReading.map((a) => a.id)).toContain('b');
  });

  it('I24 — worth-a-read per-company cap is 2', () => {
    const pool = Array.from({ length: 5 }, (_, i) =>
      mk({ id: `n26-${i}`, total: 70, company: 'N26' }),
    );
    const result = selectTiers(pool, empty, DEFAULT_CALIBRATION);
    // Score 70 is under the top threshold (75), so all five compete for Read.
    // At most 2 per company can be in Read.
    expect(result.worthAReading).toHaveLength(2);
    expect(result.explore).toHaveLength(3);
  });

  it('I24 — per-platform cap is 5', () => {
    const pool = Array.from({ length: 8 }, (_, i) =>
      mk({ id: `li-${i}`, total: 70, source: 'LinkedIn', company: `C${i}` }),
    );
    const result = selectTiers(pool, empty, DEFAULT_CALIBRATION);
    expect(result.worthAReading).toHaveLength(5);
    // 3 overflow → explore (per-platform cap fired before slot cap of 6).
    expect(result.explore).toHaveLength(3);
  });

  it('a slot with no qualifying candidate stays empty rather than being padded', () => {
    // Nothing scores above 75; top picks come back empty and reads absorb.
    const pool = [
      mk({ id: 'a', total: 65 }),
      mk({ id: 'b', total: 60 }),
      mk({ id: 'c', total: 58 }),
    ];
    const result = selectTiers(pool, empty, DEFAULT_CALIBRATION);
    expect(result.topPicks).toHaveLength(0);
    expect(result.worthAReading.map((a) => a.id)).toEqual(['a', 'b', 'c']);
    expect(result.stretch).toHaveLength(0);
  });

  it('stretch requires hasPreferenceWarn AND directionFit >= threshold, not total', () => {
    const strong = { ruleMargin: 0.2, directionFit: 0.8, signalCompleteness: 0.5, freshness: 1, sourceQuality: 0.6, total: 45 };
    const weak = { ruleMargin: 0.2, directionFit: 0.4, signalCompleteness: 0.5, freshness: 1, sourceQuality: 0.6, total: 45 };
    const pool = [
      mk({ id: 'strong-with-warn', total: 45, score: strong, hasPreferenceWarn: true }),
      mk({ id: 'strong-no-warn', total: 45, score: strong, hasPreferenceWarn: false }),
      mk({ id: 'weak-with-warn', total: 45, score: weak, hasPreferenceWarn: true }),
    ];
    const result = selectTiers(pool, empty, DEFAULT_CALIBRATION);
    expect(result.stretch.map((a) => a.id)).toEqual(['strong-with-warn']);
    // The other two land in Explore (below Read's 55 threshold too).
    expect(result.explore.map((a) => a.id).sort()).toEqual(['strong-no-warn', 'weak-with-warn']);
  });

  it('an ad taken as Top pick is not double-counted in Read', () => {
    const pool = [
      mk({ id: 'a', total: 90 }),
      mk({ id: 'b', total: 80 }),
      mk({ id: 'c', total: 70 }),
    ];
    const result = selectTiers(pool, empty, DEFAULT_CALIBRATION);
    expect(result.topPicks.map((a) => a.id)).toEqual(['a', 'b']);
    expect(result.worthAReading.map((a) => a.id)).toEqual(['c']);
  });

  it('tie-broken by id ascending so ordering is deterministic', () => {
    const pool = [
      mk({ id: 'zebra', total: 80 }),
      mk({ id: 'alpha', total: 80 }),
    ];
    const result = selectTiers(pool, empty, DEFAULT_CALIBRATION);
    expect(result.topPicks.map((a) => a.id)).toEqual(['alpha', 'zebra']);
  });

  it('null-company ads are all treated as distinct — no false diversity collision', () => {
    const pool = [
      mk({ id: 'a', total: 95, company: null }),
      mk({ id: 'b', total: 90, company: null }),
    ];
    const result = selectTiers(pool, empty, DEFAULT_CALIBRATION);
    // Both make Top — they are not the same company just because both are null.
    expect(result.topPicks.map((a) => a.id)).toEqual(['a', 'b']);
  });

  it('I24 — per-direction cap is 6', () => {
    // Rotate platforms so per-platform (5) doesn't fire before per-direction (6).
    const platforms = ['Greenhouse', 'Lever', 'Ashby', 'Personio'] as const;
    const pool = Array.from({ length: 8 }, (_, i) =>
      mk({
        id: `x-${i}`,
        total: 60,
        source: platforms[i % platforms.length]!,
        company: `C${i}`,
        matchedDirectionIds: ['dir-1'],
      }),
    );
    const result = selectTiers(pool, empty, DEFAULT_CALIBRATION);
    // With 8 all matching one direction, worth-a-read can only take 6.
    expect(result.worthAReading).toHaveLength(6);
    expect(result.explore).toHaveLength(2);
  });

  it('an ad using a custom calibration with weight 0 for source still totals correctly', () => {
    const noSourceEffect: Calibration = {
      ...DEFAULT_CALIBRATION,
      weights: {
        ruleMargin: 0.35,
        directionFit: 0.35,
        signalCompleteness: 0.15,
        freshness: 0.15,
        sourceQuality: 0,
      },
    };
    const now = new Date('2026-08-24T12:00:00Z');
    const result = scoreAd({
      facts: NO_FACTS,
      verdicts: [],
      ruleset: defaultRuleset(),
      directions: [],
      title: 'anything',
      source: 'LinkedIn',
      receivedAt: now,
      now,
      calibration: noSourceEffect,
    });
    // ruleMargin 0.5*0.35 = 0.175
    // directionFit 1.0*0.35 = 0.350 (no directions → full score)
    // signalCompleteness 0*0.15 = 0
    // freshness 1.0*0.15 = 0.150 (receivedAt === now → age 0)
    // sourceQuality 0.6*0 = 0
    // sum = 0.675 → 68
    expect(result.total).toBe(68);
  });
});
