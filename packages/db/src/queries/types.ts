/**
 * The digest read model — what the dashboard renders (design, screens 1 & 2).
 *
 * Verdicts are carried here, never stored (I6): they are computed from the
 * ad's facts and the active ruleset at read time. `wording` rides alongside so
 * the UI can show the ad's literal German next to each verdict — facts feed
 * evaluation, wording feeds the UI (§9).
 */
import type { Distance, TitleFacts, Verdict, Wording } from '@job-digest/core';

export type Platform = 'LinkedIn' | 'Xing' | 'Indeed' | 'StepStone';

export interface DigestAd {
  id: string;
  title: string;
  company: string | null;
  location: string | null;
  source: Platform;
  externalUrl: string | null;
  /** Null until the scoring weights are decided (§13.1) — never a fake number. */
  score: number | null;
  seen: boolean;
  saved: boolean;
  incomplete: boolean;
  incompleteNote: string | null;
  /**
   * The subject line of the most recent sighting's email — not the name of a
   * saved search. Checked live (3 Aug 2026): no platform's alert email
   * exposes which configured search triggered it, so this column has held
   * the raw subject since the field was added; the name survives from before
   * that was known. Do not read it as "which alert produced this ad".
   */
  alert: string | null;
  receivedAt: Date;
  firstSeenAt: Date;
  /** True when the ad first arrived before this window. */
  repeat: boolean;
  verdicts: Verdict[];
  wording: Partial<Wording>;
  /**
   * Facts read from the title and location line — seniority, discipline,
   * stack, workplace. Null on ads ingested before this column existed and not
   * yet backfilled (`packages/worker/scripts/backfill-title-facts.ts`); the
   * card renders as if every field were empty in that case, which is correct
   * — it genuinely has not been computed yet.
   */
  titleFacts: TitleFacts | null;
  /** Generated prose (§6.8); null until narration runs. */
  fit: string | null;
  gap: string | null;
  /**
   * Latest application status the user recorded for this ad, or null if they
   * never did (I15 — asserted, never detected). A fourth axis alongside
   * saved/seen/dismissed, orthogonal to all of them per I10: applying to an ad
   * says nothing about whether a rule passed it.
   */
  applicationStatus: ApplicationStatus | null;
  /**
   * This ad's platform's known field coverage (design §9), keyed by lowercase
   * RuleKey ("pay", "german", …). `false` means the platform is on record as
   * never sending that field — RuleLane renders that distinctly from a plain
   * "not read". A missing key means no evidence either way, and stays "not
   * read"; see migration 0007.
   */
  platformFields: Record<string, boolean>;
}

/**
 * Why an ad is not in the main list. Kept as a discriminated union because
 * I10 makes these different in kind: one is user data, the other is derived
 * from the ruleset, and an override is a third thing again.
 */
export type DismissalReason =
  | { kind: 'user' }
  | { kind: 'rule'; blockers: Verdict[] };

export interface DismissedAd extends DigestAd {
  reason: DismissalReason;
}

/**
 * The three header metrics. Each number carries the context line that makes
 * it honest; a count we cannot compute yet is null, not a guess.
 */
export interface DigestMetrics {
  adsReceived: number;
  /**
   * Ads outside the profile's target fields or city. Null until profile
   * targeting exists (design screen 3) — the prototype's "49 off-target"
   * cannot be computed without it, and inventing it would misreport how
   * much the filter is doing.
   */
  offTarget: number | null;
  passing: number;
  filteredByRule: number;
  dismissedByUser: number;
  alreadySeen: number;
}

/** Feeds the footer banner: what was not fully read, and what it cost. */
export interface ParseSummary {
  emailsRead: number;
  emailsNotFullyRead: number;
  /** Declared minus extracted, summed — ads that exist but were never read (I3). */
  adsUnaccountedFor: number;
  /** True when at least one email hit a layout we have no extractor for. */
  hasUnknownLayout: boolean;
  platforms: Platform[];
  lastRunAt: Date | null;
  lastRunFailed: boolean;
}

export interface Digest {
  window: { start: Date; end: Date };
  metrics: DigestMetrics;
  visible: DigestAd[];
  dismissed: DismissedAd[];
  parse: ParseSummary;
  rulesetVersion: number;
}

/**
 * The user's record of a search (design §9, I15/I16). Every value here was
 * asserted by the user — nothing about an application is detected, because
 * I14 means the mail that would reveal it is never fetched.
 */
export type ApplicationStatus = 'applied' | 'interviewing' | 'offer' | 'rejected' | 'withdrawn';

export interface ApplicationEvent {
  id: string;
  status: ApplicationStatus;
  at: Date;
  note: string | null;
}

export interface TrackedApplication extends DigestAd {
  /** Derived from the latest event, never stored. */
  status: ApplicationStatus;
  /** Newest first. The timeline is the artifact worth keeping. */
  events: ApplicationEvent[];
  firstAppliedAt: Date;
  lastEventAt: Date;
  daysSinceLastEvent: number;
  /**
   * Whether the status still moves. `offer`, `rejected` and `withdrawn` stop
   * the follow-up clock — they end the waiting, which is what the nudge is
   * about.
   */
  open: boolean;
  /**
   * Long enough since the last event to be worth a nudge. The copy states the
   * elapsed time and lets the user decide; it never claims the employer did or
   * did not do anything, because the system cannot know that (I15).
   */
  needsFollowUp: boolean;
}

export interface ApplicationCounts {
  total: number;
  open: number;
  needingFollowUp: number;
}

/** One card on "Emails we couldn't read" (design, screen 2). */
export interface UnreadEmail {
  id: string;
  rawEmailId: string;
  source: Platform | null;
  subject: string;
  receivedAt: Date;
  outcome: 'partial' | 'none' | 'not_an_alert' | 'unknown_layout';
  causeCode: string | null;
  declaredCount: number | null;
  extractedCount: number;
  /** "3 of 7 ads read" — assembled from the counts, never free text. */
  status: string;
  fields: Array<{ name: string; ok: boolean; value: string }>;
  /** True when at least one ad from this email reached the digest. */
  inDigest: boolean;
}

/**
 * Role discovery from a CV (docs/adr-001-role-discovery.md §3). Polled the
 * same way `getRunProgress` polls `runs` — status resolves from 'running' to
 * 'ok' or 'error', at which point the caller reads `getActiveProfile` /
 * `listDirections` for the result.
 */
export interface DerivationProgress {
  status: 'running' | 'ok' | 'error';
  errorKind: string | null;
  errorMessage: string | null;
}

/** One direction card — everything it renders, read from `directions` alone (no join back to `profiles.data`). */
export interface DirectionRow {
  id: string;
  profileVersion: number;
  label: string;
  rationale: string;
  /** Skill `text` labels this direction bridges from — the premises (I17). */
  bridge: string[];
  searchTerms: string[];
  distance: Distance;
  /** Snapshot at derivation time; not re-checked live. */
  seenTitles: string[];
  state: 'suggested' | 'interested' | 'dismissed' | 'alert_configured';
}
