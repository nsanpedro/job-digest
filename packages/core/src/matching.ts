/**
 * The one place where a job title (and optionally its description) is
 * checked against a user's direction. Every gate and every score in the
 * curation stack routes through `computeMatch`:
 *
 *   - Ingest gate  (`directionFitStrength` in curation.ts)  — graduated 0..1
 *     against a mode-dependent threshold.
 *   - Digest read  (`matchesAnyDirection` in db/queries/digest.ts) — boolean.
 *   - Ranking      (`directionFit` in scoring.ts)  — graduated, title-only.
 *
 * Before this file existed the same logic — tokenizer + synonyms +
 * role-suffix blocklist + tier ladder — lived independently in each of the
 * three call sites, with a comment on each saying "kept duplicated on
 * purpose because we answer different questions". That comment stopped
 * being true once the callers converged to the same match ladder and
 * different post-processing; the "Sales Director" fix (Sep 2026) had to
 * be applied identically in three files, which is exactly the drift the
 * duplication was meant to prevent. One source of truth here, one adapter
 * per caller.
 *
 * Pure — no I/O, no state, safe to call inside a hot render loop.
 */
import type { Distance } from './discovery';

// ── Constants ────────────────────────────────────────────────────────────────

/**
 * How many characters of description count toward a match. Long enough to
 * cover a lede/first paragraph where the real role signal lives, short
 * enough that a wall of boilerplate ("we are an equal opportunity
 * employer...") can't grant a match by accident.
 */
export const DESCRIPTION_MATCH_CHARS = 400;

/** Minimum word length for the long-word tier — matches the tokenizer's own floor. */
const LONG_WORD_MIN = 8;

/** Minimum token length after normalization — filters short glue words from search terms and titles. */
const MIN_TOKEN_LEN = 3;

const STOP_WORDS: ReadonlySet<string> = new Set([
  'and', 'the', 'for', 'with', 'from',
  'von', 'und', 'für', 'mit', 'der', 'die', 'das', 'bei', 'zur', 'als',
]);

/**
 * Role-suffix words that CANNOT be evidence of a match on their own.
 *
 * These name the *shape* of a role (director, engineer, designer) and pair
 * with a domain qualifier in real ad titles — "**Sales** Director",
 * "**Creative** Director", "**Machine Learning** Engineer". Treating them
 * as long-word evidence lets a CV that proposes "Creative Director" pull
 * every "Sales/Marketing/Regional Director" into the digest.
 *
 * The rule: a searchTerm containing one of these words needs the whole
 * phrase to match. The long-word fallback is reserved for domain words
 * ("typescript", "distributed", "compliance") — words discriminative on
 * their own.
 *
 * Only forms ≥8 chars are listed (below that, the long-word tier ignores
 * the word anyway — "manager" and "gerente" are 7 chars, so absent).
 * English + German + Spanish today, driven by the markets the product
 * already targets (DACH via curated companies + email alerts, AR/ES via
 * curated companies and CVs in Spanish). Extend when a real
 * false-positive names a form.
 */
export const NON_DISCRIMINATIVE_ROLE_WORDS: ReadonlySet<string> = new Set([
  // English
  'director',
  'directors',
  'engineer',
  'engineers',
  'engineering',
  'developer',
  'developers',
  'development',
  'designer',
  'designers',
  'onboarding',
  'coordinator',
  'coordinators',
  'specialist',
  'specialists',
  'associate',
  'associates',
  'consultant',
  'consultants',
  'architect',
  'architects',
  'generalist',
  'strategist',
  'executive',
  'executives',
  'professional',
  'professionals',
  'representative',
  'representatives',
  // German
  'entwickler',
  'entwicklerin',
  'gestalter',
  'gestalterin',
  'managerin',
  // Spanish — feminine and masculine forms; the ad market posts both.
  // Accented and unaccented variants: containsWord matches by substring,
  // so we need to list both (a CV/ad may drop the tilde in either
  // direction). "gerente" (7 chars) is deliberately absent — below the
  // long-word floor already.
  'ingeniero',
  'ingeniera',
  'ingenieria',
  'ingeniería',
  'desarrollador',
  'desarrolladora',
  'desarrollo',
  'diseñador',
  'diseñadora',
  'disenador',
  'disenadora',
  'gerencia',
  'coordinador',
  'coordinadora',
  'especialista',
  'arquitecto',
  'arquitecta',
  'arquitectura',
  'ejecutivo',
  'ejecutiva',
  'consultor',
  'consultora',
  'representante',
  'representantes',
]);

/**
 * Role synonyms — words treated as interchangeable when matching a search
 * term against a title. Cross-language by design: DACH ads mix English and
 * German role words in the same title; AR/ES ads mix English and Spanish
 * the same way. A CV in Spanish with searchTerm "diseñador ux" should
 * match an ad titled "UX Designer" and vice-versa — without these
 * synonyms the cross-language pair falls through every tier.
 *
 * Key-and-value form so lookup is one-hop and every family is closed:
 * every synonym in a family lists every other member. Adding a language
 * means adding one new set of keys and appending the new forms to every
 * existing family key.
 *
 * Kept minimal on purpose: only widely-interchangeable role words. Adding
 * "senior"/"lead" would open false positives ("Senior Nurse" ≠
 * engineering). All entries stay ≥8 chars — a synonym match is still
 * evidence of role affinity, not accidental substring overlap. `containsWord`
 * does a substring check, so unaccented Spanish forms ("disenador",
 * "ingenieria") ride along with the accented ones without a separate lookup.
 */
export const ROLE_SYNONYMS: Readonly<Record<string, readonly string[]>> = {
  // Engineering family — English ↔ German ↔ Spanish
  engineer: ['engineer', 'developer', 'entwickler', 'ingeniero', 'ingeniera', 'desarrollador', 'desarrolladora'],
  developer: ['engineer', 'developer', 'entwickler', 'ingeniero', 'ingeniera', 'desarrollador', 'desarrolladora'],
  entwickler: ['engineer', 'developer', 'entwickler', 'ingeniero', 'ingeniera', 'desarrollador', 'desarrolladora'],
  ingeniero: ['engineer', 'developer', 'entwickler', 'ingeniero', 'ingeniera', 'desarrollador', 'desarrolladora'],
  ingeniera: ['engineer', 'developer', 'entwickler', 'ingeniero', 'ingeniera', 'desarrollador', 'desarrolladora'],
  desarrollador: ['engineer', 'developer', 'entwickler', 'ingeniero', 'ingeniera', 'desarrollador', 'desarrolladora'],
  desarrolladora: ['engineer', 'developer', 'entwickler', 'ingeniero', 'ingeniera', 'desarrollador', 'desarrolladora'],
  // Design family — English ↔ German ↔ Spanish. "gestalter" covers
  // "UX-Gestalter"; "diseñador"/"disenador" covers accented + unaccented
  // Spanish. English "designer" is a common loan in Spanish ads so the
  // cross-mapping is asymmetric-safe (a substring check catches both).
  designer: ['designer', 'gestalter', 'diseñador', 'diseñadora', 'disenador', 'disenadora'],
  gestalter: ['designer', 'gestalter', 'diseñador', 'diseñadora', 'disenador', 'disenadora'],
  diseñador: ['designer', 'gestalter', 'diseñador', 'diseñadora', 'disenador', 'disenadora'],
  diseñadora: ['designer', 'gestalter', 'diseñador', 'diseñadora', 'disenador', 'disenadora'],
  disenador: ['designer', 'gestalter', 'diseñador', 'diseñadora', 'disenador', 'disenadora'],
  disenadora: ['designer', 'gestalter', 'diseñador', 'diseñadora', 'disenador', 'disenadora'],
  // Product / management family. "gerente" is 7 chars — below tokenizer's
  // long-word floor but still valid as a full-phrase synonym.
  manager: ['manager', 'managerin', 'gerente'],
  managerin: ['manager', 'managerin', 'gerente'],
  gerente: ['manager', 'managerin', 'gerente'],
  // Analyst family — English ↔ Spanish. "analyst"/"analista" are both 7-8
  // chars, so this only helps at the full-phrase tier ("business analyst"
  // vs "analista de negocio") — the long-word tier does not use it.
  analyst: ['analyst', 'analista'],
  analista: ['analyst', 'analista'],
};

// ── Public types ─────────────────────────────────────────────────────────────

/** Possible outcomes of the tier ladder. 0 means no match. */
export type MatchTier = 0 | 0.4 | 0.6 | 0.8 | 1.0;

/** Which surface produced the winning match. `none` iff `tier === 0`. */
export type MatchSurface = 'title' | 'description' | 'none';

/**
 * Result of matching one direction against one (title, description).
 * `matchedTerm` is the entry from `searchTerms` that won. `viaFullPhrase`
 * true → tier is 1.0 or 0.8. `viaLongWord` set → tier is 0.6 or 0.4, and
 * the string is the specific ≥8-char domain word that carried the match
 * — useful for both the ranking layer and the explain-the-match UI.
 */
export interface MatchResult {
  tier: MatchTier;
  matchedTerm: string | null;
  viaFullPhrase: boolean;
  viaLongWord: string | null;
  surface: MatchSurface;
}

const NULL_MATCH: MatchResult = Object.freeze({
  tier: 0,
  matchedTerm: null,
  viaFullPhrase: false,
  viaLongWord: null,
  surface: 'none',
});

/** Distance modifier applied by callers that graduate the result. `stretch` evidence counts for less. */
export const DISTANCE_FACTOR: Readonly<Record<Distance, number>> = {
  adjacent: 1.0,
  stretch: 0.5,
};

// ── Tokenization + word match ────────────────────────────────────────────────

/** Split, lowercase, drop short/stop words. Same rule for titles and search terms so tokens compare like-with-like. */
export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[\s/,\-()+]+/)
    .filter((w) => w.length >= MIN_TOKEN_LEN && !STOP_WORDS.has(w));
}

/** True when `word` (or any of its ROLE_SYNONYMS) appears as a substring of the (already-lowercased) haystack. */
export function containsWord(haystack: string, word: string): boolean {
  const alts = ROLE_SYNONYMS[word] ?? [word];
  return alts.some((alt) => haystack.includes(alt));
}

// ── The one match function ───────────────────────────────────────────────────

/**
 * Tier ladder, highest wins:
 *
 *   1.0 — full phrase in the title (every tokenized word of some searchTerm)
 *   0.8 — full phrase in the first DESCRIPTION_MATCH_CHARS of the description
 *   0.6 — a ≥8-char non-role-suffix word from any searchTerm appears in title
 *   0.4 — same, but in the description window
 *   0.0 — no match
 *
 * Ties within a tier resolve by iteration order of `searchTerms` (first
 * hit wins), which is deterministic and matches the "the term the user
 * wrote first is the one shown as evidence" intuition — the LLM
 * derivation orders search terms by relevance already.
 *
 * `description === null` collapses to a title-only check; the two lower
 * tiers cannot fire. Callers that never carry a description (the digest
 * read gate and the ranking layer today) pass null and stay honest.
 *
 * No distance factor here — that's a per-caller policy (see DISTANCE_FACTOR).
 * No excludes here either — excludes are ad-level and orthogonal to the
 * per-direction match, so they live at the caller that owns "the ad".
 */
export function computeMatch(
  title: string,
  description: string | null,
  searchTerms: readonly string[],
): MatchResult {
  if (searchTerms.length === 0) return NULL_MATCH;

  const t = title.toLowerCase();
  const d = description ? description.slice(0, DESCRIPTION_MATCH_CHARS).toLowerCase() : '';

  // Tier 1.0 — full phrase in title.
  for (const term of searchTerms) {
    const words = tokenize(term);
    if (words.length === 0) continue;
    if (words.every((w) => containsWord(t, w))) {
      return { tier: 1.0, matchedTerm: term, viaFullPhrase: true, viaLongWord: null, surface: 'title' };
    }
  }

  // Tier 0.8 — full phrase in description.
  if (d.length > 0) {
    for (const term of searchTerms) {
      const words = tokenize(term);
      if (words.length === 0) continue;
      if (words.every((w) => containsWord(d, w))) {
        return { tier: 0.8, matchedTerm: term, viaFullPhrase: true, viaLongWord: null, surface: 'description' };
      }
    }
  }

  // Long-word tier — restricted to non-role-suffix domain words.
  // Preserves per-term provenance (which searchTerm contributed the winning
  // word) so a caller rendering "matched via 'typescript' from 'typescript
  // engineer'" has both halves without re-tokenizing.
  for (const term of searchTerms) {
    for (const w of tokenize(term)) {
      if (w.length < LONG_WORD_MIN) continue;
      if (NON_DISCRIMINATIVE_ROLE_WORDS.has(w)) continue;
      if (containsWord(t, w)) {
        return { tier: 0.6, matchedTerm: term, viaFullPhrase: false, viaLongWord: w, surface: 'title' };
      }
    }
  }

  if (d.length > 0) {
    for (const term of searchTerms) {
      for (const w of tokenize(term)) {
        if (w.length < LONG_WORD_MIN) continue;
        if (NON_DISCRIMINATIVE_ROLE_WORDS.has(w)) continue;
        if (containsWord(d, w)) {
          return { tier: 0.4, matchedTerm: term, viaFullPhrase: false, viaLongWord: w, surface: 'description' };
        }
      }
    }
  }

  return NULL_MATCH;
}
