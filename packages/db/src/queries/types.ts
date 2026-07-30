/**
 * The digest read model — what the dashboard renders (design, screens 1 & 2).
 *
 * Verdicts are carried here, never stored (I6): they are computed from the
 * ad's facts and the active ruleset at read time. `wording` rides alongside so
 * the UI can show the ad's literal German next to each verdict — facts feed
 * evaluation, wording feeds the UI (§9).
 */
import type { Verdict, Wording } from '@job-digest/core';

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
  /** Alert name and arrival of the most recent sighting in the window. */
  alert: string | null;
  receivedAt: Date;
  firstSeenAt: Date;
  /** True when the ad first arrived before this window. */
  repeat: boolean;
  verdicts: Verdict[];
  wording: Partial<Wording>;
  /** Generated prose (§6.8); null until narration runs. */
  fit: string | null;
  gap: string | null;
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
