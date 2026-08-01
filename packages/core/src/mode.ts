/**
 * Search modes (design §7.7) — a pure transform on the ruleset, applied at
 * read time.
 *
 * The whole feature is this file plus a column, and that is the point: I6
 * already says evaluation is a pure function of (facts, ruleset) computed on
 * read, so a mode that produces a different ruleset needs no re-parse, no
 * migration, and no invalidation. Switching modes is reversible in one click
 * because nothing downstream was ever persisted.
 */
import { RULE_KEYS, type Rule, type RuleKey, type Ruleset } from './types';

/**
 * `steady`: the saved severities apply as authored — the default, and the
 * register the product was designed around (fifteen minutes a week).
 * `urgent`: nothing is filtered out; what does not fit is flagged instead.
 */
export const MODES = ['steady', 'urgent'] as const;
export type Mode = (typeof MODES)[number];

export const DEFAULT_MODE: Mode = 'steady';

export function isMode(value: unknown): value is Mode {
  return typeof value === 'string' && (MODES as readonly string[]).includes(value);
}

/** One sentence per mode — the §7.2 test for whether a rule concept is admissible. */
export const MODE_COPY: Record<Mode, { label: string; blurb: string }> = {
  steady: {
    label: 'Steady',
    blurb: 'Your hard rules filter. Ads that fail one are held back in "Filtered out".',
  },
  urgent: {
    label: 'Urgent',
    blurb: 'Nothing is held back. Ads that fail a hard rule are listed anyway, flagged with what they fail.',
  },
};

function demote<K extends RuleKey>(rule: Rule<K>): Rule<K> {
  return rule.severity === 'preference' ? rule : { ...rule, severity: 'preference' };
}

/**
 * Urgent mode demotes every hard rule to a preference. Since `block` is
 * reachable only through `severity === 'hard'` (evaluate.ts), that is exactly
 * "nothing is filtered, everything is flagged" — expressed as a severity
 * change rather than as a filter bypass, so the explanation tree still
 * reports which rules the ad fails and why.
 *
 * Thresholds are deliberately untouched. Widening a €2.600 floor by some
 * percentage would be an invented number the system has no basis for; the
 * floor belongs to the user. The severity change needs no invented number and
 * renders as one sentence of English, which is §7.2's admissibility test.
 *
 * Written key by key rather than mapped over RULE_KEYS: the mapped type
 * `{ [K in RuleKey]: Rule<K> }` cannot be rebuilt from a loop without a cast,
 * and a cast here would silently survive a sixth rule key being added. This
 * way that addition is a compile error, which is what it should be.
 */
export function applyMode(saved: Ruleset, mode: Mode): Ruleset {
  if (mode === 'steady') return saved;
  return {
    Shift: demote(saved.Shift),
    German: demote(saved.German),
    Onsite: demote(saved.Onsite),
    Pay: demote(saved.Pay),
    Contract: demote(saved.Contract),
  };
}

/** Which rules a mode is currently changing — drives the Profile preview copy. */
export function rulesAffectedByMode(saved: Ruleset, mode: Mode): RuleKey[] {
  if (mode === 'steady') return [];
  return RULE_KEYS.filter((key) => saved[key].severity === 'hard');
}
