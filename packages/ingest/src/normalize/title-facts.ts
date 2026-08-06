/**
 * Facts recoverable from an alert email's title and location line.
 *
 * Why this module exists. Measured against the live corpus on 3 Aug 2026, the
 * five rule facts are almost never present: `rotating`, `weekend`, `german`
 * and `payFte` were null on every stored ad, `permanent` on all but two. The
 * body those facts would come from is not in the email — an alert is a
 * notification, and §12 rules out fetching the posting itself. So the card had
 * one populated chip at best and four reading "not read".
 *
 * The title and the location line, however, are present on essentially every
 * ad and carry more than the pipeline was reading. This module extracts what
 * is *stated there*, and nothing else. Measured on the same 123-ad corpus:
 * `discipline` 80%, `workplace` 29% (up from 15% when only `home` was read),
 * `seniority` 39%, `stack` 18% — average 1.67 populated facts per ad, against
 * roughly 0.6 before.
 *
 * Two rules inherited from the lexicon it sits beside:
 *
 * - **Every value carries the literal span it came from** (`matched`), so the
 *   UI can show the user the words that produced it (I5's shape — a value we
 *   cannot point at is a value we do not show).
 * - **Unmapped wording returns null, never a guess** (I4). "Associate" is
 *   deliberately absent from the seniority ladder: it reads junior at one
 *   employer and senior at the next, and a coin flip dressed as a fact is
 *   worse than an honest blank.
 *
 * Deliberately *not* an inference layer. "Senior" in a title is a fact about
 * the title; whether the job is genuinely senior is not something the email
 * can tell us, and this module does not pretend otherwise.
 *
 * Types live in `@job-digest/core` (`title-facts.ts`) — the result is stored
 * in a JSONB column and `@job-digest/db` doesn't depend on `ingest`, the same
 * reason `Ruleset` lives in `core` for `rulesets.rules`.
 */
import type { Cited, Discipline, EmploymentType, Seniority, TitleFacts, Workplace } from '@job-digest/core';

function firstMatch<T>(text: string, table: ReadonlyArray<readonly [RegExp, T]>): Cited<T> | null {
  for (const [re, value] of table) {
    const m = text.match(re);
    if (m) return { value, matched: m[0].trim() };
  }
  return null;
}

// ── Seniority ───────────────────────────────────────────────────────────────

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
 */
const SENIORITY: ReadonlyArray<readonly [RegExp, Seniority]> = [
  [/\bhead\s+of\b|\bleiter(?:in)?\b/i, 'head'],
  [/\bprincipal\b/i, 'principal'],
  [/\bstaff\b/i, 'lead'],
  [/\b(?:team\s*)?lead\b|\blead\b/i, 'lead'],
  [/\(senior\)|\bsenior\b|\bsenior-/i, 'senior'],
  [/\bjunior\b|\bwerkstudent(?:in)?\b|\bpraktik/i, 'junior'],
];

// ── Discipline ──────────────────────────────────────────────────────────────

/*
 * Management is tried first: "Engineering Manager Web-Entwicklung" is a
 * management role that happens to name a technical area, and reading it as
 * frontend would put it in the wrong pile. Fullstack precedes frontend and
 * backend for the same reason — "Full Stack Engineer" must not be split.
 */
const DISCIPLINE: ReadonlyArray<readonly [RegExp, Discipline]> = [
  [/\bengineering\s+manager\b|\bleiter(?:in)?\b|\bhead\s+of\b|\bteam\s*lead\b/i, 'management'],
  [/\bconsultant\b|\bberater(?:in)?\b/i, 'consulting'],
  [/\bfull[\s-]?stack\b|\bfullstack-/i, 'fullstack'],
  [/\bfront[\s-]?end\b|\bfrontend-|\bwebentwickler(?:in)?\b|\bwebdesigner(?:in)?\b/i, 'frontend'],
  [/\bback[\s-]?end\b|\bbackend-/i, 'backend'],
  [/\breact\s+native\b|\bios\b|\bandroid\b|\bmobile\b/i, 'mobile'],
  [/\bdata\s+(?:engineer|scientist)\b|\bmachine\s+learning\b|\bki-l[öo]sungen\b/i, 'data'],
  [/\bdevops\b|\bsre\b|\bplatform\s+engineer\b|\bcloud\b/i, 'devops'],
];

// ── Stack ───────────────────────────────────────────────────────────────────

/*
 * A closed list, on purpose. An open "capitalised word near a slash" heuristic
 * would harvest company names and marketing nouns; a closed list either
 * matches a technology we can name or stays silent.
 */
const STACK: ReadonlyArray<readonly [RegExp, string]> = [
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

// ── Workplace ───────────────────────────────────────────────────────────────

/*
 * Read from the title *and* the location line. LinkedIn puts the modality in
 * the location — "Berlín, Alemania (Híbrido)", "Amsterdam (Híbrido)",
 * "(Presencial)" — a field stored on every ad and, until now, never consulted
 * for this. Spanish and German both appear because LinkedIn localises the
 * decoration while Xing and StepStone write German.
 */
const WORKPLACE: ReadonlyArray<readonly [RegExp, Workplace]> = [
  [/\bhybrid\b|\bh[íi]brido\b|\bhybride?\b/i, 'hybrid'],
  [/\bremote\b|\bremoto\b|\bhomeoffice\b|\bhome\s?office\b|\bteletrabajo\b/i, 'remote'],
  [/\bpresencial\b|\bvor\s?ort\b|\bon-?site\b/i, 'onsite'],
];

/*
 * A percentage only counts when it sits next to a remote word: "80 % Remote"
 * is a home-office share, while a bare "80 %" in a German title is far more
 * likely to be a part-time quota, and guessing between them would invent the
 * exact kind of number §7.7 refused to invent.
 */
const REMOTE_PERCENT = /(\d{1,3})\s*%\s*(?:remote|homeoffice|home\s?office)/i;

// ── Employment type ─────────────────────────────────────────────────────────

const EMPLOYMENT: ReadonlyArray<readonly [RegExp, EmploymentType]> = [
  [/\bwerkstudent(?:in)?\b/i, 'working_student'],
  [/\bteilzeit\b|\bpart[\s-]?time\b/i, 'parttime'],
  [/\bvollzeit\b|\bfull[\s-]?time\b/i, 'fulltime'],
];

// ── German-language title ───────────────────────────────────────────────────

/*
 * Tokens that only occur in a German title. "Manager" and "Engineer" are
 * shared between both languages and are deliberately excluded — they would
 * mark half the English titles as German.
 */
const GERMAN_TITLE =
  /\bentwickler(?:in)?\b|\bsoftwareentwickler(?:in)?\b|\bwebentwickler(?:in)?\b|\bprogrammierer(?:in)?\b|\bleiter(?:in)?\b|\bmitarbeiter(?:in)?\b|\bgesucht\b|\bvollzeit\b|\bteilzeit\b|\bwerkstudent(?:in)?\b|\banwendungs|\bl[öo]sungen\b/i;

/**
 * Extract what the title and location line actually state.
 *
 * `location` is optional but worth passing whenever it exists: on LinkedIn it
 * is where the workplace modality lives, and passing only the title silently
 * loses that.
 */
export function extractTitleFacts(title: string, location?: string | null): TitleFacts {
  const combined = [title, location ?? ''].join(' ');

  // Collected with match position, then sorted by it: the STACK table's own
  // order is precedence for *matching* ("React Native" before "React"), not
  // the order technologies should render in. Without the sort, "Senior React
  // Entwickler ... React / TypeScript" — React first in the text — would
  // render as "TypeScript, React" because TypeScript's table entry comes
  // first, contradicting this field's own contract below.
  const stackMatches: Array<Cited<string> & { index: number }> = [];
  for (const [re, name] of STACK) {
    const m = title.match(re);
    // Deduplicated by name: "Senior React Entwickler – React / TypeScript"
    // names React twice and should produce one chip, not two.
    if (m && m.index !== undefined && !stackMatches.some((s) => s.value === name)) {
      stackMatches.push({ value: name, matched: m[0].trim(), index: m.index });
    }
  }
  const stack: Array<Cited<string>> = stackMatches
    .sort((a, b) => a.index - b.index)
    .map(({ value, matched }) => ({ value, matched }));

  const pct = combined.match(REMOTE_PERCENT);

  return {
    seniority: firstMatch(title, SENIORITY),
    discipline: firstMatch(title, DISCIPLINE),
    stack,
    workplace: firstMatch(combined, WORKPLACE),
    remotePercent: pct?.[1] ? { value: Number(pct[1]), matched: pct[0].trim() } : null,
    employment: firstMatch(combined, EMPLOYMENT),
    germanTitle: GERMAN_TITLE.test(title)
      ? { value: true, matched: title.match(GERMAN_TITLE)?.[0].trim() ?? '' }
      : null,
  };
}
