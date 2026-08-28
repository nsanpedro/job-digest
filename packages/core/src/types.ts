/**
 * Core types for the rule engine — the contract shared by the web app and the
 * ingestion worker (design §5.1). This module is pure: no I/O, no dependencies.
 *
 * Design doc: docs/system-design.md. Invariants referenced as I4, I6, I11, I12.
 */

/** CEFR language levels, orderable: the level an ad demands vs the user's ceiling. */
export type Level = 'A2' | 'B1' | 'B2' | 'C1' | 'C2';

export const LEVELS: Record<Level, number> = { A2: 1, B1: 2, B2: 3, C1: 4, C2: 5 };

/**
 * Normalized facts extracted from one ad (design §9.1).
 *
 * Every field is nullable by design: a fact that was not read is `null`, never
 * a default (I4). Nullability is the honesty mechanism — a `null` here surfaces
 * as the `unknown` rule state, visibly, rather than as a wrong verdict.
 */
export interface Facts {
  rotating: boolean | null;
  weekend: boolean | null;
  german: Level | null;
  /** Home-office days per week. */
  home: number | null;
  /** Gross monthly pay as stated in the ad. */
  pay: number | null;
  payMax: number | null;
  /** Pay scaled to full time, when the ad is part-time. */
  payFte: number | null;
  /** e.g. "at 30h" — shown to the user, never computed from. */
  fteNote: string | null;
  permanent: boolean | null;
  /** Enriched (design §6.6), not extracted: door-to-door minutes. Has no quote. */
  commuteMin: number | null;
}

/** The five rules, always evaluated and rendered in this order. */
export const RULE_KEYS = ['Shift', 'German', 'Onsite', 'Pay', 'Contract'] as const;
export type RuleKey = (typeof RULE_KEYS)[number];

/**
 * Per-rule provenance: where the fact that fed this rule came from.
 * `not_checked` = email had nothing, enrichment not yet attempted (lazy-on-view Tier 2).
 * `unknown_after_fetch` = we checked the ad; field genuinely absent.
 */
export type FieldProvenance =
  | 'from_email'
  | 'from_ad'
  | 'unknown_after_fetch'
  | 'fetch_failed'
  | 'not_checked';

/** Stored on `ads.field_provenance`; partial because API-sourced ads skip email keys. */
export type AdFieldProvenance = Partial<Record<RuleKey, FieldProvenance>>;

export type RuleState = 'pass' | 'warn' | 'block' | 'unknown';
export type Severity = 'hard' | 'preference';

/*
 * Conditions are a closed, typed union per rule key — deliberately not a
 * general expression language (design §7.2). Every rule must render as one
 * sentence of English, and an open DSL is a project of its own.
 */
export interface ShiftCondition {
  noRotating: boolean;
  noWeekend: boolean;
}
export interface GermanCondition {
  /** Highest level an ad may demand. */
  maxDemanded: Level;
}
export interface OnsiteCondition {
  /** Minimum home-office days per week; 0 means no constraint. */
  minHomeDays: number;
}
export interface PayCondition {
  /** Gross monthly floor in EUR. */
  minMonthly: number;
  /** Compare part-time ads scaled to full time, or as stated. */
  basis: 'fte' | 'actual';
}
export interface ContractCondition {
  permanentOnly: boolean;
}

export interface ConditionByKey {
  Shift: ShiftCondition;
  German: GermanCondition;
  Onsite: OnsiteCondition;
  Pay: PayCondition;
  Contract: ContractCondition;
}

/**
 * Predicates for exceptions, over Facts including enriched ones. Closed union,
 * same reasoning as conditions: each must render as a short English phrase.
 */
export type Predicate =
  | { kind: 'homeAtLeast'; days: number }
  | { kind: 'payAtLeast'; amount: number }
  | { kind: 'commuteUnder'; minutes: number };

/**
 * At most one exception per rule (design §7.2) — the second exception is where
 * a rule stops being explainable, and explainability is the product.
 *
 * `waive`: the rule does not apply at all when the predicate holds.
 * `relax`: a softer condition applies instead. The discriminated union makes
 * the relaxed condition required exactly when the mode demands one.
 */
export type RuleException<C> =
  | { mode: 'waive'; when: Predicate }
  | { mode: 'relax'; when: Predicate; condition: C };

export interface Rule<K extends RuleKey = RuleKey> {
  key: K;
  severity: Severity;
  condition: ConditionByKey[K];
  exception?: RuleException<ConditionByKey[K]>;
}

/**
 * A ruleset always carries exactly one rule per key — a mapped type makes a
 * missing or duplicated rule unrepresentable rather than a runtime check.
 */
export type Ruleset = { [K in RuleKey]: Rule<K> };

/**
 * The ad's own wording per rule — the presentation side of the facts/wording
 * split (design §9). `quote` is the I5-verified literal German text, or '—'
 * when the field could not be read. Facts feed evaluation; this feeds the UI.
 */
export interface WordingEntry {
  /** Short chip text: "Mo–Fr, Gleitzeit", "C1 asked", "not read". */
  value: string;
  /** Literal quote from the ad, German, verified substring of the source (I5). */
  quote: string;
  /** English gloss: why this passes / hurts / blocks. */
  note: string;
}
export type Wording = Record<RuleKey, WordingEntry>;

/**
 * One step of the reasoning that produced a verdict, ordered, rendered as
 * prose in the expanded panel (design §7.3).
 */
export type Step =
  | { kind: 'waived'; when: string }
  | { kind: 'unread'; field: string }
  | { kind: 'exception'; when: string; relaxedTo: string }
  /** I12 — the exception could not be checked, so a hard block degrades to unknown. */
  | { kind: 'undecidable'; when: string; missing: string }
  | { kind: 'compared'; fact: string; against: string; met: boolean }
  | { kind: 'severity'; severity: Severity };

/**
 * The decision plus the reasoning that produced it. Presentation fields (the
 * chip value and the I5-verified German quote) live in the ad's wording and
 * are joined at render time — facts feed evaluation, wording feeds the UI
 * (design §9), and this type belongs to the evaluation side.
 */
export interface Verdict {
  key: RuleKey;
  severity: Severity;
  state: RuleState;
  because: Step[];
}
