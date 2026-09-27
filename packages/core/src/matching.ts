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

// ── Spelling normalisation ───────────────────────────────────────────────────

/**
 * Closed table of role-word spelling variants, rewritten to one canonical
 * form before any matching happens. Applied identically to titles,
 * description windows, search terms (via `tokenize`) and exclude terms, so
 * every side of every comparison speaks the same spelling.
 *
 * Why it exists (Sep 2026 ranking eval): recall misses that were pure
 * spelling. "frontend engineer" did not match "Senior Front End Engineer"
 * (the title tokenizes to "front" + "end", neither of which is
 * "frontend"), nor "Front-End Developer"; the same for full stack /
 * full-stack / fullstack and back end / back-end / backend. German
 * compounds had the mirror problem: a searchTerm "web entwickler" never
 * reached "Webentwickler" ("web" is short, so it needs a word boundary the
 * compound does not have), and a searchTerm "Softwareentwickler" never
 * reached "Software Entwickler".
 *
 * Canonical forms, and why they point in opposite directions:
 *
 *   - English JOINS: "front end" → "frontend", "back end" → "backend",
 *     "full stack" → "fullstack". The halves are generic words — "Front
 *     Desk", "End User", "Back Office", "Full-time", "Stack Overflow" — so
 *     as separate tokens they are evidence of nothing, and a split
 *     canonical form would let "End User Support Engineer" at a front desk
 *     assemble "front" + "end" from unrelated words. Joined, the evidence
 *     stays one discriminative token.
 *   - German SPLITS: "Softwareentwickler" → "software entwickler",
 *     "Webentwickler" → "web entwickler". Here the head is a role word the
 *     matcher already knows: "entwickler" is keyed in ROLE_SYNONYMS (so
 *     "Softwareentwickler" can reach "Software Engineer") and in
 *     NON_DISCRIMINATIVE_ROLE_WORDS (so it cannot carry a long-word match
 *     alone). A joined compound hides the head from both tables. Split is
 *     also what the hyphenated form "Software-Entwickler" already
 *     tokenizes to, so the compound joins the form the tokenizer produces
 *     anyway, and a short modifier ("web") gets the word boundary its
 *     boundary-match needs.
 *
 * Order matters: the English joins run first so "Front-End-Entwickler" and
 * "Frontendentwickler" both land on "frontend entwickler".
 *
 * Closed on purpose, like the lexicons in title-lexicon.ts: an open
 * "split any word ending in -entwickler" rule would also split
 * "Anwendungsentwickler" (a distinct trade title) and every future
 * compound nobody has looked at. Extend the table when a real miss names
 * a form. Separators cover whitespace, ASCII hyphen, and the Unicode
 * hyphen, non-breaking hyphen and en dash that pasted titles carry.
 *
 * `\b` on both ends of the English patterns keeps "front endpoint" and
 * "backend" itself untouched; the German pattern has no trailing `\b` so
 * the feminine and plural forms ("Webentwicklerin", "Softwareentwickler:in")
 * split the same way.
 */
export const ROLE_SPELLING_PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  // English — join to the one-word form.
  [/\bfront[\s\-‐‑–]+end\b/giu, 'frontend'],
  [/\bback[\s\-‐‑–]+end\b/giu, 'backend'],
  [/\bfull[\s\-‐‑–]+stack\b/giu, 'fullstack'],
  // German — split "<domain>entwickler" so the head noun is its own token.
  [/\b(software|web|frontend|backend|fullstack)(entwickler)/giu, '$1 $2'],
];

/**
 * Rewrite role-word spelling variants to their canonical form (see
 * ROLE_SPELLING_PATTERNS). Case is otherwise preserved, but callers pass
 * lowercased text in practice. Idempotent: every canonical form is a fixed
 * point of the table, so normalising twice is harmless.
 */
export function normalizeRoleSpelling(text: string): string {
  let out = text;
  for (const [re, replacement] of ROLE_SPELLING_PATTERNS) out = out.replace(re, replacement);
  return out;
}

// ── Tokenization + word match ────────────────────────────────────────────────

/**
 * Lowercase, normalise role spelling, split, drop short/stop words. Same
 * rule for titles and search terms so tokens compare like-with-like — the
 * spelling pass lives here (not at each caller) so every searchTerm
 * tokenized anywhere in the ladder is already canonical.
 */
export function tokenize(text: string): string[] {
  return normalizeRoleSpelling(text.toLowerCase())
    .split(/[\s/,\-()+]+/)
    .filter((w) => w.length >= MIN_TOKEN_LEN && !STOP_WORDS.has(w));
}

/**
 * True when `word` (or any of its ROLE_SYNONYMS) appears in the (already-
 * lowercased) haystack.
 *
 * Tokens ≥ LONG_WORD_MIN (8) chars match by substring, deliberately: the
 * long-word tier (0.6/0.4) leans on this to let "typescript" inside
 * "typescriptdev" or "designer" inside "graphic-designer-lead" pull an ad
 * in even when the wrapping title uses non-standard punctuation. Short
 * tokens (< 8) match at a word boundary instead, because a plain substring
 * pulls a short discriminator into any host word that happens to spell it
 * out — "art" was inside "startup" and "chart", so a searchTerm of
 * "art director" fired tier 1.0 against "Startup Director" and "Chart
 * Director" for every graphic-design CV in the audit. The word-boundary
 * regex uses the /u flag so non-ASCII letters (ñ, ä, ö, ü) count as word
 * characters — a searchTerm of "gerente" boundary-matches "gerente de
 * cuentas" without splitting the tilde-carrying letter, matching the
 * excludes convention already used in curation.ts's hasExcludeHit.
 *
 * `word` itself is passed at whatever length the caller tokenized it to,
 * but each candidate `alt` in the ROLE_SYNONYMS family may have a
 * different length (e.g. "manager"=7 and "managerin"=9 sit in the same
 * family) — so the threshold is applied per-alt, not per-word.
 */
const REGEX_META = /[.*+?^${}()|[\]\\]/g;
export function containsWord(haystack: string, word: string): boolean {
  const alts = ROLE_SYNONYMS[word] ?? [word];
  return alts.some((alt) => {
    if (alt.length >= LONG_WORD_MIN) return haystack.includes(alt);
    const escaped = alt.replace(REGEX_META, '\\$&');
    return new RegExp(`\\b${escaped}\\b`, 'iu').test(haystack);
  });
}

// ── Full-phrase structure ────────────────────────────────────────────────────

/**
 * Where a title (or a description window) breaks into separate phrases:
 * commas, semicolons, pipes, colons, brackets, newlines, en/em dashes,
 * sentence ends, and an ASCII hyphen or slash only when it has whitespace
 * on both sides. "Engineering Manager - Fintech" and "Manager, Software
 * Engineering" split; "Web-Entwicklung", "Front-End" and "UX/UI Designer"
 * stay whole, because a bare hyphen or slash joins a compound rather than
 * separating a role from its qualifier. "." only splits before whitespace
 * so "node.js" survives.
 */
const SEGMENT_SEPARATORS = /\s+[-/]\s+|[–—,;|:()[\]\n]|[.!?](?=\s|$)/;

/**
 * Words allowed next to the role head in a "Role, Qualifier" title without
 * counting as a *different* qualifier of that role — see
 * `roleQualifierInversion`. Seniority/level markers (EN + the ES forms the
 * AR market posts: "Ssr", "Semi Senior") plus "software", the one
 * discipline word that is a generic umbrella rather than a competing
 * specialization: "Software Engineer, Frontend" is a frontend engineer,
 * whereas "Category Manager - Engineering" is a category manager. Only
 * tokens ≥ MIN_TOKEN_LEN matter ("Sr", "II" are dropped by `tokenize`).
 * Extend when a real title names a form; do NOT add domain words here —
 * every entry is a hole in the "Category Manager" guard.
 */
const GENERIC_ROLE_MODIFIERS: ReadonlySet<string> = new Set([
  'senior',
  'sénior',
  'junior',
  'staff',
  'principal',
  'lead',
  'mid',
  'level',
  'iii',
  'semi',
  'semisenior',
  'ssr',
  'software',
]);

/**
 * A title or description window as its phrase segments, each tokenized.
 * Empty segments dropped. The structure checks below then ask
 * `containsWord(token, word)` of single tokens, so synonyms and the
 * per-alt substring/word-boundary rule apply exactly as they did when the
 * whole title was the haystack.
 */
function segmentTokens(text: string): string[][] {
  return text
    .split(SEGMENT_SEPARATORS)
    .map(tokenize)
    .filter((seg) => seg.length > 0);
}

/** Every word appears in `seg` in the term's order; other words may sit between them. */
function inTermOrder(seg: readonly string[], words: readonly string[]): boolean {
  let i = 0;
  for (const w of words) {
    while (i < seg.length && !containsWord(seg[i]!, w)) i++;
    if (i === seg.length) return false;
    i++;
  }
  return true;
}

/** Every word appears in one contiguous run of `seg` of exactly `words.length` tokens, any order. */
function contiguousRun(seg: readonly string[], words: readonly string[]): boolean {
  for (let start = 0; start + words.length <= seg.length; start++) {
    const run = seg.slice(start, start + words.length);
    if (words.every((w) => run.some((tok) => containsWord(tok, w)))) return true;
  }
  return false;
}

/**
 * "Role, Qualifier" titles (common on Greenhouse/Lever): "Software
 * Engineer, Frontend", "Manager, Software Engineering - Growth Platform".
 * Fires when the segment holding the term's head (its LAST word — English
 * role nouns are head-final) contains nothing but term words and
 * GENERIC_ROLE_MODIFIERS, and every other term word appears anywhere in
 * the text. A bare head segment says "this is the role"; the rest of the
 * term may qualify it from another segment.
 *
 * The bare-head requirement is what blocks "Category Manager -
 * Engineering & Professional Services": "category" is a different noun
 * directly qualifying "manager", so the role is Category Manager and
 * "Engineering" is just the category. Requiring the head (not the first
 * word) blocks the mirror image, "Engineering - Office Manager".
 *
 * Head-first term orders (Spanish "ingeniero backend") get no inversion —
 * their title matches go through the contiguous-run rule instead; an
 * inverted English title against a Spanish-ordered term ("Software
 * Engineer, Backend" vs "ingeniero backend") falls through to the lower
 * tiers. Accepted: we have not seen that pairing in real data.
 */
function roleQualifierInversion(segs: readonly (readonly string[])[], words: readonly string[]): boolean {
  if (words.length < 2) return false;
  const head = words[words.length - 1]!;
  const headSegIsBare = segs.some(
    (seg) =>
      seg.some((tok) => containsWord(tok, head)) &&
      seg.every((tok) => GENERIC_ROLE_MODIFIERS.has(tok) || words.some((w) => containsWord(tok, w))),
  );
  if (!headSegIsBare) return false;
  return words.every((w) => segs.some((seg) => seg.some((tok) => containsWord(tok, w))));
}

/**
 * Full-phrase test for one search term against pre-segmented text — the
 * rule behind tiers 1.0 and 0.8. A term's words match when either:
 *
 *   (a) they all sit in ONE segment, either in the term's order (extra
 *       words allowed between: "senior manager" ↔ "Senior Product
 *       Manager") or as one contiguous run in any order (cross-language
 *       head-first forms: "backend engineer" ↔ "Desarrollador Backend",
 *       "engineering director" ↔ "Director of Engineering"); or
 *   (b) the title is a "Role, Qualifier" inversion — see
 *       `roleQualifierInversion`.
 *
 * Before Sep 2026 this was a bag of words: every term word anywhere in the
 * title. The Sep 2026 ranking eval against a real account found that
 * letting through roles the user had dismissed — "Category Manager -
 * Engineering & Professional Services" and "Manager Operations Engineering
 * Performance" both scored 1.0 for "Engineering Manager". Word order is
 * the cheapest structural signal that separates "Engineering Manager"
 * from "a manager of something, with engineering nearby"; segments keep
 * a department name after a dash from being read as part of the role.
 */
function phraseMatches(segs: readonly (readonly string[])[], words: readonly string[]): boolean {
  if (segs.some((seg) => inTermOrder(seg, words) || contiguousRun(seg, words))) return true;
  return roleQualifierInversion(segs, words);
}

// ── The one match function ───────────────────────────────────────────────────

/**
 * Tier ladder, highest wins:
 *
 *   1.0 — full phrase in the title: some searchTerm's tokenized words sit
 *         in the title in role order or as a "Role, Qualifier" inversion
 *         (see `phraseMatches` — word order matters since the Sep 2026
 *         ranking eval; a bag of words is not a phrase)
 *   0.8 — same, in the first DESCRIPTION_MATCH_CHARS of the description
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

  // Spelling pre-pass (see ROLE_SPELLING_PATTERNS). Search terms get the
  // same pass inside `tokenize`, so `matchedTerm` still reports the term as
  // the user wrote it.
  const t = normalizeRoleSpelling(title.toLowerCase());
  const d = description
    ? normalizeRoleSpelling(description.slice(0, DESCRIPTION_MATCH_CHARS).toLowerCase())
    : '';

  // Tier 1.0 — full phrase in title. A phrase that fails the structure
  // check (e.g. "Category Manager - Engineering") simply falls through to
  // the lower tiers like any other miss.
  const titleSegs = segmentTokens(t);
  for (const term of searchTerms) {
    const words = tokenize(term);
    if (words.length === 0) continue;
    if (phraseMatches(titleSegs, words)) {
      return { tier: 1.0, matchedTerm: term, viaFullPhrase: true, viaLongWord: null, surface: 'title' };
    }
  }

  // Tier 0.8 — full phrase in description.
  if (d.length > 0) {
    const descSegs = segmentTokens(d);
    for (const term of searchTerms) {
      const words = tokenize(term);
      if (words.length === 0) continue;
      if (phraseMatches(descSegs, words)) {
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
