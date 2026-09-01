/**
 * Curation-time gating logic (Phase 1 of the curated-algo optimization).
 *
 * Different concern from `scoring.ts`. `scoring.ts` ranks eligible ads. This
 * file decides which ads are eligible *at all* — the API pre-ingest gate in
 * `fetch-apis.ts`, and (later) the same gate reused inside the digest read
 * path. The two are related but should not share code: a change to the
 * ingest gate's tiers must not silently shift the ranking distribution, and
 * vice versa.
 *
 * The gate has two knobs:
 *
 *   1. `directionFitStrength` — graduated [0, 1] match across title +
 *      description + exclude terms + direction distance.
 *   2. `inferMode` — 'focused' vs 'discovery' regime, derived from the
 *      user's direction set. The regime picks the threshold on strength.
 *
 * The regime split is the product answer to "how does the system know if
 * the user knows what they want": a small coherent direction set means
 * yes (be strict), a large or empty one means no (be permissive so
 * explore has variety).
 */
import type { Distance } from './discovery';

export type CurationMode = 'focused' | 'discovery';

/**
 * Minimum `directionFitStrength` an ad needs to pass the gate, per mode.
 *
 * `focused` = 0.7 sits above the long-word tier (0.6 × 1.0 = 0.6): a focused
 * user only sees ads whose title carries the full phrase of one of their
 * searchTerms (1.0), or a stretch full-phrase (0.5 — still misses; a focused
 * user opted out of stretch matches by definition). This is deliberately
 * strict: after removing role-suffix words from the long-word tier (see
 * `NON_DISCRIMINATIVE_ROLE_WORDS` below), the long-word tier itself is
 * healthy, but leaving `focused` at 0.6 puts every domain long-word hit
 * exactly at the boundary — one wording drift and the ad is out. 0.7 gives
 * the tier the margin the design of the tier system asks for.
 */
export const CURATION_THRESHOLDS: Record<CurationMode, number> = {
  focused: 0.7,
  discovery: 0.3,
};

/**
 * How many characters of description count toward a match. Long enough to
 * cover a lede/first paragraph where the real role signal lives, short
 * enough that a wall of boilerplate ("we are an equal opportunity
 * employer, we value diversity, ...") can't grant a match by accident.
 */
export const DESCRIPTION_MATCH_CHARS = 400;

/** Subset of DirectionRow this file reads. Kept minimal so `core` stays free of a `db` dep. */
export interface CurationDirection {
  distance: Distance;
  searchTerms: readonly string[];
  excludeTerms: readonly string[];
}

const STOP_WORDS = new Set([
  'and', 'the', 'for', 'with', 'from',
  'von', 'und', 'für', 'mit', 'der', 'die', 'das', 'bei', 'zur', 'als',
]);

/**
 * Role-suffix words that CANNOT be evidence of a match on their own.
 *
 * The bug this fixes ("Sales Director" landing in a design user's digest):
 * these words are structural — they name the *shape* of a role (director,
 * engineer, designer), never its domain. In a real ad title they always pair
 * with a domain qualifier: "**Sales** Director", "**Creative** Director",
 * "**Machine Learning** Engineer". Treating them as long-word evidence in the
 * fallback tier lets a CV that proposes "Creative Director" as a search
 * term pull every "Sales/Marketing/Regional/Operations Director" into the
 * digest — the exact false-positive class the pre-ingest gate is meant to
 * remove.
 *
 * The rule is: a searchTerm that contains one of these words needs the
 * *whole phrase* to match. The long-word fallback is reserved for domain
 * words ("typescript", "distributed", "compliance", "healthcare",
 * "kubernetes") — words that are themselves discriminative.
 *
 * Kept minimal on purpose and only includes forms ≥8 chars (below that,
 * the long-word tier does not consider the word anyway). "manager" (7) is
 * absent for that reason; "managerin" (9) is included because German
 * gendered forms cross the threshold. English + German role words; add a
 * new entry only when a specific false-positive case names it.
 */
export const NON_DISCRIMINATIVE_ROLE_WORDS: ReadonlySet<string> = new Set([
  'director',
  'engineer',
  'engineers',
  'engineering',
  'entwickler',
  'entwicklerin',
  'developer',
  'developers',
  'development',
  'designer',
  'designers',
  'gestalter',
  'gestalterin',
  'managerin',
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
]);

/**
 * Role synonyms — deliberately mirrored from `scoring.ts`. Kept duplicated
 * rather than imported because these two files answer different questions
 * and shouldn't share a mutable table: a synonym added for scoring purposes
 * (e.g. "senior"/"lead") could quietly loosen the ingest gate too, which is
 * the opposite of what this file's job is.
 */
const ROLE_SYNONYMS: Readonly<Record<string, readonly string[]>> = {
  engineer:   ['engineer', 'developer', 'entwickler'],
  developer:  ['engineer', 'developer', 'entwickler'],
  entwickler: ['engineer', 'developer', 'entwickler'],
  designer:   ['designer', 'gestalter'],
  gestalter:  ['designer', 'gestalter'],
  manager:    ['manager', 'managerin'],
  managerin:  ['manager', 'managerin'],
};

/**
 * Distance factor — same shape as `scoring.ts`. A stretch direction's
 * evidence counts for less: a stretch × long-word title (0.5 × 0.6 = 0.3)
 * lands in discovery but not focused, which is the intended behavior — a
 * user with clarity doesn't want stretch guesses in their inbox.
 */
const DISTANCE_FACTOR: Record<Distance, number> = {
  adjacent: 1.0,
  stretch: 0.5,
};

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[\s/,\-()+]+/)
    .filter((w) => w.length >= 3 && !STOP_WORDS.has(w));
}

function containsWord(haystack: string, word: string): boolean {
  const alts = ROLE_SYNONYMS[word] ?? [word];
  return alts.some((alt) => haystack.includes(alt));
}

function hasExcludeHit(text: string, excludeTerms: readonly string[]): boolean {
  return excludeTerms.some((term) => term.length > 0 && text.includes(term.toLowerCase()));
}

/**
 * Graduated direction match across title + description + exclude terms +
 * distance. Returns the best strength across all directions.
 *
 * Tiers (highest wins for each direction):
 *
 *   Exclude term in title or description (ANY dir) .  → whole ad returns 0
 *   Full phrase in title ...........................  1.0
 *   Full phrase in first 400 chars of description ..  0.8
 *   Long word (≥8, non-role-suffix) in title .......  0.6
 *   Long word (≥8, non-role-suffix) in first 400 ...  0.4
 *   No match .......................................  0
 *
 * The winning tier is then multiplied by the direction's DISTANCE_FACTOR.
 * The function returns `max` across directions.
 *
 * Two behaviors that are easy to miss:
 *
 * 1. `excludeTerms` are ad-level, not direction-level. The excludes from
 *    every direction are unioned and applied once against title + desc; a
 *    hit zeros the whole call. Reason: users think "I don't want to see
 *    sales roles", not "I don't want to see sales roles matched by
 *    direction X but I'm fine seeing them matched by direction Y". The old
 *    per-direction behavior surfaced the "Sales Solutions Engineer" case
 *    (matches a permissive "Solutions Engineer" direction even though a
 *    stricter "Engineer" direction excludes "sales") — which is exactly
 *    the false-positive class the exclude UI is meant to remove.
 *
 * 2. The long-word tier filters out `NON_DISCRIMINATIVE_ROLE_WORDS`
 *    (director/engineer/designer/onboarding/...). Those need the full
 *    phrase to count. See that constant's docstring for the "Sales
 *    Director" example.
 *
 * Empty directions returns 1.0 — the caller decides not to gate; this is
 * belt-and-braces so passing this function through unconditionally doesn't
 * drop every ad.
 */
export function directionFitStrength(
  title: string,
  description: string | null,
  directions: readonly CurationDirection[],
): number {
  if (directions.length === 0) return 1;

  const t = title.toLowerCase();
  const d = (description ?? '').slice(0, DESCRIPTION_MATCH_CHARS).toLowerCase();

  // Ad-level exclude: union of every direction's excludeTerms, applied once.
  const allExcludes = directions.flatMap((dir) => dir.excludeTerms);
  if (hasExcludeHit(t, allExcludes) || hasExcludeHit(d, allExcludes)) {
    return 0;
  }

  let best = 0;

  for (const dir of directions) {
    let tier = 0;

    for (const term of dir.searchTerms) {
      const words = tokenize(term);
      if (words.length === 0) continue;
      if (words.every((w) => containsWord(t, w))) {
        tier = 1.0;
        break;
      }
    }

    if (tier < 1.0 && d.length > 0) {
      for (const term of dir.searchTerms) {
        const words = tokenize(term);
        if (words.length === 0) continue;
        if (words.every((w) => containsWord(d, w))) {
          tier = 0.8;
          break;
        }
      }
    }

    if (tier < 0.8) {
      const longWords = dir.searchTerms
        .flatMap(tokenize)
        .filter((w) => w.length >= 8 && !NON_DISCRIMINATIVE_ROLE_WORDS.has(w));
      if (longWords.some((w) => containsWord(t, w))) {
        tier = Math.max(tier, 0.6);
      } else if (d.length > 0 && longWords.some((w) => containsWord(d, w))) {
        tier = Math.max(tier, 0.4);
      }
    }

    const scaled = tier * DISTANCE_FACTOR[dir.distance];
    if (scaled > best) best = scaled;
  }

  return best;
}

/**
 * `focused` when the user has a small direction set (1–3 directions),
 * `discovery` otherwise. Empty → discovery (formality; the caller doesn't
 * gate when there are no directions).
 *
 * MVP heuristic — count alone. A later iteration can add a same-family
 * clustering check on labels/searchTerms so a user with 3 directions
 * spread across three role families is treated as discovery even under
 * the count cap. Count is a decent first approximation: a user with 4+
 * live directions is exploring, whatever they say.
 */
export function inferMode(directions: readonly { distance: Distance }[]): CurationMode {
  if (directions.length === 0) return 'discovery';
  if (directions.length <= 3) return 'focused';
  return 'discovery';
}
