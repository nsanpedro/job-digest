import type { Ruleset } from './types';

/**
 * Mirrors the prototype's DEFAULT_CFG (Job Digest.dc.html) exactly. Used as
 * the starting point for a first-time Profile visit and by the dev seed
 * script — one canonical default instead of two copies drifting apart.
 */
export const DEFAULT_RULESET: Ruleset = {
  Shift: { key: 'Shift', severity: 'hard', condition: { noRotating: true, noWeekend: true } },
  German: { key: 'German', severity: 'preference', condition: { maxDemanded: 'B2' } },
  Onsite: { key: 'Onsite', severity: 'preference', condition: { minHomeDays: 2 } },
  Pay: { key: 'Pay', severity: 'hard', condition: { minMonthly: 2600, basis: 'fte' } },
  Contract: { key: 'Contract', severity: 'preference', condition: { permanentOnly: true } },
};

export type OnboardingCategory =
  | 'Product'
  | 'Design'
  | 'Engineering'
  | 'Marketing'
  | 'Data'
  | 'Operations'
  | 'Sales'
  | 'Other';

const PAY_FLOOR: Record<OnboardingCategory, number> = {
  Engineering: 3500,
  Product: 3200,
  Data: 3200,
  Design: 2800,
  Marketing: 2600,
  Sales: 2600,
  Operations: 2600,
  Other: 2600,
};

const HOME_DAYS: Record<OnboardingCategory, number> = {
  Engineering: 3,
  Data: 3,
  Product: 2,
  Design: 2,
  Marketing: 2,
  Operations: 2,
  Sales: 1,
  Other: 2,
};

/**
 * Category-specific ruleset for onboarding. Adjusts pay floor and preferred
 * home-office days by role family.
 *
 * Non-DACH markets get German rule set to C2 (effectively a no-op — nothing
 * will ever demand above that ceiling). The slot stays so Profile shows a
 * consistent UI regardless of market, and a future Language rule refactor
 * has a clean migration path.
 */
export function rulesetForCategory(
  category: OnboardingCategory,
  market: 'DACH' | 'other',
): Ruleset {
  return {
    Shift: { key: 'Shift', severity: 'hard', condition: { noRotating: true, noWeekend: true } },
    German: {
      key: 'German',
      severity: 'preference',
      condition: { maxDemanded: market === 'DACH' ? 'B2' : 'C2' },
    },
    Onsite: {
      key: 'Onsite',
      severity: 'preference',
      condition: { minHomeDays: HOME_DAYS[category] },
    },
    Pay: {
      key: 'Pay',
      severity: 'hard',
      condition: { minMonthly: PAY_FLOOR[category], basis: 'fte' },
    },
    Contract: { key: 'Contract', severity: 'preference', condition: { permanentOnly: true } },
  };
}
