/**
 * Role discovery from a CV (docs/adr-001-role-discovery.md). Pure contract:
 * the shape the model must produce, the JSON Schema that constrains it via
 * `output_config.format`, and the validator that re-checks it — never
 * trusting the schema alone, the same discipline `evaluate.ts` and
 * `title-facts.ts` already apply to their own inputs.
 *
 * Two invariants (ADR-001 §2.7), both enforced here, not left to the prompt:
 *
 * I17 — A suggested direction must name the user's own skills that bridge to
 * it, each a verified span of the user's own text. The role label is an
 * inference the system cannot prove; the premises are not — so a direction
 * is only shown once it can point at ≥2 skills whose quotes actually appear
 * in the CV (`MIN_BRIDGE_SKILLS`).
 *
 * I18 — The system never claims a labour-market fact it cannot count. This
 * module doesn't render copy, but it is what makes I18 enforceable
 * downstream: `seenTitles` may only contain titles that were actually passed
 * in as the user's own ad titles, never a title the model merely asserts
 * exists.
 */
import { containsWord, normalizeRoleSpelling, tokenize } from './matching';
import { readSeniority } from './title-lexicon';
import { verifyQuote } from './verify-quote';

/** At most this many directions are ever returned — zero is a valid, correct answer (ADR-001 §3). */
export const MAX_DIRECTIONS = 3;

/** A direction needs at least this many verified bridging skills to be shown at all (I17). */
export const MIN_BRIDGE_SKILLS = 2;

/**
 * At most this many model-proposed exclude terms survive per direction.
 * Excludes are unioned across directions and applied to the title and the
 * description lede (curation.ts `directionFitStrength`), so every extra one
 * is another chance to hide a wanted ad — a short list of clear role
 * families is the point, not coverage.
 */
export const MAX_EXCLUDE_TERMS = 5;

export interface Skill {
  /** Short label, e.g. "5 years of audit preparation". */
  text: string;
  /** Verbatim span of the pasted CV text that grounds `text` (I17). */
  quote: string;
}

export type Distance = 'adjacent' | 'stretch';

export interface Direction {
  label: string;
  /** Skill `text` values from the surviving `skills` list — the premises for this inference. */
  bridge: string[];
  rationale: string;
  /**
   * Role titles in the ad languages of the user's market (`adMarket` in
   * market-language.ts), as typed into a platform search. Also the patterns
   * the matcher reads (`computeMatch`) — ADR-003 §8.13 "Market-language
   * direction terms" records why the two are not split.
   */
  searchTerms: string[];
  /**
   * Role families the user plausibly does not want that share words with
   * `searchTerms` ("account manager" for "Engineering Manager"). Proposed by
   * the model, gated in `parseDerivation` (never a word the user's own
   * directions search for), persisted into `directions.exclude_terms`.
   */
  excludeTerms: string[];
  distance: Distance;
  /** Titles from the user's own ads the model places in this direction — verifiable, never asserted. */
  seenTitles: string[];
}

export interface Derivation {
  skills: Skill[];
  directions: Direction[];
}

/** What was discarded and why — never thrown away silently, so a bad derivation is debuggable. */
export interface DroppedItem {
  kind: 'skill' | 'direction' | 'excludeTerm';
  /** The skill's `text`, the direction's `label`, or the exclude term — whichever was dropped. */
  label: string;
  reason: string;
}

export interface ParsedDerivation extends Derivation {
  dropped: DroppedItem[];
}

/**
 * JSON Schema for `output_config.format` (Claude API structured outputs).
 * Deliberately only basic types + `enum` + `required` + `additionalProperties:
 * false` — the constraint set structured outputs actually supports; nothing
 * here (`minItems`, `minLength`, etc.) that the API would silently strip.
 */
export const DERIVATION_SCHEMA = {
  type: 'object',
  properties: {
    skills: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          text: { type: 'string' },
          quote: { type: 'string' },
        },
        required: ['text', 'quote'],
        additionalProperties: false,
      },
    },
    directions: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          label: { type: 'string' },
          bridge: { type: 'array', items: { type: 'string' } },
          rationale: { type: 'string' },
          searchTerms: { type: 'array', items: { type: 'string' } },
          excludeTerms: { type: 'array', items: { type: 'string' } },
          distance: { type: 'string', enum: ['adjacent', 'stretch'] },
          seenTitles: { type: 'array', items: { type: 'string' } },
        },
        required: ['label', 'bridge', 'rationale', 'searchTerms', 'excludeTerms', 'distance', 'seenTitles'],
        additionalProperties: false,
      },
    },
  },
  required: ['skills', 'directions'],
  additionalProperties: false,
} as const;

function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.trim().length > 0;
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === 'string');
}

/** One raw skill entry, gated on I17: kept only if its quote is a real span of the CV. */
function parseSkill(raw: unknown, cvText: string, dropped: DroppedItem[]): Skill | null {
  if (
    typeof raw !== 'object' ||
    raw === null ||
    !isNonEmptyString((raw as Record<string, unknown>).text) ||
    !isNonEmptyString((raw as Record<string, unknown>).quote)
  ) {
    dropped.push({ kind: 'skill', label: '(malformed)', reason: 'missing text or quote' });
    return null;
  }
  const text = (raw as { text: string }).text.trim();
  const quote = (raw as { quote: string }).quote.trim();
  if (!verifyQuote(quote, cvText)) {
    dropped.push({ kind: 'skill', label: text, reason: 'quote not found in the CV text (I17)' });
    return null;
  }
  return { text, quote };
}

/**
 * One raw direction entry. Gated on: shape, ≥2 verified bridging skills
 * (I17), and `seenTitles` trimmed to only titles the caller actually passed
 * in (I18's enforcement point — see module docstring).
 */
function parseDirection(
  raw: unknown,
  survivingSkillTexts: ReadonlySet<string>,
  knownTitles: ReadonlySet<string>,
  dropped: DroppedItem[],
): Direction | null {
  if (typeof raw !== 'object' || raw === null) {
    dropped.push({ kind: 'direction', label: '(malformed)', reason: 'not an object' });
    return null;
  }
  const r = raw as Record<string, unknown>;
  if (
    !isNonEmptyString(r.label) ||
    !isNonEmptyString(r.rationale) ||
    !isStringArray(r.bridge) ||
    !isStringArray(r.searchTerms) ||
    r.searchTerms.length === 0 ||
    !isStringArray(r.seenTitles) ||
    (r.distance !== 'adjacent' && r.distance !== 'stretch')
  ) {
    dropped.push({
      kind: 'direction',
      label: isNonEmptyString(r.label) ? r.label : '(malformed)',
      reason: 'missing or invalid field (label, rationale, bridge, searchTerms, distance, or seenTitles)',
    });
    return null;
  }

  // I17: only skills that themselves survived the quote gate count as
  // bridges — a direction cannot borrow credibility from a skill that was
  // already dropped for an unverifiable quote.
  const bridge = r.bridge.filter((s) => survivingSkillTexts.has(s));
  if (bridge.length < MIN_BRIDGE_SKILLS) {
    dropped.push({
      kind: 'direction',
      label: r.label,
      reason: `fewer than ${MIN_BRIDGE_SKILLS} verified bridging skills (I17)`,
    });
    return null;
  }

  // I18: a seenTitle the model asserts but that isn't one of the user's own
  // ad titles is not evidence — dropped from the list, not the whole
  // direction, since a direction can still be shown "unserved" with none.
  const seenTitles = r.seenTitles.filter((t) => knownTitles.has(t));

  // Exclude terms are gated later, against every surviving direction (see
  // `gateExcludeTerms`). A missing field reads as none — excludes are an
  // optional refinement, never a reason to lose the direction itself.
  let excludeTerms: string[] = [];
  if (isStringArray(r.excludeTerms)) {
    excludeTerms = r.excludeTerms;
  } else if (r.excludeTerms !== undefined) {
    dropped.push({ kind: 'excludeTerm', label: '(malformed)', reason: `excludeTerms of "${r.label}" was not a list of strings` });
  }

  return {
    label: r.label,
    bridge,
    rationale: r.rationale,
    searchTerms: r.searchTerms,
    excludeTerms,
    distance: r.distance,
    seenTitles,
  };
}

/** Lowercased, spelling-normalised, whitespace-collapsed — the key two excludes are "the same term" under. */
function excludeKey(term: string): string {
  return normalizeRoleSpelling(term.toLowerCase()).replace(/\s+/g, ' ').trim();
}

const REGEX_META = /[.*+?^${}()|[\]\\]/g;

/**
 * Would `exclude` remove an ad titled `text`? True under either reading:
 *
 *   - the exclude gate's own rule — a word-boundary hit after the spelling
 *     pre-pass (curation.ts `hasExcludeHit`, feedback.ts `excludeHits`);
 *   - the matcher's — every token of the exclude is `containsWord` of the
 *     text, synonyms included, so "entwickler" collides with "Software
 *     Engineer" even though the literal regex would not fire.
 *
 * The second reading is stricter than the gate needs. On purpose: a
 * model-proposed exclude that is even a synonym of the user's own search
 * phrase is not one to apply without the user asking.
 */
function excludeCollidesWith(text: string, exclude: string, excludeTokens: readonly string[]): boolean {
  const haystack = normalizeRoleSpelling(text.toLowerCase());
  const escaped = excludeKey(exclude).replace(REGEX_META, '\\$&');
  if (new RegExp(`\\b${escaped}\\b`, 'iu').test(haystack)) return true;
  const textTokens = tokenize(text).join(' ');
  return excludeTokens.length > 0 && excludeTokens.every((w) => containsWord(textTokens, w));
}

/**
 * Gate the model's exclude proposals. Runs after the direction cap, against
 * the directions that will actually be persisted, because excludes are
 * unioned across directions at match time (curation.ts): an exclude saved
 * on one direction also removes ads another direction matched. So an
 * exclude is dropped, and recorded in `dropped`, when it:
 *
 *   1. is empty or a case/spelling duplicate of one already kept;
 *   2. has no token the matcher can read (`tokenize` keeps nothing — "IT",
 *      "QA", "HR"): too short to gate on a word boundary safely;
 *   3. is only seniority words ("Senior", "Junior") — level is the level
 *      gate's job (§8.7), and "junior" in a description lede hits "you will
 *      mentor junior engineers";
 *   4. collides with the label or a search term of ANY kept direction (see
 *      `excludeCollidesWith`) — it would remove that direction's own
 *      matches. Same rule `suggestExcludeTerms` applies to dismissal words;
 *   5. exceeds MAX_EXCLUDE_TERMS for its direction (first ones win — the
 *      model lists the most important first).
 */
function gateExcludeTerms(directions: readonly Direction[], dropped: DroppedItem[]): Direction[] {
  const covered = directions.flatMap((d) => [d.label, ...d.searchTerms].map((text) => ({ text, direction: d.label })));

  return directions.map((d) => {
    const kept: string[] = [];
    const seen = new Set<string>();
    for (const raw of d.excludeTerms) {
      const term = raw.trim().replace(/\s+/g, ' ');
      const key = excludeKey(term);
      if (!key || seen.has(key)) continue;
      const tokens = tokenize(term);
      if (tokens.length === 0) {
        dropped.push({ kind: 'excludeTerm', label: term, reason: `too short to gate on safely (direction "${d.label}")` });
        continue;
      }
      if (tokens.every((t) => readSeniority(t) !== null)) {
        dropped.push({ kind: 'excludeTerm', label: term, reason: `a seniority word, not a role family (direction "${d.label}")` });
        continue;
      }
      const hit = covered.find((c) => excludeCollidesWith(c.text, term, tokens));
      if (hit) {
        dropped.push({
          kind: 'excludeTerm',
          label: term,
          reason: `collides with "${hit.text}" of direction "${hit.direction}" — it would exclude the user's own matches (direction "${d.label}")`,
        });
        continue;
      }
      if (kept.length >= MAX_EXCLUDE_TERMS) {
        dropped.push({ kind: 'excludeTerm', label: term, reason: `exceeded the ${MAX_EXCLUDE_TERMS}-exclude cap (direction "${d.label}")` });
        continue;
      }
      seen.add(key);
      kept.push(term);
    }
    return { ...d, excludeTerms: kept };
  });
}

/**
 * Validate and gate raw model output into a `Derivation`. Never throws — a
 * malformed or empty response degrades to an empty (or partial) result with
 * `dropped` explaining why, the same shape `evaluate.ts` uses for facts that
 * cannot be read rather than treating them as errors.
 *
 * `cvText` and `knownTitles` are the caller's own inputs to the derivation
 * call — passed back in here so every citation gate checks against what was
 * actually sent, not against anything the model might claim.
 */
export function parseDerivation(raw: unknown, cvText: string, knownTitles: readonly string[]): ParsedDerivation {
  const dropped: DroppedItem[] = [];

  if (typeof raw !== 'object' || raw === null) {
    return { skills: [], directions: [], dropped: [{ kind: 'skill', label: '(malformed)', reason: 'response was not an object' }] };
  }
  const r = raw as Record<string, unknown>;
  const rawSkills = Array.isArray(r.skills) ? r.skills : [];
  const rawDirections = Array.isArray(r.directions) ? r.directions : [];

  const skills = rawSkills
    .map((s) => parseSkill(s, cvText, dropped))
    .filter((s): s is Skill => s !== null);

  const survivingSkillTexts = new Set(skills.map((s) => s.text));
  const knownTitleSet = new Set(knownTitles);

  const allDirections = rawDirections
    .map((d) => parseDirection(d, survivingSkillTexts, knownTitleSet, dropped))
    .filter((d): d is Direction => d !== null);

  const capped = allDirections.slice(0, MAX_DIRECTIONS);
  for (const excess of allDirections.slice(MAX_DIRECTIONS)) {
    dropped.push({ kind: 'direction', label: excess.label, reason: `exceeded the ${MAX_DIRECTIONS}-direction cap` });
  }
  const directions = gateExcludeTerms(capped, dropped);

  return { skills, directions, dropped };
}
