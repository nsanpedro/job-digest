export * from './types';
export { provenanceFromFacts, mergeEnrichedFacts } from './provenance';
export * from './title-facts';
export { normalizeWhitespace, verifyQuote } from './verify-quote';
export {
  DERIVATION_SCHEMA,
  MAX_DIRECTIONS,
  MIN_BRIDGE_SKILLS,
  parseDerivation,
  type Derivation,
  type Direction,
  type Distance,
  type DroppedItem,
  type ParsedDerivation,
  type Skill,
} from './discovery';
export { eur, describeCondition, describePredicate, predicateFactName } from './describe';
export { evaluate, evaluateRule, evalPredicate, worstState, blockers, isBlocked } from './evaluate';
export {
  CALIBRATION_V2,
  CALIBRATION_V3,
  CALIBRATION_V4,
  CALIBRATION_V5,
  DEFAULT_CALIBRATION,
  ROLE_SYNONYMS,
  directionFit,
  effectiveWeights,
  freshness,
  isCertain,
  ruleMargin,
  scoreAd,
  selectTiers,
  seniorityFit,
  signalCompleteness,
  sourceQuality,
  stackFit,
  type Calibration,
  type ScoreAdArgs,
  type ScoreBreakdown,
  type ScoredAd,
  type ScoringDirection,
  type Tiered,
  type TopPickCertainty,
  type TopPickHistory,
  type WeightKey,
} from './scoring';
export {
  EMPTY_CANDIDATE,
  JUNIOR_MAX_YEARS,
  SENIOR_MIN_YEARS,
  deriveCandidateProfile,
  isBelowTargetLevel,
  statedYears,
  targetsSeniorOnly,
  type CandidateDirection,
  type CandidateProfile,
} from './candidate';
export {
  countriesIn,
  homeCountry,
  isRemoteLocation,
  locationFit,
  type Region,
  type UserLocation,
} from './location';
export { SENIORITY_PATTERNS, STACK_PATTERNS, readSeniority, readStack } from './title-lexicon';
export {
  LABEL_GAIN,
  aggregateMetrics,
  isPositive,
  labelFromState,
  rankingMetrics,
  type AggregateMetrics,
  type Label,
  type RankedItem,
  type RankingMetrics,
} from './ranking-eval';
export {
  CURATION_THRESHOLDS,
  DESCRIPTION_MATCH_CHARS,
  directionFitStrength,
  inferMode,
  type CurationDirection,
  type CurationMode,
} from './curation';
export {
  DISTANCE_FACTOR,
  NON_DISCRIMINATIVE_ROLE_WORDS,
  ROLE_SPELLING_PATTERNS,
  computeMatch,
  containsWord,
  normalizeRoleSpelling,
  tokenize,
  type MatchResult,
  type MatchSurface,
  type MatchTier,
} from './matching';
export {
  describeMatch,
  explainMatch,
  isDirectionHit,
  type ExplainableDirection,
  type MatchExplanation,
} from './explain-match';
export { DEFAULT_RULESET, rulesetForCategory, type OnboardingCategory } from './default-ruleset';
export {
  DIAGNOSTIC_MIN_CURATED,
  explainDigest,
  type BlockedAdSummary,
  type DiagnosticInput,
  type Insight,
  type InsightKind,
} from './explain-digest';
export {
  applyMode,
  isMode,
  rulesAffectedByMode,
  DEFAULT_MODE,
  MODES,
  MODE_COPY,
  type Mode,
} from './mode';

// credentials.ts is deliberately NOT re-exported here. It needs node:crypto,
// and this barrel is imported by client components (RulesEditor,
// DismissedRow, ...) that webpack bundles for the browser — pulling
// node:crypto into that graph breaks the build outright ("Unhandled
// scheme"), found live the moment a page rendering those components
// compiled. Import from '@job-digest/core/credentials' instead — that
// subpath is only ever reached from server-only code (auth.ts).
