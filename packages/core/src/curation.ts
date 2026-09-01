/**
 * Curation-time gating logic (Phase 1 of the curated-algo optimization).
 *
 * Different concern from `scoring.ts`. `scoring.ts` ranks eligible ads. This
 * file decides which ads are eligible *at all* — the API pre-ingest gate in
 * `fetch-apis.ts`, and (later) the same gate reused inside the digest read
 * path.
 *
 * The match ladder itself now lives in `matching.ts` (`computeMatch`) — one
 * source of truth shared by every gate and by the ranking layer. This file
 * owns the *policy* the ingest gate applies on top of that ladder:
 *
 *   1. `directionFitStrength` — graduated [0, 1] match: the max, over
 *      directions, of `computeMatch(...).tier × DISTANCE_FACTOR[distance]`,
 *      with ad-level excludes short-circuiting to 0.
 *   2. `inferMode` — 'focused' vs 'discovery' regime, derived from the
 *      user's direction set. The regime picks the threshold on strength.
 *
 * The regime split is the product answer to "how does the system know if
 * the user knows what they want": a small coherent direction set means
 * yes (be strict), a large or empty one means no (be permissive so
 * explore has variety).
 */
import type { Distance } from './discovery';
import { computeMatch, DESCRIPTION_MATCH_CHARS, DISTANCE_FACTOR } from './matching';

export type CurationMode = 'focused' | 'discovery';

/**
 * Minimum `directionFitStrength` an ad needs to pass the gate, per mode.
 *
 * `focused` = 0.7 sits above the long-word tier (0.6 × 1.0 = 0.6): a focused
 * user only sees ads whose title carries the full phrase of one of their
 * searchTerms (1.0), or a stretch full-phrase (0.5 — still misses; a focused
 * user opted out of stretch matches by definition). This is deliberately
 * strict: with role-suffix words already filtered from the long-word tier
 * in `computeMatch`, the tier itself is healthy, but leaving `focused` at
 * 0.6 puts every domain long-word hit exactly at the boundary — one
 * wording drift and the ad is out. 0.7 gives the tier the margin the
 * design of the tier system asks for.
 */
export const CURATION_THRESHOLDS: Record<CurationMode, number> = {
  focused: 0.7,
  discovery: 0.3,
};

/**
 * Re-exported from `matching.ts` so existing callers keep the same import
 * path. The constant itself lives beside `computeMatch`, where the
 * description-slice logic actually runs.
 */
export { DESCRIPTION_MATCH_CHARS };

/** Subset of DirectionRow this file reads. Kept minimal so `core` stays free of a `db` dep. */
export interface CurationDirection {
  distance: Distance;
  searchTerms: readonly string[];
  excludeTerms: readonly string[];
}

// ── Excludes (ad-level, word-boundary) ───────────────────────────────────────

/** Regex metacharacters we escape before injecting a user-supplied term. */
const REGEX_META = /[.*+?^${}()|[\]\\]/g;

/**
 * True when any exclude term appears in `text` as a whole word (or, for a
 * multi-word term, as a contiguous phrase of whole words).
 *
 * Word-boundary match, not substring: an exclude "lead" no longer clobbers
 * "Leadership", and "sales" no longer clobbers "wholesale". Regex uses \b
 * with the /u flag so `\b` treats Spanish and German word characters (ñ,
 * ä, ö, ü) as letters — an exclude "diseñador" matches "diseñador ux" but
 * not "diseñadora".
 *
 * This gate zeroes the whole ad (excludes are ad-level, see
 * directionFitStrength), so a false-positive exclude silently drops a
 * real match — that is the failure mode a substring match invites and
 * this rewrite closes.
 */
function hasExcludeHit(text: string, excludeTerms: readonly string[]): boolean {
  for (const raw of excludeTerms) {
    const term = raw.trim().toLowerCase();
    if (!term) continue;
    const escaped = term.replace(REGEX_META, '\\$&');
    if (new RegExp(`\\b${escaped}\\b`, 'iu').test(text)) return true;
  }
  return false;
}

// ── The gate ─────────────────────────────────────────────────────────────────

/**
 * Best (match tier × distance factor) across the user's directions, with an
 * ad-level exclude short-circuit.
 *
 * Tiers come straight from `computeMatch` in `matching.ts` — see that file
 * for the ladder. Two behaviors this file layers on top:
 *
 * 1. `excludeTerms` are ad-level, not direction-level. The excludes from
 *    every direction are unioned and applied once against title + desc; a
 *    hit zeros the whole call. Reason: users think "I don't want to see
 *    sales roles", not "I don't want to see sales roles matched by
 *    direction X but I'm fine seeing them matched by direction Y". The old
 *    per-direction behavior surfaced the "Sales Solutions Engineer" case
 *    (matches a permissive "Solutions Engineer" direction even though a
 *    stricter "Engineer" direction excludes "sales") — exactly the
 *    false-positive class the exclude UI is meant to remove.
 *
 * 2. `DISTANCE_FACTOR` scales evidence: a stretch × long-word title (0.5 ×
 *    0.6 = 0.3) lands in discovery but not focused. Callers that don't
 *    care about distance (the boolean digest gate) use `computeMatch`
 *    directly and skip this layer.
 *
 * Empty directions → 1.0 (belt-and-braces so passing this function through
 * unconditionally doesn't drop every ad; the caller decides not to gate).
 */
export function directionFitStrength(
  title: string,
  description: string | null,
  directions: readonly CurationDirection[],
): number {
  if (directions.length === 0) return 1;

  // Ad-level exclude: union of every direction's excludeTerms, applied once.
  const allExcludes = directions.flatMap((dir) => dir.excludeTerms);
  if (allExcludes.length > 0) {
    if (hasExcludeHit(title, allExcludes)) return 0;
    if (description && hasExcludeHit(description.slice(0, DESCRIPTION_MATCH_CHARS), allExcludes)) return 0;
  }

  let best = 0;
  for (const dir of directions) {
    const match = computeMatch(title, description, dir.searchTerms);
    const scaled = match.tier * DISTANCE_FACTOR[dir.distance];
    if (scaled > best) {
      best = scaled;
      if (best >= 1.0) break; // ceiling — no other direction can beat this.
    }
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
