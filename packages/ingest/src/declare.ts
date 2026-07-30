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

/** Subject patterns confirmed against the fixture corpus; extended per layout. */
const SUBJECT_PATTERNS: Partial<Record<Platform, RegExp[]>> = {
  // "10 neue Jobs für 'Büromanagement Hamburg'" / "3 new jobs for ..."
  LinkedIn: [/^(\d+)\s+neue\s+Jobs?\b/i, /^(\d+)\s+new\s+jobs?\b/i],
  // "Ihr Job-Alarm: 4 neue Stellen in Hamburg"
  StepStone: [/\b(\d+)\s+neue\s+Stellen\b/i],
};

export function declaredCount(platform: Platform, subject: string): Declaration {
  const patterns = SUBJECT_PATTERNS[platform];
  if (!patterns) {
    return { count: null, reason: `${platform} alerts carry no count in the subject` };
  }
  for (const re of patterns) {
    const m = subject.match(re);
    if (m?.[1]) return { count: Number.parseInt(m[1], 10) };
  }
  return { count: null, reason: 'no count found in subject' };
}
