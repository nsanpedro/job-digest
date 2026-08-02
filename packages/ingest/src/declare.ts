/**
 * The declared-count step (I3): pull the ad count the email announces about
 * itself, in a step independent of extracting the ads. Coverage is
 * extracted/declared — the one mechanism that turns a silent extraction
 * failure into a visible one. When no declaration is found, that absence is
 * recorded with a reason, never reported as 100% coverage.
 */
import type { Platform } from './classify';

export interface Declaration {
  count: number | null;
  /** Why count is null — stored in email_parses.declared_count_reason. */
  reason?: string;
}

/** Numeric subject patterns confirmed against the fixture corpus; extended per layout. */
const COUNT_PATTERNS: Partial<Record<Platform, RegExp[]>> = {
  // "10 neue Jobs für 'Büromanagement Hamburg'" / "3 new jobs for ..."
  LinkedIn: [/^(\d+)\s+neue\s+Jobs?\b/i, /^(\d+)\s+new\s+jobs?\b/i],
  // Unconfirmed against real traffic — the design handoff's assumed format
  // ("Ihr Job-Alarm: 4 neue Stellen in Hamburg"), never actually observed
  // (§14). The real "jobagent" subscription sends single-job nudges and an
  // uncounted multi-job digest instead — see SINGLE_JOB_PATTERNS below and
  // the fixture corpus. Left in rather than deleted: a different StepStone
  // subscription type might still send this format.
  StepStone: [/\b(\d+)\s+neue\s+Stellen\b/i],
};

/**
 * Subjects that announce exactly one headline job (observed in the fixture
 * corpus; even these emails are digests internally, headline + similar jobs).
 * The subject promises that one job, so declared = 1: extracting zero from
 * such an email is the visible failure I3 exists to catch, and extracting
 * more than declared is over-completeness, not an error.
 */
const SINGLE_JOB_PATTERNS: Partial<Record<Platform, RegExp[]>> = {
  LinkedIn: [
    // "{company} busca personal para el puesto de {title}"
    /\bbusca personal para el puesto de\b/i,
    // "{title} en {company}" — deliberately last: loose, but this sender only
    // sends job alerts, and the numeric patterns are tried first.
    /^.+\s+en\s+.+$/i,
  ],
  // The "jobagent" recommendation nudge — every real subject observed in the
  // corpus is one of these five openers, always about exactly one job (§14).
  // "New job opportunities for you" deliberately does not match any of
  // these: it is the multi-job digest, and it states no count anywhere —
  // declaredCount stays null for it, honestly (I3).
  StepStone: [
    /^You're a great fit:/i,
    /^You're a great candidate:/i,
    /^You're in demand:/i,
    /^Your skills are needed:/i,
    /^Few applicants so far\b/i,
    /^Popular job, join \d+\+? others by applying/i,
  ],
};

export function declaredCount(platform: Platform, subject: string): Declaration {
  for (const re of COUNT_PATTERNS[platform] ?? []) {
    const m = subject.match(re);
    if (m?.[1]) return { count: Number.parseInt(m[1], 10) };
  }
  for (const re of SINGLE_JOB_PATTERNS[platform] ?? []) {
    if (re.test(subject)) return { count: 1 };
  }
  return { count: null, reason: 'no count declared in subject' };
}
