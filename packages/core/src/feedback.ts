/**
 * Dismiss reasons as explicit feedback (ADR-003 §8.11 "Dismiss reasons as
 * explicit feedback").
 *
 * When the user dismisses an ad they may say why, from a closed set. Each
 * reason maps to at most one deterministic effect the user can see and undo
 * — never to a learned weight (ADR-003 §2.5 rejected those at N=1):
 *
 *   - `company`     → mute the company: its ads go to Explore, unscored.
 *   - `wrong_role`  → propose an exclude term for the direction(s) the title
 *                     matched; saved only when the user picks one.
 *   - `wrong_level` → no new mechanism: the level gate (`isBelowTargetLevel`)
 *                     already covers entry-level titles for a senior-or-above
 *                     target; everything else is recorded only.
 *   - `location`, `other` → recorded only (labels for the ranking eval).
 *
 * Everything here is pure. The database stores the reason
 * (`ad_user_state.dismiss_reason`) and each saved effect as a timestamped
 * row (`feedback_effects`), which is what lets the ranking eval replay a
 * week with only the effects that existed before it started.
 */
import { isBelowTargetLevel, type CandidateProfile } from './candidate';
import type { Distance } from './discovery';
import { explainMatch } from './explain-match';
import { normalizeRoleSpelling, tokenize } from './matching';
import { readSeniority } from './title-lexicon';

// ── Reasons ──────────────────────────────────────────────────────────────────

/** Closed set, like `application_status`: each value has authored copy. */
export const DISMISS_REASONS = ['wrong_role', 'wrong_level', 'location', 'company', 'other'] as const;
export type DismissReason = (typeof DISMISS_REASONS)[number];

/** Button labels — short, the way the rest of the action bar reads. */
export const DISMISS_REASON_LABEL: Readonly<Record<DismissReason, string>> = {
  wrong_role: 'Wrong role',
  wrong_level: 'Wrong level',
  location: 'Location',
  company: 'Company',
  other: 'Other',
};

export function isDismissReason(value: unknown): value is DismissReason {
  return typeof value === 'string' && (DISMISS_REASONS as readonly string[]).includes(value);
}

// ── Stored effects ───────────────────────────────────────────────────────────

export type FeedbackEffectKind = 'mute_company' | 'exclude_term';

/** One saved effect of a dismiss reason — a row in `feedback_effects`. */
export interface FeedbackEffect {
  kind: FeedbackEffectKind;
  /** Set for `exclude_term` (which direction got the term); null for a mute. */
  directionId: string | null;
  /** Company name as the ad spelled it, or the exclude term as saved. */
  value: string;
  /** `companyKey(value)` for a mute; the lowercased term for an exclude. */
  valueKey: string;
  createdAt: Date;
}

/**
 * The temporal split the ranking eval needs: only effects that existed
 * strictly before `cutoff` (the replayed week's start). A dismissal made
 * during the week is a label for that week; letting its effect rank the
 * same week would grade the ranking on its own answer key.
 */
export function effectsBefore<T extends { createdAt: Date }>(effects: readonly T[], cutoff: Date): T[] {
  return effects.filter((e) => e.createdAt.getTime() < cutoff.getTime());
}

/**
 * True when an ad's dismissal predates `cutoff`. The eval leaves such ads
 * unlabelled for a week that starts after it: the product had already moved
 * them aside, and with feedback on, the dismissal that created a mute would
 * otherwise grade that same mute in every later week.
 */
export function dismissedBefore(dismissedAt: Date | null | undefined, cutoff: Date): boolean {
  return dismissedAt != null && dismissedAt.getTime() < cutoff.getTime();
}

// ── Company mute ─────────────────────────────────────────────────────────────

/**
 * Trailing legal-form tokens stripped from a company name, so "Acme GmbH",
 * "ACME GmbH & Co. KG" and "Acme" mute together. Trailing only: a legal
 * form in the middle of a name is part of the name. "Group" / "Gruppe" stay
 * — "Acme" and "Acme Group" can be different employers.
 */
const LEGAL_FORM_TOKENS: ReadonlySet<string> = new Set([
  'gmbh', 'mbh', 'ag', 'se', 'kg', 'kgaa', 'ohg', 'ug', 'haftungsbeschrankt', 'ev', 'co',
  'inc', 'llc', 'llp', 'ltd', 'limited', 'plc', 'corp', 'corporation', 'company',
  'sa', 'sl', 'slu', 'srl', 'sas', 'sarl', 'spa', 'bv', 'nv', 'ab', 'as', 'asa', 'oy', 'aps',
]);

/**
 * The key a mute is stored and compared under. Lowercase, diacritics folded,
 * punctuation to spaces, trailing legal forms dropped. Null for a missing or
 * empty name — an ad without a company cannot be muted.
 */
export function companyKey(name: string | null | undefined): string | null {
  if (!name) return null;
  const words = name
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/&/g, ' ')
    // "e.V." and "S.A." lose their dots first, so they read as one token.
    .replace(/\b(\p{L})\.(?=\p{L}\.)/gu, '$1')
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
  if (words.length === 0) return null;
  const kept = [...words];
  while (kept.length > 1 && LEGAL_FORM_TOKENS.has(kept[kept.length - 1]!)) kept.pop();
  return kept.join(' ');
}

/** The set of muted company keys among `effects`. */
export function mutedCompanyKeys(effects: readonly Pick<FeedbackEffect, 'kind' | 'valueKey'>[]): Set<string> {
  return new Set(effects.filter((e) => e.kind === 'mute_company').map((e) => e.valueKey));
}

export function isMutedCompany(company: string | null | undefined, muted: ReadonlySet<string>): boolean {
  if (muted.size === 0) return false;
  const key = companyKey(company);
  return key !== null && muted.has(key);
}

// ── Exclude terms ────────────────────────────────────────────────────────────

/** What the exclude suggestion reads from a direction. Same fields `explainMatch` takes, plus the id. */
export interface FeedbackDirection {
  id: string;
  label: string;
  distance: Distance;
  searchTerms: readonly string[];
  excludeTerms: readonly string[];
}

export interface ExcludeSuggestion {
  /** Every direction the title matched — the term is added to each, or the ad still passes on the other. */
  directions: Array<{ id: string; label: string }>;
  /** Candidate terms, most specific first. Never empty. */
  terms: string[];
}

/**
 * Words in a title that say nothing about the role: gender markers,
 * contract and workplace boilerplate. Seniority words are dropped separately
 * (via the lexicon) — level is its own reason, `wrong_level`.
 */
const NOISE_WORDS: ReadonlySet<string> = new Set([
  'all', 'gender', 'genders', 'divers', 'diverse', 'mwd', 'wmd', 'mfd', 'fmd', 'mfx', 'mfdx',
  'remote', 'hybrid', 'onsite', 'office', 'home', 'homeoffice',
  'vollzeit', 'teilzeit', 'fulltime', 'parttime', 'full', 'part', 'time',
  'befristet', 'unbefristet', 'permanent',
  'job', 'jobs', 'stelle', 'position', 'role', 'new', 'neu', 'head',
]);

const REGEX_META = /[.*+?^${}()|[\]\\]/g;

/**
 * Word-boundary hit of `term` in `text`, with the same spelling pre-pass and
 * regex the exclude gate uses (explain-match.ts `findExcludeHit`,
 * curation.ts `hasExcludeHit`) — so "would this exclude fire here?" has one
 * answer everywhere.
 */
function excludeHits(text: string, term: string): boolean {
  const escaped = normalizeRoleSpelling(term.toLowerCase()).replace(REGEX_META, '\\$&');
  return new RegExp(`\\b${escaped}\\b`, 'iu').test(normalizeRoleSpelling(text.toLowerCase()));
}

/** Title words as the matcher sees them, split once more on any leftover punctuation. */
function titleWords(title: string): string[] {
  const out: string[] = [];
  for (const token of tokenize(title)) {
    for (const w of token.split(/[^\p{L}\p{N}]+/u)) {
      if (w.length >= 3 && !out.includes(w)) out.push(w);
    }
  }
  return out;
}

/**
 * `wrong_role` → which word in this title to exclude, and from which
 * direction(s). Null when there is nothing honest to propose: the title
 * matched none of the directions (nothing to exclude it from), or every
 * word is already covered, generic, or about level.
 *
 * A candidate word must:
 *   - not be covered by the user's directions — it appears (at a word
 *     boundary, the exclude gate's own rule) in no direction's label or
 *     search terms. Excluding a word a direction searches for would drop
 *     that direction's own matches;
 *   - not be about the level (the lexicon's seniority markers), the company
 *     or the location line, or title boilerplate (NOISE_WORDS);
 *   - actually fire: with the term added, every matched direction reads
 *     `excluded` for this title.
 *
 * "Most specific first": longer words first (a long word is a rarer word —
 * "partnerships" says more than "sales"), ties in title order. There is no
 * corpus frequency here on purpose: the proposal has to be explainable from
 * the title alone. At most `max` terms; the user picks one or none.
 */
export function suggestExcludeTerms(
  ad: { title: string; company?: string | null; location?: string | null },
  directions: readonly FeedbackDirection[],
  max = 3,
): ExcludeSuggestion | null {
  const explanations = explainMatch(ad.title, null, directions);
  const matched = directions.filter((_, i) => explanations[i]!.kind === 'matched');
  if (matched.length === 0) return null;

  const covered = directions.flatMap((d) => [d.label, ...d.searchTerms]);
  const context = new Set([
    ...(ad.company ? tokenize(ad.company) : []),
    ...(ad.location ? tokenize(ad.location) : []),
  ]);

  const words = titleWords(ad.title);
  const candidates = words.filter(
    (w) =>
      !/^\p{N}+$/u.test(w) &&
      !NOISE_WORDS.has(w) &&
      !context.has(w) &&
      readSeniority(w) === null &&
      !covered.some((text) => excludeHits(text, w)) &&
      explainMatch(
        ad.title,
        null,
        matched.map((d) => ({ ...d, excludeTerms: [...d.excludeTerms, w] })),
      ).every((e) => e.kind === 'excluded'),
  );
  if (candidates.length === 0) return null;

  const position = new Map(words.map((w, i) => [w, i]));
  const terms = [...candidates]
    .sort((a, b) => b.length - a.length || position.get(a)! - position.get(b)!)
    .slice(0, max);
  return { directions: matched.map((d) => ({ id: d.id, label: d.label })), terms };
}

/**
 * Directions with the saved exclude effects applied — the eval's way of
 * replaying "the directions as they stood at the week's start". Terms are
 * compared lowercased; a term already present is not added twice.
 */
export function withExcludeEffects<D extends { id: string; excludeTerms: readonly string[] }>(
  directions: readonly D[],
  effects: readonly Pick<FeedbackEffect, 'kind' | 'directionId' | 'value' | 'valueKey'>[],
): D[] {
  return directions.map((d) => {
    const add = effects.filter((e) => e.kind === 'exclude_term' && e.directionId === d.id);
    if (add.length === 0) return d;
    const have = new Set(d.excludeTerms.map((t) => t.trim().toLowerCase()));
    const next = [...d.excludeTerms];
    for (const e of add) {
      if (!have.has(e.valueKey)) {
        next.push(e.value);
        have.add(e.valueKey);
      }
    }
    return { ...d, excludeTerms: next } as D;
  });
}

/**
 * Directions with every exclude that came from a dismissal taken back out —
 * the pipeline as it would be without this feature. The stored directions
 * already carry the confirmed terms, so the eval's baseline needs them
 * removed, or every variant would inherit the feedback's effect.
 */
export function withoutExcludeEffects<D extends { id: string; excludeTerms: readonly string[] }>(
  directions: readonly D[],
  effects: readonly Pick<FeedbackEffect, 'kind' | 'directionId' | 'valueKey'>[],
): D[] {
  return directions.map((d) => {
    const drop = new Set(
      effects.filter((e) => e.kind === 'exclude_term' && e.directionId === d.id).map((e) => e.valueKey),
    );
    if (drop.size === 0) return d;
    return { ...d, excludeTerms: d.excludeTerms.filter((t) => !drop.has(t.trim().toLowerCase())) } as D;
  });
}

// ── Level ────────────────────────────────────────────────────────────────────

/**
 * `wrong_level` adds no mechanism. What the user is told depends on what the
 * existing level gate (ADR-003 §8.7) does for them:
 *
 *   - `gated`     — the title states the junior rung and they target only
 *                   senior or above: the gate already sends such ads to
 *                   Explore.
 *   - `no_target` — nothing they wrote names a rung, so the gate is off.
 *   - `not_gated` — the gate has nothing to say about this title (it names
 *                   no rung, or names one the gate does not cover). Recorded
 *                   only.
 */
export type LevelFeedback = 'gated' | 'no_target' | 'not_gated';

export function levelFeedback(title: string, candidate: Pick<CandidateProfile, 'seniorities'>): LevelFeedback {
  if (candidate.seniorities.length === 0) return 'no_target';
  return isBelowTargetLevel(title, candidate) ? 'gated' : 'not_gated';
}

// ── What a reason does ───────────────────────────────────────────────────────

/**
 * The outcome of picking a reason, before anything is saved beyond the
 * reason itself — what the dismiss follow-up renders. The server action
 * performs the mute; an exclude is only ever proposed here.
 */
export type DismissFeedback =
  | { kind: 'mute'; company: string; companyKey: string }
  | { kind: 'suggest_exclude'; suggestion: ExcludeSuggestion }
  | { kind: 'level'; level: LevelFeedback }
  | { kind: 'noted' };

export function planDismissFeedback(input: {
  reason: DismissReason;
  ad: { title: string; company: string | null; location: string | null };
  directions: readonly FeedbackDirection[];
  candidate: Pick<CandidateProfile, 'seniorities'>;
}): DismissFeedback {
  const { reason, ad } = input;
  switch (reason) {
    case 'company': {
      const key = companyKey(ad.company);
      return key !== null && ad.company ? { kind: 'mute', company: ad.company.trim(), companyKey: key } : { kind: 'noted' };
    }
    case 'wrong_role': {
      const suggestion = suggestExcludeTerms(ad, input.directions);
      return suggestion ? { kind: 'suggest_exclude', suggestion } : { kind: 'noted' };
    }
    case 'wrong_level':
      return { kind: 'level', level: levelFeedback(ad.title, input.candidate) };
    case 'location':
    case 'other':
      return { kind: 'noted' };
  }
}

/**
 * The stored effect kind a reason owns for its ad, if any. Setting or
 * changing a reason — from the follow-up row, the card's "Dismiss because"
 * strip or the Dismissed list — removes every effect this ad produced except
 * the kind the new reason owns: Company → Location takes the mute back;
 * Wrong role → Company drops a confirmed exclude. Mirrors
 * `planDismissFeedback`: `mute` ↔ `mute_company`, `suggest_exclude` ↔
 * `exclude_term`.
 */
export function effectKindOwnedBy(reason: DismissReason): FeedbackEffectKind | null {
  switch (reason) {
    case 'company':
      return 'mute_company';
    case 'wrong_role':
      return 'exclude_term';
    case 'wrong_level':
    case 'location':
    case 'other':
      return null;
  }
}
