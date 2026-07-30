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
