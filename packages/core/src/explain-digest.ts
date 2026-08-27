/**
 * Auto-generated diagnostic for the weekly digest header.
 *
 * When the curated tiers (Top + Read + Stretch) come up short, the app used
 * to just render empty tiers — a user seeing 2 ads out of 300 had no way to
 * tell whether the algorithm was working correctly on a thin corpus or
 * silently rejecting good matches. This function turns the same data the
 * digest already computed into three short, actionable observations.
 *
 * Pure: same inputs → same output. No i18n yet; matches the rest of the
 * app's copy language (English).
 */
import type { RuleKey, Verdict } from './types';

/** Minimal shape from a rule-blocked ad — what this function actually consults. */
export interface BlockedAdSummary {
  /** Verdicts on the ad; only `state === 'block'` are consulted. */
  blockers: readonly Verdict[];
}

export interface DiagnosticInput {
  /** Ads that made it into the curated tiers (Top + Read + Stretch). */
  inDigest: number;
  /** Total ads considered this week (after DISTINCT, before any filter). */
  adsReceived: number;
  /** Ads scored below the tier thresholds. */
  belowThreshold: number;
  /** Ads that failed a pre-filter (location / direction) before scoring. */
  preFilterMisses: number;
  /** All rule-blocked ads, so we can attribute counts per rule. */
  ruleBlocked: readonly BlockedAdSummary[];
}

export type InsightKind =
  | 'rule-blocked'
  | 'pre-filter-miss'
  | 'below-threshold'
  | 'healthy';

export interface Insight {
  kind: InsightKind;
  /** Short human-readable line. English, matches the rest of the app copy. */
  message: string;
  /** Optional call to action label + hint. UI decides where to link. */
  action?: { label: string; hint: string };
}

/**
 * Threshold below which the diagnostic block renders at all. Above it the
 * digest is considered healthy — three or more curated ads is enough for
 * the user to work with, and a diagnostic on a full week would just add
 * noise.
 */
export const DIAGNOSTIC_MIN_CURATED = 3;

/**
 * The rule that blocked the most ads this week, and how many it blocked.
 * `null` when no ad was rule-blocked. When two rules tie, the first in
 * RULE_KEYS order wins — arbitrary but stable across renders.
 */
function topBlockingRule(
  ruleBlocked: readonly BlockedAdSummary[],
): { rule: RuleKey; count: number } | null {
  const counts = new Map<RuleKey, number>();
  for (const ad of ruleBlocked) {
    for (const v of ad.blockers) {
      if (v.state !== 'block') continue;
      counts.set(v.key, (counts.get(v.key) ?? 0) + 1);
    }
  }
  let best: { rule: RuleKey; count: number } | null = null;
  for (const [rule, count] of counts) {
    if (!best || count > best.count) best = { rule, count };
  }
  return best;
}

export function explainDigest(input: DiagnosticInput): Insight[] {
  // Above the floor: don't render anything. The digest speaks for itself.
  if (input.inDigest >= DIAGNOSTIC_MIN_CURATED) {
    return [];
  }

  const insights: Insight[] = [];

  // Rule blocks are the highest-signal explanation: an ad the user could
  // have seen, kept out by a rule the user themselves wrote. Naming the
  // rule and the count makes the trade-off concrete.
  const topRule = topBlockingRule(input.ruleBlocked);
  if (topRule && topRule.count >= 3) {
    insights.push({
      kind: 'rule-blocked',
      message: `${topRule.count} ads were blocked by your ${topRule.rule} rule. Some may have matched otherwise.`,
      action: {
        label: 'Review rules',
        hint: 'Loosen this rule, or enable urgent mode to see them anyway.',
      },
    });
  }

  // Pre-filter misses (location / direction) usually mean the corpus is
  // pointed the wrong way — often more actionable via profile than via
  // rules.
  if (input.preFilterMisses > 0 && input.preFilterMisses >= input.adsReceived * 0.5) {
    insights.push({
      kind: 'pre-filter-miss',
      message: `${input.preFilterMisses} ads didn't match your location or directions.`,
      action: {
        label: 'Adjust profile',
        hint: 'Add a direction or broaden your location to widen the pool.',
      },
    });
  }

  // Below-threshold means ads passed the filters but scored under the tier
  // floors — the corpus is on-target but weak. Different action than the
  // two above.
  if (input.belowThreshold > 0 && insights.length < 2) {
    insights.push({
      kind: 'below-threshold',
      message: `${input.belowThreshold} ads matched your filters but scored below the curated threshold.`,
      action: {
        label: 'See explore',
        hint: 'The explore bucket shows them, ranked.',
      },
    });
  }

  // Nothing to say. The digest is thin but the algorithm has no actionable
  // observation — surface that explicitly rather than showing empty space.
  if (insights.length === 0) {
    insights.push({
      kind: 'healthy',
      message: 'A short week — few ads met your criteria. Nothing to adjust.',
    });
  }

  return insights;
}
