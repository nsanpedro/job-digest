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
  DEFAULT_CALIBRATION,
  ROLE_SYNONYMS,
  directionFit,
  freshness,
  isCertain,
  ruleMargin,
  scoreAd,
  selectTiers,
  signalCompleteness,
  sourceQuality,
  type Calibration,
  type ScoreAdArgs,
  type ScoreBreakdown,
  type ScoredAd,
  type ScoringDirection,
  type Tiered,
  type TopPickHistory,
} from './scoring';
export {
  CURATION_THRESHOLDS,
  DESCRIPTION_MATCH_CHARS,
  directionFitStrength,
  inferMode,
  type CurationDirection,
  type CurationMode,
} from './curation';
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
