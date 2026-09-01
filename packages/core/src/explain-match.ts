/**
 * Structured explanations for `title × directions` matching.
 *
 * The rest of the curation stack — `computeMatch`, `directionFitStrength`,
 * `directionFit`, `matchesAnyDirection` — answers "does this ad match?"
 * with a number or a boolean. This file answers "*why*?" with data.
 *
 * The two questions belong apart because their consumers differ. The
 * numbers-and-booleans path runs on every ad on every read and stays
 * hot; it must not carry the string-building weight the UI wants. The
 * explain path runs when someone clicks "why is this here?" on a card,
 * or when a test wants a declarative assertion ("expect(
 * explainMatch(...).find(...).kind).toBe('excluded')"), or when a log
 * line should say what actually happened rather than a score number
 * that could mean several things at once.
 *
 * Same doctrine as `explain-digest.ts`: this module is data-first.
 * `describeMatch` is a small formatter beside it that turns one
 * `MatchExplanation` into a human sentence — kept here so the wording
 * cannot drift from the shape it describes.
 *
 * Pure. No I/O, no persistence. The output is one `MatchExplanation`
 * per direction, in the same order the caller passed them, so a UI
 * that already rendered the directions in a specific order can zip
 * the two lists together without a lookup.
 */
import type { Distance } from './discovery';
import {
  DESCRIPTION_MATCH_CHARS,
  computeMatch,
  type MatchSurface,
  type MatchTier,
} from './matching';

// ── Types ────────────────────────────────────────────────────────────────────

/**
 * Subset of a direction this file reads. Same shape as
 * `CurationDirection` in `curation.ts` plus a `label`. Kept separate so
 * `explainMatch` can be called with a light object from a test or a UI
 * without pulling the wider `DirectionRow` from `@job-digest/db`.
 */
export interface ExplainableDirection {
  label: string;
  distance: Distance;
  searchTerms: readonly string[];
  excludeTerms: readonly string[];
}

/**
 * One direction's outcome against a single (title, description). Three
 * shapes, discriminated by `kind` — the same variant style `Verdict`
 * uses in `evaluate.ts`, so consumers can `switch (exp.kind)` and get
 * exhaustive-narrowing help from the type system.
 *
 * `matched` — the direction found signal.
 * `excluded` — an excludeTerm on THIS direction fired against the title
 *   or description. Note: the ad-level exclude that `directionFitStrength`
 *   applies (union across every direction) is derivable by walking the
 *   returned array and looking for any `excluded` kind — this per-direction
 *   verdict is the honest one to record, because it names WHICH direction
 *   owned the exclude.
 * `no-signal` — the direction has no exclude hit and no tier > 0 match.
 */
export type MatchExplanation =
  | {
      kind: 'matched';
      label: string;
      distance: Distance;
      tier: MatchTier;
      matchedTerm: string;
      via: 'full-phrase' | 'long-word';
      surface: Exclude<MatchSurface, 'none'>;
      /** The specific ≥8-char domain word that carried a long-word match. Null for full-phrase. */
      longWord: string | null;
    }
  | {
      kind: 'excluded';
      label: string;
      distance: Distance;
      term: string;
      where: 'title' | 'description';
    }
  | {
      kind: 'no-signal';
      label: string;
      distance: Distance;
    };

// ── Exclude detection (word-boundary, same as curation.ts) ───────────────────

const REGEX_META = /[.*+?^${}()|[\]\\]/g;

/**
 * If any exclude term hits, returns the term that matched and where.
 * Word-boundary regex with /u flag — the mirror of `hasExcludeHit` in
 * `curation.ts`. Duplicated intentionally: this file returns the WITNESS
 * (term + surface), the gate returns just the boolean. Keeping them apart
 * means one can evolve without the other silently drifting.
 */
function findExcludeHit(
  title: string,
  description: string | null,
  excludeTerms: readonly string[],
): { term: string; where: 'title' | 'description' } | null {
  const descWindow = description ? description.slice(0, DESCRIPTION_MATCH_CHARS) : null;
  for (const raw of excludeTerms) {
    const term = raw.trim().toLowerCase();
    if (!term) continue;
    const escaped = term.replace(REGEX_META, '\\$&');
    const re = new RegExp(`\\b${escaped}\\b`, 'iu');
    if (re.test(title)) return { term, where: 'title' };
    if (descWindow && re.test(descWindow)) return { term, where: 'description' };
  }
  return null;
}

// ── The one public function ──────────────────────────────────────────────────

/**
 * One MatchExplanation per direction, same order as `directions`.
 *
 * For each direction, exclude terms are checked first — an excluded
 * direction never reports a "matched" outcome, even if the searchTerms
 * would have matched. That is deliberate: an exclude is the user saying
 * "I don't want this class of role"; a positive match despite the
 * exclude would be a UI lie.
 *
 * Callers that want an ad-level exclude view (the ingest gate does this)
 * scan the return array for `kind === 'excluded'` — the first one wins.
 */
export function explainMatch(
  title: string,
  description: string | null,
  directions: readonly ExplainableDirection[],
): MatchExplanation[] {
  return directions.map<MatchExplanation>((dir) => {
    const excl = findExcludeHit(title, description, dir.excludeTerms);
    if (excl) {
      return { kind: 'excluded', label: dir.label, distance: dir.distance, ...excl };
    }
    const match = computeMatch(title, description, dir.searchTerms);
    if (match.tier === 0) {
      return { kind: 'no-signal', label: dir.label, distance: dir.distance };
    }
    return {
      kind: 'matched',
      label: dir.label,
      distance: dir.distance,
      tier: match.tier,
      matchedTerm: match.matchedTerm!,
      via: match.viaFullPhrase ? 'full-phrase' : 'long-word',
      // `computeMatch` guarantees surface !== 'none' when tier > 0.
      surface: match.surface as Exclude<MatchSurface, 'none'>,
      longWord: match.viaLongWord,
    };
  });
}

// ── Human wording ────────────────────────────────────────────────────────────

/**
 * One-sentence rendering of a `MatchExplanation`, for the AdCard's "why
 * is this here?" chip and for log lines. The wording is factual — no
 * "great match!" — matching the rest of the product's voice.
 */
export function describeMatch(exp: MatchExplanation): string {
  switch (exp.kind) {
    case 'matched': {
      if (exp.via === 'full-phrase') {
        return `Matched “${exp.label}” — full phrase “${exp.matchedTerm}” in ${exp.surface}.`;
      }
      // long-word: name both the winning word and the source term it came from.
      return `Matched “${exp.label}” — long-word “${exp.longWord}” from “${exp.matchedTerm}” in ${exp.surface}.`;
    }
    case 'excluded':
      return `Excluded from “${exp.label}” — “${exp.term}” in ${exp.where}.`;
    case 'no-signal':
      return `No match for “${exp.label}”.`;
  }
}
