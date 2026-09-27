import type { ScoreBreakdown as Breakdown } from '@job-digest/core';
import styles from './ScoreBreakdown.module.css';

/**
 * Table view of one ad's score — the weighted components that add up to
 * the "56%" in the header. Explains why a match is what it is: the same
 * calibration constants used at ranking time, rendered in place so the user
 * can trace a low score to a specific component (usually a low
 * `signalCompleteness` when the alert email didn't quote Pay or Onsite).
 */
const LABELS: Record<keyof Breakdown['weights'], string> = {
  directionFit: 'Direction',
  ruleMargin: 'Rules',
  freshness: 'Freshness',
  sourceQuality: 'Source',
  signalCompleteness: 'Signal',
  seniorityFit: 'Seniority',
  stackFit: 'Stack',
};

/**
 * One-sentence explanations of what each component measures — surfaced as
 * tooltips on the label. Kept short and jargon-free: the goal is to answer
 * "what is this counting?" at a glance, not to reproduce ADR-003 §2.4.
 */
const TOOLTIPS: Record<keyof Breakdown['weights'], string> = {
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
  seniorityFit:
    'How the level in the title (Junior, Senior, Lead…) compares to the level your CV and directions aim at. Same level = 1.0, one step up = 0.6, one step down = 0.4. "—" when either side names no level.',
  stackFit:
    'Share of the technologies the title names that your CV or directions name too. "—" when the title names none.',
};

/** Ordered top-down by weight — highest contribution first. */
const ORDER: (keyof typeof LABELS)[] = [
  'directionFit',
  'ruleMargin',
  'freshness',
  'seniorityFit',
  'sourceQuality',
  'signalCompleteness',
  'stackFit',
];

function fmt(n: number): string {
  return n.toFixed(2);
}

export function ScoreBreakdown({ breakdown }: { breakdown: Breakdown }) {
  // The weights the total was actually computed with — a component without
  // signal handed its share to the others, so the rows add up to the total.
  const weights = breakdown.weights;
  return (
    <div>
      <p className={styles.label}>Score breakdown</p>
      <div className={styles.table} role="table">
        {ORDER.map((k) => {
          const value = breakdown[k];
          const weight = weights[k];
          // A component with no signal (null) isn't scored: its weight went
          // to the others, so it contributes nothing and shows a dash.
          const points = value === null ? null : Math.round(value * weight * 100);
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
                {value === null ? 'no signal' : `${fmt(value)} × ${fmt(weight)}`}
              </span>
              <span className={styles.points}>{points ?? '—'}</span>
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
