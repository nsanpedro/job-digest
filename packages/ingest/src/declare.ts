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
  // "Ihr Job-Alarm: 4 neue Stellen in Hamburg"
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
