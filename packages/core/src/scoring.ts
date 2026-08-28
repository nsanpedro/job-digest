/**
 * Curated-digest scoring (ADR-003).
 *
 * A pure function of (facts, verdicts, ruleset, directions, title, source,
 * receivedAt, now, calibration) → a five-component ScoreBreakdown. Same
 * posture as `evaluate.ts`: no I/O, no persistence, no LLM — the read path
 * recomputes on every digest fetch (I22, extending I6 from verdicts to
 * ranking).
 *
 * Selection of the weekly tiers is a second pure function, `selectTiers`,
 * layered on top. Scoring produces a number; selection turns numbers into
 * Top:2 / Read:6 / Stretch:2, respecting diversity (I24), certainty (I23)
 * and no-repeat-Top-pick history (I25). The split is deliberate — the
 * "why did this ad end up in Stretch?" question has one answer in each
 * function, not a compound one.
 */
import { LEVELS, type Facts, type Ruleset, type Verdict } from './types';
import type { Distance } from './discovery';

// ── Public types ─────────────────────────────────────────────────────────────

export interface ScoreBreakdown {
  /** How far the ad clears the rules — not pass/fail, margin above the floor. */
  ruleMargin: number;
  /** Best (match_strength × distance) across the user's directions. */
  directionFit: number;
  /** Fraction of consulted facts the extractor actually read. */
  signalCompleteness: number;
  /** Linear decay from receivedAt: day 0 = 1.0, day 7 = 0.4. */
  freshness: number;
  /** Per-source prior — API-sourced ads over email-alert ads. */
  sourceQuality: number;
  /** round(100 × Σ (weight × component)). */
  total: number;
}

/**
 * Only what scoring reads from a direction. The caller (getDigest) hands in
 * `DirectionRow` from the db package unchanged — this interface is a subset
 * so `packages/core` stays free of a dependency on `packages/db`.
 */
export interface ScoringDirection {
  distance: Distance;
  searchTerms: readonly string[];
}

/**
 * The five weights, three tier thresholds, source priors and freshness knob.
 * Versioned so a screenshot from last week is legible even if constants
 * have moved (ADR-003 §2.7 — same versioning discipline as the ruleset).
 */
export interface Calibration {
  version: number;
  weights: {
    ruleMargin: number;
    directionFit: number;
    signalCompleteness: number;
    freshness: number;
    sourceQuality: number;
  };
  tierThresholds: {
    /** Top pick eligibility. */
    topPick: number;
    /** Worth-a-read eligibility. */
    worthAReading: number;
    /** Stretch eligibility (measured on directionFit alone — see selectTiers). */
    stretch: number;
  };
  /** Prior per source name. Missing keys fall back to `defaultSourcePrior`. */
  sourcePriors: Record<string, number>;
  defaultSourcePrior: number;
  /** Days over which freshness decays from 1.0 down to the floor. */
  freshnessDecayDays: number;
  /** Floor freshness reaches at freshnessDecayDays (linear from 1.0). */
  freshnessFloor: number;
}

/**
 * v2 calibration — rebalanced after real-usage feedback (Aug 2026).
 *
 * v1's math made curated tiers structurally unreachable for the typical
 * email-platform ad. With most facts null (Xing/LinkedIn rarely carry Pay
 * or Onsite in the alert), signalCompleteness=0 and ruleMargin≈0.5, so the
 * score depended almost entirely on directionFit. A long-word direction
 * match capped total at 54 — below worthAReading (55). A full-phrase
 * match on an email platform capped at 66 — well below topPick (75).
 *
 * v2 shifts weight away from what we rarely read (signalCompleteness,
 * ruleMargin) toward what we can measure reliably (directionFit,
 * freshness) and lowers the tier thresholds to match the resulting
 * distribution. Same posture as v1 — hand-picked, not learned.
 *
 * Learning weights over N=1 is astrology; a code change with a bumped
 * `version` is the way to move them.
 */
export const DEFAULT_CALIBRATION: Calibration = {
  version: 2,
  weights: {
    ruleMargin: 0.25,
    directionFit: 0.35,
    signalCompleteness: 0.1,
    freshness: 0.2,
    sourceQuality: 0.1,
  },
  tierThresholds: {
    topPick: 70,
    worthAReading: 50,
    stretch: 60,
  },
  sourcePriors: {
    Greenhouse: 1.0,
    Lever: 1.0,
    Ashby: 1.0,
    Personio: 1.0,
    LinkedIn: 0.6,
    Xing: 0.6,
    StepStone: 0.6,
    Indeed: 0.6,
  },
  defaultSourcePrior: 0.6,
  freshnessDecayDays: 7,
  freshnessFloor: 0.4,
};

// ── Component functions (exported so tests can pin each one) ─────────────────

const clamp01 = (n: number): number => (n < 0 ? 0 : n > 1 ? 1 : n);

/**
 * Per-rule margin, averaged across the five rules.
 *
 * Not verdict-based: the score needs to know *how far above the floor* an ad
 * clears each rule, which the verdict states (pass/warn/unknown/block) do
 * not encode. A hard-blocked ad never reaches scoring — the caller filters
 * those out first — so `block` is not a case here.
 *
 * `unknown` returns 0.5 (I-ADR003 §2.6): the ad neither gains nor loses on
 * the rule it didn't answer. `signalCompleteness` is the component that
 * separately punishes unread-ness, so the two effects do not compound.
 */
export function ruleMargin(facts: Facts, ruleset: Ruleset): number {
  const values = [
    shiftMargin(facts, ruleset.Shift.condition),
    germanMargin(facts, ruleset.German.condition),
    onsiteMargin(facts, ruleset.Onsite.condition),
    payMargin(facts, ruleset.Pay.condition),
    contractMargin(facts, ruleset.Contract.condition),
  ];
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function shiftMargin(f: Facts, c: Ruleset['Shift']['condition']): number {
  const clauses = [
    { active: c.noRotating, value: f.rotating },
    { active: c.noWeekend, value: f.weekend },
  ].filter((cl) => cl.active);
  if (clauses.length === 0) return 1;
  if (clauses.some((cl) => cl.value === true)) return 0;
  if (clauses.some((cl) => cl.value === null)) return 0.5;
  return 1;
}

function germanMargin(f: Facts, c: Ruleset['German']['condition']): number {
  if (f.german === null) return 0.5;
  return LEVELS[f.german] > LEVELS[c.maxDemanded] ? 0 : 1;
}

function onsiteMargin(f: Facts, c: Ruleset['Onsite']['condition']): number {
  if (c.minHomeDays <= 0) return 1;
  if (f.home === null) return 0.5;
  if (f.home < c.minHomeDays) return 0;
  const denom = 5 - c.minHomeDays;
  if (denom <= 0) return 1;
  return 0.5 + 0.5 * clamp01((f.home - c.minHomeDays) / denom);
}

function payMargin(f: Facts, c: Ruleset['Pay']['condition']): number {
  const v = c.basis === 'fte' ? (f.payFte ?? f.pay) : f.pay;
  if (v === null) return 0.5;
  if (v < c.minMonthly) return 0;
  if (c.minMonthly <= 0) return 1;
  return clamp01((v - c.minMonthly) / c.minMonthly);
}

function contractMargin(f: Facts, c: Ruleset['Contract']['condition']): number {
  if (!c.permanentOnly) return 1;
  if (f.permanent === null) return 0.5;
  return f.permanent ? 1 : 0;
}

// ── Direction fit ────────────────────────────────────────────────────────────

const STOP_WORDS = new Set([
  'and', 'the', 'for', 'with', 'from',
  'von', 'und', 'für', 'mit', 'der', 'die', 'das', 'bei', 'zur', 'als',
]);

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[\s/,\-()+]+/)
    .filter((w) => w.length >= 3 && !STOP_WORDS.has(w));
}

// The two direction distances defined by ADR-001 (`Distance = 'adjacent' |
// 'stretch'`). `adjacent` is a direction close to the user's current profile;
// `stretch` is further away and its evidence therefore counts for less.
// ADR-003 §2.4 named a third `primary` tier that does not exist in the
// system — the two-tier model here is authoritative.
const DISTANCE_FACTOR: Record<Distance, number> = {
  adjacent: 1.0,
  stretch: 0.5,
};

/**
 * Role synonyms — treat these words as interchangeable when matching a
 * direction's search terms against an ad title. Bilingual by design: the
 * German market posts ads in both English and German (often mixed in the
 * same title), and the user's directions may be written in either language.
 * Without this map, a direction whose search term is "Engineer" would fail
 * to match a title "Fullstack Developer" — the same role, different word.
 *
 * Key = search-term word; values = accepted matches in the ad title.
 * Kept minimal on purpose: only widely-interchangeable role words. Adding
 * "senior"/"lead" would open false positives ("Senior Nurse" ≠ engineering).
 *
 * All entries are ≥8 chars, so the long-word gate in `directionFit` remains
 * meaningful — a synonym match is still evidence of role affinity, not
 * accidental substring overlap.
 */
export const ROLE_SYNONYMS: Readonly<Record<string, readonly string[]>> = {
  // Engineering family — English ↔ German
  engineer: ['engineer', 'developer', 'entwickler'],
  developer: ['engineer', 'developer', 'entwickler'],
  entwickler: ['engineer', 'developer', 'entwickler'],
  // Design family — English ↔ German. "gestalter" covers "UX-Gestalter",
  // "Kommunikationsgestalter", etc. "creative" picks up "Creative Director".
  designer: ['designer', 'gestalter'],
  gestalter: ['designer', 'gestalter'],
  // Product family
  manager: ['manager', 'managerin'],
  managerin: ['manager', 'managerin'],
};

/** True when `word` (or any of its ROLE_SYNONYMS) appears as a substring of `title`. */
function titleHasWord(title: string, word: string): boolean {
  const alts = ROLE_SYNONYMS[word] ?? [word];
  return alts.some((alt) => title.includes(alt));
}

/**
 * Graded upgrade of `matchesAnyDirection` (`packages/db/src/queries/digest.ts`).
 * That version is boolean — either a direction matches or it doesn't.
 * Ranking needs finer signal: a title that matches a whole search phrase is
 * stronger evidence than one that only shares a long word.
 *
 * Match strength per direction:
 *   1.0 — full-phrase: every tokenized word of any searchTerm appears in the
 *         title as a substring.
 *   0.6 — long-word: at least one ≥8-char word from any searchTerm appears
 *         in the title (matches the same 8-char threshold the boolean version
 *         uses to avoid false positives from "senior"/"lead"/"manager").
 *   0.0 — no signal.
 *
 * Direction fit for the ad is the max over `matchStrength × DISTANCE_FACTOR`.
 * When the user has no interested directions we return 0.5 — neutral, so an
 * ad neither wins nor loses on a signal the user did not give.
 */
export function directionFit(title: string, directions: readonly ScoringDirection[]): number {
  // No directions configured → direction fit is not a signal at all.
  // Return 1.0 (full score) rather than 0.5 so unconfigured users aren't
  // silently penalised — every ad is equally valid direction-wise until the
  // user tells us otherwise.
  if (directions.length === 0) return 1.0;
  const t = title.toLowerCase();
  let best = 0;
  for (const dir of directions) {
    const factor = DISTANCE_FACTOR[dir.distance];
    let strength = 0;
    for (const term of dir.searchTerms) {
      const words = tokenize(term);
      if (words.length === 0) continue;
      if (words.every((w) => titleHasWord(t, w))) {
        strength = Math.max(strength, 1);
      }
    }
    if (strength < 1) {
      const anyLong = dir.searchTerms
        .flatMap(tokenize)
        .some((w) => w.length >= 8 && titleHasWord(t, w));
      if (anyLong) strength = Math.max(strength, 0.6);
    }
    best = Math.max(best, strength * factor);
  }
  return best;
}

// ── Signal completeness ──────────────────────────────────────────────────────

/**
 * Fraction of facts the ruleset would consult that the extractor actually
 * read. A ruleset with Shift.noRotating=false and Shift.noWeekend=false does
 * not consult rotating/weekend — those don't count toward the denominator,
 * so a low-signal ad is not penalised for missing a fact nobody was going to
 * read.
 *
 * When the ruleset consults nothing (an empty theoretical config), returns
 * 1.0 — there is no unread-ness to punish.
 */
export function signalCompleteness(facts: Facts, ruleset: Ruleset): number {
  const consulted: Array<{ read: boolean }> = [];

  if (ruleset.Shift.condition.noRotating) {
    consulted.push({ read: facts.rotating !== null });
  }
  if (ruleset.Shift.condition.noWeekend) {
    consulted.push({ read: facts.weekend !== null });
  }
  // German is always consulted — even a C2 ceiling still asks whether we
  // could read the ad's demanded level. If we can't, that is genuine unread.
  consulted.push({ read: facts.german !== null });
  if (ruleset.Onsite.condition.minHomeDays > 0) {
    consulted.push({ read: facts.home !== null });
  }
  {
    const v = ruleset.Pay.condition.basis === 'fte' ? (facts.payFte ?? facts.pay) : facts.pay;
    consulted.push({ read: v !== null });
  }
  if (ruleset.Contract.condition.permanentOnly) {
    consulted.push({ read: facts.permanent !== null });
  }

  if (consulted.length === 0) return 1;
  const read = consulted.filter((c) => c.read).length;
  return read / consulted.length;
}

// ── Freshness ────────────────────────────────────────────────────────────────

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Linear decay from `1.0` at day 0 down to `freshnessFloor` at
 * `freshnessDecayDays`, then continuing linearly to 0 and clamped there.
 *
 * Digest windows are 7 days, and freshnessDecayDays defaults to 7, so ads
 * inside the window all sit in the initial [1.0, floor] range. The
 * beyond-window path exists so a replay of a past week under a later `now`
 * still returns a defined number without the caller having to guard.
 */
export function freshness(
  receivedAt: Date,
  now: Date,
  decayDays: number,
  floor: number,
): number {
  const ageDays = Math.max(0, (now.getTime() - receivedAt.getTime()) / MS_PER_DAY);
  if (decayDays <= 0) return floor;
  const ratio = ageDays / decayDays;
  const value = 1 - ratio * (1 - floor);
  return Math.max(0, value);
}

// ── Source quality prior ─────────────────────────────────────────────────────

/**
 * Small effect on purpose (weight 0.10 by default): a tiebreak, not a policy.
 * The four API-sourced platforms score 1.0 because they come from a company
 * the user hand-picked in Profile (ADR-002); the email-alert platforms score
 * 0.6 because their pool includes the ambient noise of whatever keyword the
 * user configured months ago.
 *
 * Unknown source names fall back to `defaultSourcePrior` rather than throw —
 * a future adapter for a fifth platform should not have to touch this file
 * to appear at all.
 */
export function sourceQuality(source: string, calibration: Calibration): number {
  return calibration.sourcePriors[source] ?? calibration.defaultSourcePrior;
}

// ── Certainty (Top-pick gate, I23) ───────────────────────────────────────────

/**
 * True when no rule that decides Top-pick eligibility is `unknown`. Pay and
 * Onsite are the two — an ad we couldn't read the salary of, or the home-
 * office policy of, cannot carry the product's strongest recommendation.
 *
 * A rule whose condition is inactive (Onsite.minHomeDays === 0) does not
 * count against certainty even if the fact is null: we didn't need to know.
 * That check is folded into the verdict — an inactive Onsite condition
 * returns `pass`, not `unknown`.
 */
export function isCertain(verdicts: readonly Verdict[]): boolean {
  const pay = verdicts.find((v) => v.key === 'Pay');
  const onsite = verdicts.find((v) => v.key === 'Onsite');
  if (pay?.state === 'unknown') return false;
  if (onsite?.state === 'unknown') return false;
  return true;
}

// ── Composed score ───────────────────────────────────────────────────────────

export interface ScoreAdArgs {
  facts: Facts;
  verdicts: readonly Verdict[];
  ruleset: Ruleset;
  directions: readonly ScoringDirection[];
  title: string;
  source: string;
  receivedAt: Date;
  now: Date;
  calibration: Calibration;
}

/**
 * The scoring function. Pure. Every input is a value the caller already has
 * on hand at digest read time — no fetches, no side effects.
 *
 * Total is `round(100 × Σ (weight_i × component_i))`. The weights sum to 1.0
 * by construction (a test in the suite guards it), so the total lives in
 * `[0, 100]` without further clamping.
 */
export function scoreAd(args: ScoreAdArgs): ScoreBreakdown {
  const { facts, ruleset, directions, title, source, receivedAt, now, calibration } = args;

  const rm = ruleMargin(facts, ruleset);
  const df = directionFit(title, directions);
  const sc = signalCompleteness(facts, ruleset);
  const fr = freshness(receivedAt, now, calibration.freshnessDecayDays, calibration.freshnessFloor);
  const sq = sourceQuality(source, calibration);

  const w = calibration.weights;
  const total = Math.round(
    100 * (w.ruleMargin * rm + w.directionFit * df + w.signalCompleteness * sc + w.freshness * fr + w.sourceQuality * sq),
  );

  return {
    ruleMargin: rm,
    directionFit: df,
    signalCompleteness: sc,
    freshness: fr,
    sourceQuality: sq,
    total,
  };
}

// ── Tier selection ───────────────────────────────────────────────────────────

/**
 * One scored ad — the minimum shape the selection algorithm consults.
 * The caller keeps whatever wider ad type it uses and passes a projection.
 */
export interface ScoredAd {
  id: string;
  score: ScoreBreakdown;
  verdicts: readonly Verdict[];
  /** For diversity cap and honesty ("still open"). Null companies are all distinct. */
  company: string | null;
  /** For per-platform diversity cap. */
  source: string;
  /**
   * Which directions this ad matched (by id, for the per-direction cap).
   * Empty is fine — the cap only fires when the same non-empty direction
   * dominates.
   */
  matchedDirectionIds: readonly string[];
  /** True when a preference-severity rule ended in `warn`. Gates Stretch. */
  hasPreferenceWarn: boolean;
  /**
   * True when the ad was first seen in an earlier week. Repeats are kept out
   * of the curated tiers (Top / Read / Stretch) — the weekly digest answers
   * "what's new this week", not "what's still around". A repeat that scores
   * high enough surfaces separately in `stillOpen` instead. Optional so
   * existing test fixtures and callers pre-dating this field still compile
   * (default: false — treated as a new ad).
   */
  repeat?: boolean;
}

export interface Tiered<T extends ScoredAd> {
  topPicks: T[];
  worthAReading: T[];
  stretch: T[];
  /**
   * Repeat ads that scored above the worth-a-read threshold, ordered by score
   * desc, capped by `STILL_OPEN_CAP`. Repeats that don't fit here fall into
   * `explore` alongside the low-scoring new ads.
   */
  stillOpen: T[];
  explore: T[];
}

/**
 * Repeat-suppression history: a lookup of ad ids that were in Top pick the
 * previous week and are therefore ineligible for Top pick this week (I25).
 */
export type TopPickHistory = ReadonlySet<string>;

interface DiversityCaps {
  maxPerCompany: number;
  maxPerPlatform: number;
  maxPerDirection: number;
}

const TIER_CAPS = { topPicks: 2, worthAReading: 6, stretch: 2 } as const;

/**
 * Maximum ads shown under "Still open from earlier weeks". Kept below the
 * curated total (10) so a stale corpus of week-old repeats doesn't dominate
 * the page. Excess repeats fall through to explore.
 */
export const STILL_OPEN_CAP = 6;

const DIVERSITY: DiversityCaps = {
  maxPerCompany: 2,
  maxPerPlatform: 5,
  maxPerDirection: 6,
};

const TOP_PICK_COMPANY_CAP = 1;

/**
 * Sort key: score desc, then id asc for stability (same score, same order
 * every call — matters for test determinism and for the "why did today's
 * ranking differ?" debug question when the score is identical).
 */
function byScoreDesc<T extends ScoredAd>(a: T, b: T): number {
  if (a.score.total !== b.score.total) return b.score.total - a.score.total;
  return a.id.localeCompare(b.id);
}

/**
 * Greedy pick with caps. Walks the candidates in the given order; each ad
 * that would not exceed a cap is taken and its counters incremented. An ad
 * that would exceed a cap is skipped, not moved — it stays in the pool for
 * the next tier (or for Explore).
 *
 * Returns the picks and the pool of ads that were not picked (either
 * skipped by a cap, or ran out of slots).
 */
function pickWithCaps<T extends ScoredAd>(
  candidates: readonly T[],
  slots: number,
  caps: DiversityCaps,
  state: {
    perCompany: Map<string, number>;
    perPlatform: Map<string, number>;
    perDirection: Map<string, number>;
  },
): { picks: T[]; rest: T[] } {
  const picks: T[] = [];
  const rest: T[] = [];
  for (const ad of candidates) {
    if (picks.length >= slots) {
      rest.push(ad);
      continue;
    }
    const companyKey = ad.company ?? `__null:${ad.id}`;
    if ((state.perCompany.get(companyKey) ?? 0) >= caps.maxPerCompany) {
      rest.push(ad);
      continue;
    }
    if ((state.perPlatform.get(ad.source) ?? 0) >= caps.maxPerPlatform) {
      rest.push(ad);
      continue;
    }
    const dirOverflow = ad.matchedDirectionIds.some(
      (d) => (state.perDirection.get(d) ?? 0) >= caps.maxPerDirection,
    );
    if (dirOverflow) {
      rest.push(ad);
      continue;
    }
    picks.push(ad);
    state.perCompany.set(companyKey, (state.perCompany.get(companyKey) ?? 0) + 1);
    state.perPlatform.set(ad.source, (state.perPlatform.get(ad.source) ?? 0) + 1);
    for (const d of ad.matchedDirectionIds) {
      state.perDirection.set(d, (state.perDirection.get(d) ?? 0) + 1);
    }
  }
  return { picks, rest };
}

/**
 * Rank-order into the three tiers, respecting eligibility gates and
 * diversity caps. Pure — the same inputs produce the same tiering.
 *
 * Selection order matters: Top picks first (they get the pick of the litter,
 * with the tighter per-company cap of 1), then Worth-a-read from what's
 * left, then Stretch from what's left after that. An ad qualified for both
 * Top and Read lands in Top because Top is picked first.
 *
 * Ads culled by diversity or that fall below every threshold land in
 * `explore` (I24 — culled by diversity does not become a lower tier).
 *
 * Empty slots are legitimate output (ADR-003 §2.3): the caller renders the
 * tier as "no strong pick this week" rather than padding.
 */
export function selectTiers<T extends ScoredAd>(
  scored: readonly T[],
  history: TopPickHistory,
  calibration: Calibration,
): Tiered<T> {
  const state = {
    perCompany: new Map<string, number>(),
    perPlatform: new Map<string, number>(),
    perDirection: new Map<string, number>(),
  };

  const sorted = [...scored].sort(byScoreDesc);

  // Repeats (first seen in an earlier week) never compete for the curated
  // tiers — they can only land in `stillOpen` or `explore`. This is I25
  // extended: the previous rule blocked Top-pick re-promotion; the weekly-
  // digest promise ("what's new this week") makes the same split honest for
  // Read and Stretch too.
  const newSorted = sorted.filter((a) => !a.repeat);
  const repeatSorted = sorted.filter((a) => a.repeat === true);

  // Top-pick candidates: score >= threshold, certain (I23), not repeated (I25).
  const topEligible = newSorted.filter(
    (ad) =>
      ad.score.total >= calibration.tierThresholds.topPick &&
      isCertain(ad.verdicts) &&
      !history.has(ad.id),
  );
  const topPicked = pickWithCaps(topEligible, TIER_CAPS.topPicks, {
    ...DIVERSITY,
    maxPerCompany: TOP_PICK_COMPANY_CAP,
  }, state);

  const takenIds = new Set(topPicked.picks.map((a) => a.id));
  const remainder = newSorted.filter((a) => !takenIds.has(a.id));

  // Worth-a-read: score >= threshold. Uses the full diversity caps.
  const readEligible = remainder.filter(
    (ad) => ad.score.total >= calibration.tierThresholds.worthAReading,
  );
  const readPicked = pickWithCaps(readEligible, TIER_CAPS.worthAReading, DIVERSITY, state);
  readPicked.picks.forEach((a) => takenIds.add(a.id));

  const remainderAfterRead = remainder.filter((a) => !takenIds.has(a.id));

  // Stretch: directionFit is the gate, not total. A high-direction ad with a
  // failed preference is exactly the "high match, one gap" case (§2.3).
  const stretchEligible = remainderAfterRead.filter(
    (ad) =>
      ad.hasPreferenceWarn &&
      ad.score.directionFit * 100 >= calibration.tierThresholds.stretch,
  );
  const stretchPicked = pickWithCaps(stretchEligible, TIER_CAPS.stretch, DIVERSITY, state);
  stretchPicked.picks.forEach((a) => takenIds.add(a.id));

  // Still-open: repeats scoring above worth-a-read, capped. No diversity gate
  // — this section is small enough that a company/platform cap would leave it
  // half-empty for no gain.
  const stillOpen = repeatSorted
    .filter((a) => a.score.total >= calibration.tierThresholds.worthAReading)
    .slice(0, STILL_OPEN_CAP);
  const stillOpenIds = new Set(stillOpen.map((a) => a.id));

  // Explore = every ad that didn't land in a tier or in stillOpen — new ads
  // below the thresholds, and repeats that didn't fit under the cap.
  const explore = sorted.filter((a) => !takenIds.has(a.id) && !stillOpenIds.has(a.id));

  return {
    topPicks: topPicked.picks,
    worthAReading: readPicked.picks,
    stretch: stretchPicked.picks,
    stillOpen,
    explore,
  };
}
