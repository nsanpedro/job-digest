/**
 * Curated-digest scoring (ADR-003).
 *
 * A pure function of (facts, verdicts, ruleset, directions, candidate, title,
 * source, receivedAt, now, calibration) → a seven-component ScoreBreakdown. Same
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
import { EMPTY_CANDIDATE, type CandidateProfile } from './candidate';
import { computeMatch, DISTANCE_FACTOR, ROLE_SYNONYMS as MATCHING_ROLE_SYNONYMS } from './matching';
import { locationFit } from './location';
import { readSeniority, readStack } from './title-lexicon';
import type { Seniority } from './title-facts';

/**
 * Re-exported from `matching.ts` — kept at the old import path so callers
 * outside this package (currently `packages/db/src/queries/digest.ts` via
 * the barrel `@job-digest/core`) don't need to know the constant moved.
 * The one source of truth is in `matching.ts`.
 */
export const ROLE_SYNONYMS = MATCHING_ROLE_SYNONYMS;

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
  /**
   * How the rung the title states compares to the rungs the user targets.
   * Null when either side is silent — no signal, and its weight is
   * redistributed rather than scored as a guess (see `effectiveWeights`).
   */
  seniorityFit: number | null;
  /**
   * Share of the technologies the title names that the user's own text
   * names too. Null when the title names none or the user named none.
   */
  stackFit: number | null;
  /**
   * How close the ad's location is to the user's home city (city / remote
   * = 1.0, same country 0.6, Europe 0.3, elsewhere 0.1). Null when the
   * location can't be placed or the user set no city.
   */
  locationFit: number | null;
  /** round(100 × Σ (weight × component)) over the components with signal. */
  total: number;
  /**
   * The weights this total was computed with — the calibration's, after
   * missing signals handed theirs back (`effectiveWeights`). Carried so the
   * breakdown table's rows add up to `total` without re-deriving which
   * signals were missing.
   */
  weights: Calibration['weights'];
}

/** Keys of `Calibration['weights']` — one per score component. */
export type WeightKey = keyof Calibration['weights'];

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
    seniorityFit: number;
    stackFit: number;
    locationFit: number;
  };
  /** Minimum total score for an ad to be a match (selectMatches). */
  matchThreshold: number;
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
export const CALIBRATION_V2: Calibration = {
  version: 2,
  weights: {
    ruleMargin: 0.25,
    directionFit: 0.35,
    signalCompleteness: 0.1,
    freshness: 0.2,
    sourceQuality: 0.1,
    // v2 predates these components; zero weight reproduces v2 exactly.
    seniorityFit: 0,
    stackFit: 0,
    locationFit: 0,
  },
  matchThreshold: 50,
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

/**
 * Weights the v3 components take off the top. The v2 five are scaled by
 * `1 - Σ V3_ADDED` so the sum stays 1.0.
 *
 * Seniority carries twice stack's weight: 39% of titles state a rung and the
 * mismatch it catches ("Junior" shown to a senior, "Head of" to an IC) is
 * the one users name first; only 18% of titles name a technology, and an
 * ad's stack is a softer requirement than its level.
 */
const V3_ADDED = { seniorityFit: 0.1, stackFit: 0.05 } as const;

/**
 * v3 calibration — the first two components about *who the user is*, not
 * just which words their directions contain (Sep 2026).
 *
 * v2's only intent signal was `directionFit`, a keyword ladder with a handful
 * of discrete values; every ad matching a direction's full phrase tied at
 * 1.0 and the order among them came from freshness and source. v3 adds
 * `seniorityFit` and `stackFit`, read from the title with the same lexicon
 * the card's chips use.
 *
 * Built so that an ad whose title states neither a rung nor a technology —
 * or a user whose profile names neither — scores exactly as it did under v2:
 * the v2 weights are scaled proportionally to make room, and a component
 * without signal hands its weight back the same way (`effectiveWeights`).
 * The tier thresholds therefore keep their v2 meaning, and the new
 * components only move the ads that carry the signal — up on a match, down
 * on a mismatch. Whether that moves the *right* ads is what
 * `scripts/eval-ranking.ts` answers against the user's own saves, applies
 * and dismissals.
 */
export const CALIBRATION_V3: Calibration = {
  ...CALIBRATION_V2,
  version: 3,
  weights: (() => {
    const w = CALIBRATION_V2.weights;
    const scale = 1 - V3_ADDED.seniorityFit - V3_ADDED.stackFit;
    return {
      ruleMargin: w.ruleMargin * scale,
      directionFit: w.directionFit * scale,
      signalCompleteness: w.signalCompleteness * scale,
      freshness: w.freshness * scale,
      sourceQuality: w.sourceQuality * scale,
      seniorityFit: V3_ADDED.seniorityFit,
      stackFit: V3_ADDED.stackFit,
      locationFit: 0,
    };
  })(),
};

/** Weight `locationFit` takes off the top of v3, which is scaled to make room. */
const V4_LOCATION_WEIGHT = 0.05;

/**
 * v4 calibration — location stops being a pre-filter and becomes a score
 * component (ADR-003 §8.6).
 *
 * v1–v3 dropped every ad outside the user's city (unless remote) into
 * Explore before scoring. On the first real account that gate hid 6 of the
 * 9 ads the user had applied to; replaying the same weeks without it
 * tripled recall@10. `locationFit` keeps the preference — the home city and
 * acceptable remote rank first — without deciding for the user that Köln or
 * Zurich are out of the question.
 *
 * Same construction as v3: the v3 weights are scaled by `1 - 0.05`, and an
 * ad whose location can't be placed (or a user with no city) scores exactly
 * as under v3.
 *
 * The weight is a tiebreak on purpose. Swept on that account with
 * `scripts/eval-ranking.ts` (0 / 0.05 / 0.10 / 0.15 / 0.20), every step up
 * cost ranking quality — pairwise 0.795 → 0.762 → 0.743 → 0.738 → 0.733 —
 * because the user applies well beyond their stated city. 0.05 keeps the
 * stated preference as a tiebreak between equal role matches (a user whose
 * city genuinely matters still sees it first) at a small cost on the one
 * account we can measure; 0 would make the Location setting decorative.
 */
export const CALIBRATION_V4: Calibration = {
  ...CALIBRATION_V3,
  version: 4,
  weights: (() => {
    const w = CALIBRATION_V3.weights;
    const scale = 1 - V4_LOCATION_WEIGHT;
    return {
      ruleMargin: w.ruleMargin * scale,
      directionFit: w.directionFit * scale,
      signalCompleteness: w.signalCompleteness * scale,
      freshness: w.freshness * scale,
      sourceQuality: w.sourceQuality * scale,
      seniorityFit: w.seniorityFit * scale,
      stackFit: w.stackFit * scale,
      locationFit: V4_LOCATION_WEIGHT,
    };
  })(),
};

/** The calibration the digest runs under. */
export const DEFAULT_CALIBRATION: Calibration = CALIBRATION_V4;

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

/**
 * Best `computeMatch(title, description).tier × DISTANCE_FACTOR[distance]`
 * across the user's directions.
 *
 * The match ladder itself (full-phrase / long-word tiers, role-suffix
 * blocklist, synonyms) lives in `matching.ts` and is shared with the
 * ingest gate and the digest read gate. `description` is the ad's stored
 * `ads.description` (ADR-003 §8.10 "Descriptions in matching"); omitted or
 * null, this is the title-only function it always was — same number for
 * every ad without one.
 *
 * When the user has no interested directions we return 0 — nothing to
 * measure. The old contract returned 1.0 ("no signal, no penalty") but
 * that quietly added `1.0 × weight.directionFit` (35 pts) to every ad,
 * so a fresh LinkedIn alert with empty facts cleared the topPick
 * threshold on freshness alone — a phantom recommendation from a signal
 * the user never gave. `scoreAd` compensates by redistributing the
 * directionFit weight across the other components via `effectiveWeights`
 * — the unconfigured user is not silently penalised, but neither is she
 * shown top-picks that stand on nothing.
 */
export function directionFit(
  title: string,
  directions: readonly ScoringDirection[],
  description: string | null = null,
): number {
  if (directions.length === 0) return 0;
  let best = 0;
  for (const dir of directions) {
    const { tier } = computeMatch(title, description, dir.searchTerms);
    const scaled = tier * DISTANCE_FACTOR[dir.distance];
    if (scaled > best) {
      best = scaled;
      if (best >= 1.0) break; // ceiling — no other direction can beat this.
    }
  }
  return best;
}

/**
 * The weights `scoreAd` actually uses for a given ad, after accounting for
 * signals that are absent — either never given by the user (no directions,
 * a profile that names no rung) or not stated by the ad (a title with no
 * seniority marker).
 *
 * Every component in `missing` is set to 0 and the remaining weights are
 * scaled by `1 / Σ remaining`, so the sum stays 1.0 and the ad is scored on
 * what we DO know, over the same [0, 100] range. A component whose base
 * weight is 0 receives no boost.
 *
 * Proportional on purpose: redistributing a missing component's share this
 * way leaves the *relative* weights of the rest untouched, which is what
 * makes v3 reduce to v2 exactly when both v3 components are missing.
 *
 * Why not score a missing signal as a constant (the rule engine's neutral
 * 0.5 for `unknown`, ADR-003 §2.6)? For `directionFit` a constant adds
 * phantom points to every ad — the old contract scored "no directions" as
 * 1.0 and a fresh LinkedIn alert with empty facts cleared topPick on
 * freshness alone. For seniority and stack a constant would shift every
 * silent title's score relative to v2 and move the tier thresholds with it.
 *
 * If nothing with weight remains (degenerate calibrations), returns the base
 * unchanged rather than dividing by zero or fabricating weights.
 */
export function effectiveWeights(
  base: Calibration['weights'],
  missing: readonly WeightKey[],
): Calibration['weights'] {
  // Dropping a component that already weighs nothing is a no-op, not a
  // renormalisation — a hand-written calibration keeps its exact weights.
  const dropped = missing.filter((k) => base[k] > 0);
  if (dropped.length === 0) return base;
  const w = { ...base };
  for (const k of dropped) w[k] = 0;
  const remaining = Object.values(w).reduce((a, b) => a + b, 0);
  if (remaining <= 0) return base;
  const scale = 1 / remaining;
  for (const k of Object.keys(w) as WeightKey[]) w[k] *= scale;
  return w;
}

// ── Seniority fit ────────────────────────────────────────────────────────────

/**
 * Ladder position per rung. `principal` (IC track) and `head` (management
 * track) share a rank: equally far from a senior IC, but not the same job —
 * `seniorityFit` scores them as one step apart, not as a match.
 */
const SENIORITY_RANK: Readonly<Record<Seniority, number>> = {
  junior: 0,
  senior: 2,
  lead: 3,
  principal: 4,
  head: 4,
};

/**
 * Best fit of the ad's stated rung against any rung the user targets:
 *
 *   1.0 — the same rung
 *   0.6 — one step up, or a same-rank sibling (principal ↔ head): a
 *         reachable stretch
 *   0.4 — one step down: doable, but a step back
 *   0.0 — two or more steps either way ("Junior" for a senior, "Head of"
 *         for a senior IC)
 *
 * Asymmetric because a one-rung stretch is a normal next move and a
 * one-rung step back mostly is not. Null when either side names no rung.
 */
export function seniorityFit(
  adSeniority: Seniority | null,
  targets: readonly Seniority[],
): number | null {
  if (adSeniority === null || targets.length === 0) return null;
  let best = 0;
  for (const t of targets) {
    if (t === adSeniority) return 1;
    const diff = SENIORITY_RANK[adSeniority] - SENIORITY_RANK[t];
    const fit = diff === 0 || diff === 1 ? 0.6 : diff === -1 ? 0.4 : 0;
    if (fit > best) best = fit;
  }
  return best;
}

// ── Stack fit ────────────────────────────────────────────────────────────────

/**
 * Share of the technologies the title names that the user's own text names:
 * "React / TypeScript" against a React-only profile is 0.5. The ad's list is
 * the denominator — the question is "does the user cover what this ad asks
 * for?", not "does the ad use everything the user knows?".
 *
 * Null when the title names no technology or the profile names none.
 */
export function stackFit(adStack: readonly string[], candidateStack: readonly string[]): number | null {
  if (adStack.length === 0 || candidateStack.length === 0) return null;
  const known = new Set(candidateStack);
  return adStack.filter((t) => known.has(t)).length / adStack.length;
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

// ── Composed score ───────────────────────────────────────────────────────────

export interface ScoreAdArgs {
  facts: Facts;
  verdicts: readonly Verdict[];
  ruleset: Ruleset;
  directions: readonly ScoringDirection[];
  /** What the user's own text says about them. Omitted = no signal (v2 behaviour). */
  candidate?: CandidateProfile;
  title: string;
  /** The ad's stored description (`ads.description`). Omitted/null = title-only directionFit. */
  description?: string | null;
  /** The ad's raw location line. Omitted = no location signal. */
  locationRaw?: string | null;
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
const ROUNDING_EPSILON = 1e-9;

export function scoreAd(args: ScoreAdArgs): ScoreBreakdown {
  const { facts, ruleset, directions, title, source, receivedAt, now, calibration } = args;
  const candidate = args.candidate ?? EMPTY_CANDIDATE;

  const rm = ruleMargin(facts, ruleset);
  const df = directionFit(title, directions, args.description ?? null);
  const sc = signalCompleteness(facts, ruleset);
  const fr = freshness(receivedAt, now, calibration.freshnessDecayDays, calibration.freshnessFloor);
  const sq = sourceQuality(source, calibration);
  // Seniority and stack qualify a role match; they are not evidence of one.
  // Without a direction match, "Senior" in "Senior Consultant
  // Digitalisierung" is a rung on the wrong ladder — scoring it lifted
  // exactly those ads in the first real-account eval (Sep 2026). So the two
  // v3 components only speak when directionFit found the role.
  const qualifies = df > 0;
  const sf = qualifies ? seniorityFit(readSeniority(title), candidate.seniorities) : null;
  const kf = qualifies ? stackFit(readStack(title), candidate.stack) : null;
  // Location is about the job, not the role match — it speaks on every ad.
  const lf = locationFit(args.locationRaw ?? null, candidate.location);

  // Weights honor "signals nobody gave": with zero directions the
  // directionFit weight is redistributed (an unconfigured user isn't given
  // phantom top-picks from freshness alone), and a seniority/stack
  // comparison with a silent side hands its weight back the same way.
  const missing: WeightKey[] = [];
  if (directions.length === 0) missing.push('directionFit');
  if (sf === null) missing.push('seniorityFit');
  if (kf === null) missing.push('stackFit');
  if (lf === null) missing.push('locationFit');
  const w = effectiveWeights(calibration.weights, missing);
  // The epsilon absorbs float noise from scaling weights down and back up
  // (v4 → v3 → v2 via effectiveWeights): a true 73.5 must round the same
  // way under every calibration, not to 73 in one and 74 in the next.
  const total = Math.round(
    ROUNDING_EPSILON +
    100 *
      (w.ruleMargin * rm +
        w.directionFit * df +
        w.signalCompleteness * sc +
        w.freshness * fr +
        w.sourceQuality * sq +
        w.seniorityFit * (sf ?? 0) +
        w.stackFit * (kf ?? 0) +
        w.locationFit * (lf ?? 0)),
  );

  return {
    ruleMargin: rm,
    directionFit: df,
    signalCompleteness: sc,
    freshness: fr,
    sourceQuality: sq,
    seniorityFit: sf,
    stackFit: kf,
    locationFit: lf,
    total,
    weights: w,
  };
}

// ── Placement ────────────────────────────────────────────────────────────────

/**
 * One scored ad — all that placement consults is the id and the score.
 * The caller keeps whatever wider ad type it uses and passes a projection.
 */
export interface ScoredAd {
  id: string;
  score: ScoreBreakdown;
}

export interface Placement<T extends ScoredAd> {
  /** Every ad at or above the match threshold, best first. */
  matches: T[];
  /** Every ad below it, best first. */
  explore: T[];
}

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
 * Split the scored pool at the match threshold. Pure.
 *
 * I29 — placement is a monotone function of the displayed score: an ad with
 * a higher score is never in a lower section than an ad with a lower score.
 * That is the whole rule. There are no slot caps, no per-company /
 * per-platform / per-direction caps, no repeat split and no second metric
 * (ADR-003 §9). Every earlier version of this function put something between
 * the number on the card and the section the card landed in, and each of
 * those rules showed up as a bug report of the same shape: "this 74% is in
 * a different place than that 74%".
 *
 * The only reasons an ad is kept out of `matches` besides its score are the
 * pre-filters in getDigest (muted company, direction miss, below target
 * level), and those ads carry no score at all — they are labelled with their
 * reason, not ranked against the rest.
 */
export function selectMatches<T extends ScoredAd>(
  scored: readonly T[],
  calibration: Calibration,
): Placement<T> {
  const sorted = [...scored].sort(byScoreDesc);
  const cut = calibration.matchThreshold;
  return {
    matches: sorted.filter((a) => a.score.total >= cut),
    explore: sorted.filter((a) => a.score.total < cut),
  };
}
