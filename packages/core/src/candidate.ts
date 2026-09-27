/**
 * What the ranking layer knows about the person the digest is for — beyond
 * the directions' search terms. Two facts, both read from text the user gave
 * us, never inferred from their behaviour:
 *
 *   - `seniorities` — the rungs the user is aiming at. Read from the
 *     direction labels and search terms first ("Senior Frontend Engineer"
 *     says it outright); when none of them names a rung, from the years of
 *     experience the CV's verified skills state.
 *   - `stack` — named technologies in the CV's verified skills and in the
 *     directions, through the same closed list the ad titles are read with
 *     (`title-lexicon.ts`), so both sides of the comparison speak one
 *     vocabulary.
 *
 * Saved / applied / dismissed ads are deliberately NOT an input here. They
 * are the labels `scripts/eval-ranking.ts` measures the ranking against;
 * feeding them into the ranking as well would make that measurement grade
 * its own homework. A feedback signal gets its own component, and its own
 * temporal split in the eval, when it lands.
 *
 * The account's home city and remote preference ride along as
 * `location` — the input to `locationFit` since the city stopped being a
 * pre-filter (ADR-003 §8.6).
 *
 * Pure. Computed once per digest read, not per ad.
 */
import type { Skill } from './discovery';
import type { UserLocation } from './location';
import { readSeniority, readStack } from './title-lexicon';
import type { Seniority } from './title-facts';

export interface CandidateProfile {
  /** Rungs the user targets. Empty when nothing they wrote names one — no signal, not "any". */
  seniorities: readonly Seniority[];
  /** Technologies the user's own text names. Empty = no signal. */
  stack: readonly string[];
  /** Home city + remote preference from the account. City null = no signal. */
  location: UserLocation;
}

export const EMPTY_CANDIDATE: CandidateProfile = Object.freeze({
  seniorities: [],
  stack: [],
  location: Object.freeze({ city: null, remoteOk: false }),
});

/** Only what the derivation reads from a direction. */
export interface CandidateDirection {
  label: string;
  searchTerms: readonly string[];
}

/**
 * Years-of-experience phrasing in English, Spanish and German — the languages
 * the CVs arrive in. Matches "7 years", "5+ years", "8 años", "6 Jahre(n)".
 */
const YEARS = /(\d{1,2})\s*\+?\s*(?:years?|yrs?|años|anos|jahre?n?)\b/giu;

/**
 * Years → rung, conservatively. Only the two ends of the ladder are mapped:
 * ≥ 5 stated years reads as senior, ≤ 1 as junior. Everything in between is
 * the unlabelled middle that titles rarely name either, and guessing a rung
 * there would invent a fact — so it stays null.
 */
export const SENIOR_MIN_YEARS = 5;
export const JUNIOR_MAX_YEARS = 1;

/** Largest "N years" figure stated anywhere in the skills, or null. */
export function statedYears(skills: readonly Skill[]): number | null {
  let max: number | null = null;
  for (const s of skills) {
    for (const text of [s.text, s.quote]) {
      for (const m of text.matchAll(YEARS)) {
        const n = Number(m[1]);
        if (Number.isFinite(n) && (max === null || n > max)) max = n;
      }
    }
  }
  return max;
}

export function deriveCandidateProfile(input: {
  skills: readonly Skill[];
  directions: readonly CandidateDirection[];
  location?: UserLocation;
}): CandidateProfile {
  const fromDirections = new Set<Seniority>();
  for (const d of input.directions) {
    for (const text of [d.label, ...d.searchTerms]) {
      const s = readSeniority(text);
      if (s) fromDirections.add(s);
    }
  }

  let seniorities: Seniority[] = [...fromDirections];
  if (seniorities.length === 0) {
    const years = statedYears(input.skills);
    if (years !== null && years >= SENIOR_MIN_YEARS) seniorities = ['senior'];
    else if (years !== null && years <= JUNIOR_MAX_YEARS) seniorities = ['junior'];
  }

  const stack = new Set<string>();
  const texts = [
    ...input.skills.flatMap((s) => [s.text, s.quote]),
    ...input.directions.flatMap((d) => [d.label, ...d.searchTerms]),
  ];
  for (const t of texts) for (const tech of readStack(t)) stack.add(tech);

  return {
    seniorities,
    stack: [...stack],
    location: input.location ?? EMPTY_CANDIDATE.location,
  };
}
