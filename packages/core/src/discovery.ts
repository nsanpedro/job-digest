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
import { verifyQuote } from './verify-quote';

/** At most this many directions are ever returned — zero is a valid, correct answer (ADR-001 §3). */
export const MAX_DIRECTIONS = 3;

/** A direction needs at least this many verified bridging skills to be shown at all (I17). */
export const MIN_BRIDGE_SKILLS = 2;

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
  /** German, as typed into a platform search. */
  searchTerms: string[];
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
  kind: 'skill' | 'direction';
  /** The skill's `text` or the direction's `label`, whichever was dropped. */
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
          distance: { type: 'string', enum: ['adjacent', 'stretch'] },
          seenTitles: { type: 'array', items: { type: 'string' } },
        },
        required: ['label', 'bridge', 'rationale', 'searchTerms', 'distance', 'seenTitles'],
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

  return {
    label: r.label,
    bridge,
    rationale: r.rationale,
    searchTerms: r.searchTerms,
    distance: r.distance,
    seenTitles,
  };
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

  const directions = allDirections.slice(0, MAX_DIRECTIONS);
  for (const excess of allDirections.slice(MAX_DIRECTIONS)) {
    dropped.push({ kind: 'direction', label: excess.label, reason: `exceeded the ${MAX_DIRECTIONS}-direction cap` });
  }

  return { skills, directions, dropped };
}
