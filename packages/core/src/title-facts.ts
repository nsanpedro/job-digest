/**
 * The contract for facts recoverable from an alert email's title and location
 * line (design §6.5's sibling: same "closed vocabulary, cite the source"
 * discipline, applied to the one field present on nearly every ad).
 *
 * Types only — the extraction logic lives in `@job-digest/ingest`
 * (`normalize/title-facts.ts`), which is where every other regex-driven
 * extractor already lives. This file exists in `core` because the result is
 * stored in a JSONB column (`ads.title_facts`), and `@job-digest/db` depends
 * on `core` but not on `ingest` — the same reason `Ruleset` lives here for
 * `rulesets.rules`.
 */

export type Seniority = 'junior' | 'senior' | 'lead' | 'principal' | 'head';
export type Discipline =
  | 'frontend'
  | 'backend'
  | 'fullstack'
  | 'mobile'
  | 'data'
  | 'devops'
  | 'management'
  | 'consulting';
export type Workplace = 'remote' | 'hybrid' | 'onsite';
export type EmploymentType = 'fulltime' | 'parttime' | 'working_student';

/** A value plus the literal source span that produced it (I5's shape, applied to the title). */
export interface Cited<T> {
  value: T;
  matched: string;
}

export interface TitleFacts {
  seniority: Cited<Seniority> | null;
  discipline: Cited<Discipline> | null;
  /** Named technologies, in the order they appear. Empty when none are named. */
  stack: Array<Cited<string>>;
  workplace: Cited<Workplace> | null;
  /** Home-office share when the ad states a percentage ("80 % Remote"). */
  remotePercent: Cited<number> | null;
  employment: Cited<EmploymentType> | null;
  /** Whether the title is written in German — a fact about the text, not about the job. */
  germanTitle: Cited<true> | null;
}
