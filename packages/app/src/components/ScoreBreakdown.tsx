import { DEFAULT_CALIBRATION, type ScoreBreakdown as Breakdown } from '@job-digest/core';
import styles from './ScoreBreakdown.module.css';

/**
 * Table view of one ad's score — the five weighted components that add up to
 * the "56%" in the header. Explains why a match is what it is: the same
 * calibration constants used at ranking time, rendered in place so the user
 * can trace a low score to a specific component (usually a low
 * `signalCompleteness` when the alert email didn't quote Pay or Onsite).
 */
const LABELS: Record<keyof Omit<Breakdown, 'total'>, string> = {
  directionFit: 'Direction',
  ruleMargin: 'Rules',
  freshness: 'Freshness',
  sourceQuality: 'Source',
  signalCompleteness: 'Signal',
};

/**
 * One-sentence explanations of what each component measures — surfaced as
 * tooltips on the label. Kept short and jargon-free: the goal is to answer
 * "what is this counting?" at a glance, not to reproduce ADR-003 §2.4.
 */
const TOOLTIPS: Record<keyof Omit<Breakdown, 'total'>, string> = {
  directionFit:
    "How well the ad's job title matches the roles you told us to look for (Profile → Role discovery). Full-phrase match = 1.0; long single-word match = 0.6.",
  ruleMargin:
    'How far the ad clears your rules — not pass/fail, but the margin above the floor. Averaged across the five rules (Pay, Onsite, German, Shift, Contract).',
  freshness:
    'How recently the ad arrived. Day 0 = 1.0, day 7 = 0.4. Older ads decay linearly.',
  sourceQuality:
    'Per-platform prior. API-sourced platforms (Greenhouse / Lever / Ashby / Personio) = 1.0; alert-email platforms (LinkedIn / Xing / StepStone) = 0.6.',
  signalCompleteness:
    "Fraction of the facts your rules consult that we could actually read from the ad. Low signal usually means the alert email didn't quote pay or remote policy.",
};

/** Ordered top-down by weight — highest contribution first. */
const ORDER: (keyof typeof LABELS)[] = [
  'directionFit',
  'ruleMargin',
  'freshness',
  'sourceQuality',
  'signalCompleteness',
];

function fmt(n: number): string {
  return n.toFixed(2);
}

export function ScoreBreakdown({ breakdown }: { breakdown: Breakdown }) {
  const weights = DEFAULT_CALIBRATION.weights;
  return (
    <div>
      <p className={styles.label}>Score breakdown</p>
      <div className={styles.table} role="table">
        {ORDER.map((k) => {
          const value = breakdown[k];
          const weight = weights[k];
          const points = Math.round(value * weight * 100);
          return (
            <div key={k} className={styles.row} role="row">
              <span
                className={styles.component}
                data-tooltip={TOOLTIPS[k]}
                tabIndex={0}
              >
                {LABELS[k]}
              </span>
              <span className={styles.calc}>
                {fmt(value)} × {fmt(weight)}
              </span>
              <span className={styles.points}>{points}</span>
            </div>
          );
        })}
        <div className={`${styles.row} ${styles.totalRow}`} role="row">
          <span className={styles.component}>Total</span>
          <span className={styles.calc} />
          <span className={styles.points}>{breakdown.total}</span>
        </div>
      </div>
    </div>
  );
}
