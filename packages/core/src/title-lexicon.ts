/**
 * The closed vocabularies for seniority and stack — the two title facts the
 * ranking layer reads (scoring.ts `seniorityFit` / `stackFit`) as well as
 * the ingest-time extractor (`@job-digest/ingest` normalize/title-facts.ts).
 *
 * Lives in `core` because scoring runs in the digest read path
 * (`@job-digest/db`), which depends on `core` but not on `ingest`. One
 * table, two readers: the chip on the card and the number in the score can
 * never disagree about what "Senior" or "React" means.
 *
 * No value imports on purpose. `@job-digest/ingest` reaches this file through
 * the `@job-digest/core/title-lexicon` subpath, and the worker's one-off
 * scripts load ingest under raw `node --experimental-strip-types`, whose
 * resolver cannot follow the barrel's extensionless re-exports (see the note
 * in worker/scripts/backfill-title-facts.ts). A type-only import is erased
 * before resolution and stays safe.
 */
import type { Seniority } from './title-facts';

/*
 * Ordered most-specific first, and the first match wins. "Team Lead" and
 * "Head of" must be tried before a bare "Lead", or "Team Lead Frontend
 * Development" reads as plain lead and "Head of Frontend" never matches at
 * all. Where a title stacks two markers ("Staff/Lead Front-end Engineer"),
 * the higher one is what the employer is advertising, which is why the table
 * runs top-down from the most senior.
 *
 * "Manager" is absent on purpose: in this corpus it marks the discipline
 * (Engineering Manager) rather than a rung, and it is handled there.
 * "Associate" is absent too: it reads junior at one employer and senior at
 * the next, and a coin flip dressed as a fact is worse than an honest blank.
 *
 * The junior row is every entry-level wording the alerts arrive in (EN / DE /
 * ES), as whole words only — still a closed list. "Intern" must not catch
 * "Internal", "International" or "Internet", and the German programme words
 * are spelled out ("Praktikum", "Praktikant:in") rather than left as a bare
 * `praktik` prefix that would also read "Praktiker" or "praktikabel".
 * Graduate / Absolvent stay out: a graduate scheme is entry-level at one
 * employer and a post-doc track at the next.
 */
export const SENIORITY_PATTERNS: ReadonlyArray<readonly [RegExp, Seniority]> = [
  [/\bhead\s+of\b|\bleiter(?:in)?\b/i, 'head'],
  [/\bprincipal\b/i, 'principal'],
  [/\bstaff\b/i, 'lead'],
  [/\b(?:team\s*)?lead\b|\blead\b/i, 'lead'],
  [/\(senior\)|\bsenior\b|\bsenior-/i, 'senior'],
  [
    new RegExp(
      [
        String.raw`\bjunior\b`,
        String.raw`\bentry[\s-]?level\b`,
        String.raw`\bintern(?:ship)?s?\b`,
        String.raw`\btrainees?\b`,
        String.raw`\bworking\s+students?\b`,
        String.raw`\bwerkstudent(?:in|en|innen)?\b`,
        String.raw`\bwerkstudierende[rn]?\b`,
        String.raw`\b(?:pflicht)?praktik(?:um|ums|ant(?:in|en|innen)?)\b`,
        String.raw`\bazubis?\b`,
        String.raw`\bausbildung\b`,
        String.raw`\bauszubildende[rn]?\b`,
        String.raw`\bbecari[oa]s?\b`,
        String.raw`\bpasant(?:e|es|[íi]a)\b`,
        String.raw`\bpr[áa]cticas\b`,
      ].join('|'),
      'i',
    ),
    'junior',
  ],
];

/*
 * A closed list, on purpose. An open "capitalised word near a slash" heuristic
 * would harvest company names and marketing nouns; a closed list either
 * matches a technology we can name or stays silent. Table order is matching
 * precedence ("React Native" before "React"), not render order.
 */
export const STACK_PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  [/\btypescript\b/i, 'TypeScript'],
  [/\bjavascript\b/i, 'JavaScript'],
  [/\breact\s+native\b/i, 'React Native'],
  [/\breact\b/i, 'React'],
  [/\bangular\b/i, 'Angular'],
  [/\bvue(?:\.js)?\b/i, 'Vue'],
  [/\bnext\.?js\b/i, 'Next.js'],
  [/\bnode(?:\.js)?\b/i, 'Node'],
  [/\btanstack\b/i, 'TanStack'],
  [/\bjava\s*\d{1,2}\b|\bjava\b(?!script)/i, 'Java'],
  [/\bkotlin\b/i, 'Kotlin'],
  [/\bswift\b/i, 'Swift'],
  [/\bpython\b/i, 'Python'],
  [/\bgolang\b|\bgo\b(?=\s|$|\/)/i, 'Go'],
  [/\bphp\b/i, 'PHP'],
  [/\.net\b|\bc#/i, '.NET'],
  [/\bsap\b/i, 'SAP'],
  [/\bcoremedia\b/i, 'CoreMedia'],
  [/\bgoogle\s+cloud\b/i, 'Google Cloud'],
  [/\baws\b/i, 'AWS'],
];

/** First seniority marker in `text`, most senior first; null when none is stated. */
export function readSeniority(text: string): Seniority | null {
  for (const [re, value] of SENIORITY_PATTERNS) {
    if (re.test(text)) return value;
  }
  return null;
}

/** Every named technology in `text`, deduplicated, in table order. */
export function readStack(text: string): string[] {
  const out: string[] = [];
  for (const [re, name] of STACK_PATTERNS) {
    if (re.test(text) && !out.includes(name)) out.push(name);
  }
  return out;
}
