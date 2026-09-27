/**
 * How often is the Top pick tier empty? — measured offline, without
 * production data (ADR-003 §8.9).
 *
 * The ads are the real alert fixtures (test/fixtures/<platform>/*.eml) run
 * through the real pipeline: extractor → `normalizeAd` → Facts, with the
 * title and location line as read. Board ads (Greenhouse / Lever / Personio
 * / Ashby) have no fixture, so they are synthesised the way the providers in
 * packages/worker/src/providers build facts: no salary except on Ashby
 * (about half its postings carry compensation), home office from the
 * location string via the same `normalizeWorkplace`, Ashby's
 * workplaceType=Remote as home = 5.
 *
 * Each synthetic week draws 20–49 new ads in a scenario's platform mix,
 * spreads them over the week, and replays the digest path: evaluate → drop
 * hard-blocked → direction gate → level gate → scoreAd → selectTiers, once
 * under v4 (I23 as first written: Pay AND Onsite read) and once under v5
 * (only the hard ones). Scores are identical under both; only Top-pick
 * eligibility differs. Repeats and top-pick history are left out: they
 * exclude the same ads under both rules.
 *
 * Seeded, so the numbers are stable. `TOP_PICK_REPORT=1 npx vitest run
 * test/top-pick-eligibility.test.ts` prints the table the ADR quotes.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  CALIBRATION_V4,
  CALIBRATION_V5,
  directionFit,
  evaluate,
  isBelowTargetLevel,
  rulesetForCategory,
  scoreAd,
  selectTiers,
  type Calibration,
  type CandidateProfile,
  type Facts,
  type Ruleset,
  type ScoredAd,
  type ScoringDirection,
} from '@job-digest/core';
import { classify, extractorFor, layoutHash, normalizeAd, normalizeWorkplace, parseEml } from '../src/index';

interface PoolAd {
  id: string;
  platform: string;
  title: string;
  company: string | null;
  location: string | null;
  facts: Facts;
}

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

/** mulberry32 — a seeded PRNG so the report is reproducible. */
function prng(seed: number): () => number {
  let s = seed;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

async function fixtureAds(): Promise<PoolAd[]> {
  const root = new URL('./fixtures', import.meta.url).pathname;
  const out: PoolAd[] = [];
  const seen = new Set<string>();
  for (const dir of readdirSync(root, { withFileTypes: true })) {
    if (!dir.isDirectory()) continue;
    for (const file of readdirSync(join(root, dir.name))) {
      if (!file.endsWith('.eml')) continue;
      const email = await parseEml(readFileSync(join(root, dir.name, file)));
      const platform = classify(email.fromAddr);
      if (platform === 'not_allowlisted' || !email.bodyHtml) continue;
      const extractor = extractorFor(platform, layoutHash(email.bodyHtml));
      if (!extractor) continue;
      for (const ad of extractor.extract(email).ads) {
        const title = ad.title?.value ?? '';
        const company = ad.company?.value ?? null;
        // The same card arrives in several alerts; the product dedupes it too.
        const key = `${platform}|${title}|${company}`;
        if (!title || seen.has(key)) continue;
        seen.add(key);
        out.push({ id: key, platform, title, company, location: ad.location?.value ?? null, facts: normalizeAd(ad).facts });
      }
    }
  }
  return out;
}

// Board postings for the same user's directions, in the shapes the boards
// title them. Invented titles, real fact logic.
const BOARD_TITLES = [
  'Senior Frontend Engineer',
  'Frontend Engineer',
  'Senior Software Engineer, Frontend',
  'Engineering Manager',
  'Senior Full Stack Engineer',
  'Staff Frontend Engineer',
  'Engineering Manager, Payments',
  'Full Stack Developer',
  'Senior Backend Engineer',
  'Product Designer',
];
const BOARD_LOCATIONS = ['Berlin', 'Hamburg', 'Remote - Germany', 'Berlin (Hybrid)', 'Munich', 'Remote', 'Amsterdam'];

function boardAd(id: string, platform: string, rand: () => number): PoolAd {
  const location = BOARD_LOCATIONS[Math.floor(rand() * BOARD_LOCATIONS.length)]!;
  const facts: Facts = { ...NO_FACTS };
  const w = normalizeWorkplace(location);
  if (w) facts.home = w.home;
  if (platform === 'Ashby') {
    if (rand() < 0.3) facts.home = 5; // workplaceType: 'Remote'
    if (rand() < 0.5) facts.pay = 4000 + Math.round(rand() * 4000); // compensation published
  }
  return {
    id,
    platform,
    title: BOARD_TITLES[Math.floor(rand() * BOARD_TITLES.length)]!,
    company: `${platform}-co-${Math.floor(rand() * 25)}`,
    location,
    facts,
  };
}

/** The fixtures are one user's alerts: frontend / full-stack / EM in Hamburg. */
const DIRECTIONS: Array<ScoringDirection & { id: string }> = [
  { id: 'fe', distance: 'adjacent', searchTerms: ['frontend engineer', 'frontend developer'] },
  { id: 'fs', distance: 'adjacent', searchTerms: ['fullstack engineer', 'full stack developer'] },
  { id: 'em', distance: 'adjacent', searchTerms: ['engineering manager'] },
];
const CANDIDATE: CandidateProfile = {
  seniorities: ['senior'],
  stack: ['React', 'TypeScript'],
  location: { city: 'Hamburg', remoteOk: true },
};

/** Share of each week's ads per platform. Board share splits evenly across `boards`. */
interface Scenario {
  name: string;
  mix: { LinkedIn: number; Xing: number; StepStone: number; boards: number };
  boards: readonly string[];
}
const ALL_BOARDS = ['Greenhouse', 'Lever', 'Personio', 'Ashby'] as const;
const SCENARIOS: Scenario[] = [
  { name: 'fixture mix', mix: { LinkedIn: 0.25, Xing: 0.55, StepStone: 0.1, boards: 0.1 }, boards: ALL_BOARDS },
  { name: 'LinkedIn-heavy', mix: { LinkedIn: 0.7, Xing: 0.1, StepStone: 0.1, boards: 0.1 }, boards: ALL_BOARDS },
  { name: 'board-heavy', mix: { LinkedIn: 0.25, Xing: 0.25, StepStone: 0.1, boards: 0.4 }, boards: ALL_BOARDS },
  // No source that states a salary: LinkedIn alerts + the three boards
  // without compensation. The honest limit of the rule — see the test.
  {
    name: 'no pay-bearing source',
    mix: { LinkedIn: 0.6, Xing: 0, StepStone: 0, boards: 0.4 },
    boards: ['Greenhouse', 'Lever', 'Personio'],
  },
];

const ENGINEERING = rulesetForCategory('Engineering', 'DACH'); // Pay hard 3500, Onsite preference 3
const PAY_AS_PREFERENCE: Ruleset = { ...ENGINEERING, Pay: { ...ENGINEERING.Pay, severity: 'preference' } };

interface Tally {
  weeks: number;
  emptyTop: number;
  topSize: number;
  curatedSize: number;
  topBySource: Record<string, number>;
}

const WEEKS = 200;
const DAY = 24 * 60 * 60 * 1000;

function simulate(
  ads: readonly PoolAd[],
  scenario: Scenario,
  rules: Ruleset,
  calibrations: readonly Calibration[],
): Tally[] {
  const rand = prng(20260927);
  const byPlatform = {
    LinkedIn: ads.filter((a) => a.platform === 'LinkedIn'),
    Xing: ads.filter((a) => a.platform === 'Xing'),
    StepStone: ads.filter((a) => a.platform === 'StepStone'),
  };
  const tallies: Tally[] = calibrations.map(() => ({ weeks: 0, emptyTop: 0, topSize: 0, curatedSize: 0, topBySource: {} }));

  for (let w = 0; w < WEEKS; w++) {
    const now = new Date(Date.UTC(2026, 0, 5) + w * 7 * DAY);
    const size = 20 + Math.floor(rand() * 30);
    const week: Array<PoolAd & { receivedAt: Date }> = [];
    for (let i = 0; i < size; i++) {
      const x = rand();
      const { LinkedIn, Xing, StepStone } = scenario.mix;
      const receivedAt = new Date(now.getTime() - rand() * 7 * DAY);
      const id = `w${w}-${i}`;
      const platform = x < LinkedIn ? 'LinkedIn' : x < LinkedIn + Xing ? 'Xing' : x < LinkedIn + Xing + StepStone ? 'StepStone' : null;
      if (platform === null) {
        const board = scenario.boards[Math.floor(rand() * scenario.boards.length)]!;
        week.push({ ...boardAd(id, board, rand), receivedAt });
      } else {
        const from = byPlatform[platform as keyof typeof byPlatform];
        week.push({ ...from[Math.floor(rand() * from.length)]!, id, receivedAt });
      }
    }

    // The digest path, as getDigest runs it (packages/db/src/queries/digest.ts).
    const pool: ScoredAd[] = [];
    for (const ad of week) {
      const verdicts = evaluate(ad.facts, rules);
      if (verdicts.some((v) => v.state === 'block')) continue;
      const matched = DIRECTIONS.filter((d) => directionFit(ad.title, [d]) > 0).map((d) => d.id);
      if (matched.length === 0) continue; // direction gate
      if (isBelowTargetLevel(ad.title, CANDIDATE)) continue; // level gate (§8.7)
      pool.push({
        id: ad.id,
        score: scoreAd({
          facts: ad.facts,
          verdicts,
          ruleset: rules,
          directions: DIRECTIONS,
          candidate: CANDIDATE,
          title: ad.title,
          locationRaw: ad.location,
          source: ad.platform,
          receivedAt: ad.receivedAt,
          now,
          calibration: calibrations[0]!, // scores are identical across v4 / v5
        }),
        verdicts,
        company: ad.company,
        source: ad.platform,
        matchedDirectionIds: matched,
        hasPreferenceWarn: verdicts.some((v) => v.severity === 'preference' && v.state === 'warn'),
        repeat: false,
      });
    }

    calibrations.forEach((c, i) => {
      const t = selectTiers(pool, new Set(), c);
      const tally = tallies[i]!;
      tally.weeks++;
      if (t.topPicks.length === 0) tally.emptyTop++;
      tally.topSize += t.topPicks.length;
      tally.curatedSize += t.topPicks.length + t.worthAReading.length + t.stretch.length;
      for (const a of t.topPicks) tally.topBySource[a.source] = (tally.topBySource[a.source] ?? 0) + 1;
    });
  }
  return tallies;
}

const pct = (n: number, d: number) => `${Math.round((100 * n) / d)}%`;
const avg = (n: number, d: number) => (n / d).toFixed(2);

describe('Top pick tier on synthetic weeks built from the real alert fixtures', async () => {
  const ads = await fixtureAds();
  const calibrations = [CALIBRATION_V4, CALIBRATION_V5];

  const results = [ENGINEERING, PAY_AS_PREFERENCE].flatMap((rules) =>
    SCENARIOS.map((scenario) => ({
      scenario: scenario.name,
      payRule: rules.Pay.severity,
      tallies: simulate(ads, scenario, rules, calibrations),
    })),
  );

  if (process.env.TOP_PICK_REPORT) {
    console.table(
      results.flatMap((r) =>
        r.tallies.map((t, i) => ({
          scenario: r.scenario,
          Pay: r.payRule,
          calibration: `v${calibrations[i]!.version}`,
          'empty Top weeks': pct(t.emptyTop, t.weeks),
          'Top size': avg(t.topSize, t.weeks),
          'curated size': avg(t.curatedSize, t.weeks),
          'Top by source': Object.entries(t.topBySource)
            .sort((a, b) => b[1] - a[1])
            .map(([s, n]) => `${s} ${n}`)
            .join(', '),
        })),
      ),
    );
  }

  const get = (scenario: string, payRule: string) =>
    results.find((r) => r.scenario === scenario && r.payRule === payRule)!.tallies;

  it('reads the fixture corpus: salary on most Xing / StepStone cards, never on LinkedIn; a home-office count rarely', () => {
    const share = (platform: string, f: (a: PoolAd) => boolean) => {
      const on = ads.filter((a) => a.platform === platform);
      return on.filter(f).length / on.length;
    };
    expect(share('Xing', (a) => a.facts.pay !== null)).toBeGreaterThan(0.8);
    expect(share('StepStone', (a) => a.facts.pay !== null)).toBeGreaterThan(0.8);
    expect(share('LinkedIn', (a) => a.facts.pay !== null)).toBe(0);
    expect(share('Xing', (a) => a.facts.home !== null)).toBeLessThan(0.1);
    expect(share('StepStone', (a) => a.facts.home !== null)).toBeLessThan(0.1);
  });

  it('under v4 the Top tier is empty in most weeks; under v5 it rarely is', () => {
    const [v4, v5] = get('fixture mix', 'hard');
    expect(v4!.emptyTop / v4!.weeks).toBeGreaterThan(0.5);
    expect(v5!.emptyTop / v5!.weeks).toBeLessThan(0.1);
  });

  it('v5 never empties a week v4 filled, and never shrinks the curated ten', () => {
    for (const r of results) {
      const [v4, v5] = r.tallies;
      expect(v5!.emptyTop).toBeLessThanOrEqual(v4!.emptyTop);
      expect(v5!.curatedSize).toBeGreaterThanOrEqual(v4!.curatedSize);
    }
  });

  it('with Pay hard, no v5 Top pick comes from a source that never states pay', () => {
    for (const r of results.filter((x) => x.payRule === 'hard')) {
      const v5 = r.tallies[1]!;
      for (const source of ['LinkedIn', 'Greenhouse', 'Lever', 'Personio']) {
        expect(v5.topBySource[source] ?? 0).toBe(0);
      }
    }
  });

  it('the honest limit: without a pay-bearing source the tier stays empty while Pay is hard — and fills once Pay is a preference', () => {
    const [, hardPay] = get('no pay-bearing source', 'hard');
    const [, preferencePay] = get('no pay-bearing source', 'preference');
    expect(hardPay!.emptyTop).toBe(hardPay!.weeks);
    expect(preferencePay!.emptyTop / preferencePay!.weeks).toBeLessThan(0.1);
  });
});
