/**
 * Sender classification and the I14 allowlist.
 *
 * This constant IS the allowlist the design's privacy claim rests on: it
 * lives in code, not in a database column anyone can edit, and the IMAP
 * wrapper builds its server-side SEARCH from it — mail outside this list is
 * never requested (I14). The forwarding webhook uses the same list to decide
 * what it accepts (§4.5).
 */
export type Platform = 'LinkedIn' | 'Xing' | 'Indeed' | 'StepStone';

export const SENDER_ALLOWLIST: Record<Platform, readonly string[]> = {
  LinkedIn: ['linkedin.com'],
  Xing: ['xing.com'],
  Indeed: ['indeed.com'],
  StepStone: ['stepstone.de'],
};

/**
 * Suffix match with a label boundary. `SEARCH FROM` on the server matches
 * substrings, so "linkedin.com" would also match "linkedin.com.example.ru" —
 * this re-verification after fetch closes that hole (§4.4).
 */
export function domainMatches(domain: string, allowed: string): boolean {
  const d = domain.toLowerCase();
  return d === allowed || d.endsWith(`.${allowed}`);
}

/**
 * Classify by the sender address alone. The alert-vs-newsletter distinction
 * (the Xing profile-tips case) is a *parse* outcome, not a classify one: same
 * sender, different content, and `not_an_alert` is a successful outcome
 * recorded at parse time (§6.2).
 */
export function classify(fromAddr: string): Platform | 'not_allowlisted' {
  const at = fromAddr.lastIndexOf('@');
  if (at < 0) return 'not_allowlisted';
  const domain = fromAddr.slice(at + 1).trim().replace(/>$/, '');
  for (const [platform, domains] of Object.entries(SENDER_ALLOWLIST) as Array<
    [Platform, readonly string[]]
  >) {
    if (domains.some((allowed) => domainMatches(domain, allowed))) return platform;
  }
  return 'not_allowlisted';
}
