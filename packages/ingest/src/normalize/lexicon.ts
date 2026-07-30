/**
 * The German ad lexicon (design §6.5): language level, shift pattern and
 * contract type. This vocabulary is closed and formulaic — that is why
 * deterministic extraction is viable at all. Entries are pinned by the design
 * fixtures (j1–j10, d1–d4); unmapped wording returns null, which surfaces as
 * `unknown` (I4), never as a guess.
 */
import type { Level } from '@job-digest/core';

// ── German level ────────────────────────────────────────────────────────────

/**
 * Precedence: an explicit CEFR token wins over qualifier words. Qualifier
 * mapping per the design fixtures: verhandlungssicher/fließend → C1,
 * muttersprachlich → C2, (sehr) gute Deutschkenntnisse → B2, and a bare
 * "Deutschkenntnisse" → B2, the baseline expectation an ad signals by
 * mentioning German at all (fixture d4).
 */
export function normalizeGerman(text: string): { level: Level; matched: string } | null {
  // In a German job ad, an unattributed qualifier ("verhandlungssicher,
  // technisches Vokabular" — fixture j9) refers to German. Only an explicit
  // mention of another language without German makes it about something else.
  const otherLanguage = /englisch|spanisch|französisch|italienisch|english|polnisch/i.test(text);
  if (!/deutsch/i.test(text) && otherLanguage) return null;

  // Prefer a CEFR token from a clause that mentions German, so
  // "Spanisch auf Muttersprachniveau, Deutsch B2" reads the right level.
  const clauses = text.split(/[,;·]/);
  const germanClauses = clauses.filter((c) => /deutsch/i.test(c));
  for (const clause of [...germanClauses, text]) {
    const m = clause.match(/\b([ABC][12])\b/i);
    if (m?.[1]) return { level: m[1].toUpperCase() as Level, matched: m[0] };
  }

  const qualifiers: Array<[RegExp, Level]> = [
    [/muttersprach/i, 'C2'],
    [/verhandlungssicher/i, 'C1'],
    [/flie[ßs]send/i, 'C1'],
    [/sehr\s+gute\s+deutsch/i, 'C1'],
    [/gute\s+deutschkenntnisse/i, 'B2'],
    [/deutschkenntnisse/i, 'B2'],
  ];
  for (const [re, level] of qualifiers) {
    const m = text.match(re);
    if (m) return { level, matched: m[0] };
  }
  return null;
}

// ── Shift pattern ───────────────────────────────────────────────────────────

/**
 * `rotating` fires only on shift-system vocabulary. "Servicezeiten im
 * Wechsel bis 18:30, Mo–Fr" (fixture j4) rotates inside weekdays — that is
 * deliberately NOT the Schichtdienst the rule is about, and "im Wechsel"
 * alone does not match. Fixed-weekday markers (Gleitzeit, Mo–Fr) assert the
 * negative; without any marker both facts stay null.
 */
const ROTATING =
  /wechselschicht|schichtdienst|schichtsystem|schichtarbeit|(?:früh|spät|nacht)dienst|3-schicht|im\s+schichtbetrieb/i;
const WEEKEND = /samstag|sonntag|wochenend/i;
const FIXED_WEEKDAYS = /gleitzeit|mo\s*[–-]\s*fr|montag\s+bis\s+freitag|werktags|kernzeit/i;

export function normalizeShift(
  text: string,
): { rotating: boolean | null; weekend: boolean | null; matched: string } | null {
  const rot = text.match(ROTATING);
  const wk = text.match(WEEKEND);
  const fixed = text.match(FIXED_WEEKDAYS);
  if (!rot && !wk && !fixed) return null;

  const rotating = rot ? true : fixed ? false : null;
  // Fixed weekdays without a weekend marker assert no weekend work.
  const weekend = wk ? true : fixed ? false : null;
  const matched = (rot ?? wk ?? fixed)?.[0] ?? '';
  return { rotating, weekend, matched };
}

// ── Contract ────────────────────────────────────────────────────────────────

/**
 * "Festanstellung" alone is deliberately null: fixture j2's ad never says
 * befristet or unbefristet, and permanence must not be inferred from a word
 * that only means "salaried position".
 */
export function normalizeContract(
  text: string,
): { permanent: boolean; matched: string } | null {
  const un = text.match(/unbefristet/i);
  if (un) return { permanent: true, matched: un[0] };
  const be = text.match(/befristet/i);
  if (be) return { permanent: false, matched: be[0] };
  return null;
}
