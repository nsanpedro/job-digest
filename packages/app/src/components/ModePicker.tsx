'use client';

import { useOptimistic, useTransition } from 'react';
import { MODES, MODE_COPY, rulesAffectedByMode, type Mode, type Ruleset } from '@job-digest/core';
import { setMode } from '@/lib/actions';
import styles from './ModePicker.module.css';

/**
 * The two registers of a job search (design §7.7). Switching is instant and
 * reversible because a mode is a read-time transform, not a rewrite — nothing
 * is re-parsed and no saved rule is touched.
 *
 * The copy states what the mode does to the rules the user actually authored,
 * naming them, rather than describing the feature in the abstract: the whole
 * claim of the rule engine is that the user can see why the list looks the way
 * it does.
 */
export function ModePicker({ mode, rules }: { mode: Mode; rules: Ruleset }) {
  const [, startTransition] = useTransition();
  // Switching mode flips every rule chip on the page beneath this one — the
  // whole point of this control — so an instant pill swap here matters more
  // than most (design: perf pass, Aug 2026).
  const [optimisticMode, setOptimisticMode] = useOptimistic(mode);
  const affected = rulesAffectedByMode(rules, 'urgent');

  return (
    <div className={styles.card}>
      <div className={styles.pills}>
        {MODES.map((m) => (
          <button
            key={m}
            type="button"
            className={`${styles.pill} ${m === optimisticMode ? styles.pillActive : ''}`}
            onClick={() =>
              startTransition(async () => {
                setOptimisticMode(m);
                await setMode(m);
              })
            }
          >
            {MODE_COPY[m].label}
          </button>
        ))}
      </div>

      <p className={styles.blurb}>{MODE_COPY[optimisticMode].blurb}</p>

      <p className={styles.effect}>
        {affected.length === 0
          ? 'No rule is set to hard right now, so both modes currently show the same list.'
          : optimisticMode === 'urgent'
            ? `${affected.join(' and ')} ${affected.length === 1 ? 'is' : 'are'} hard, and not filtering while urgent is on. Your thresholds are unchanged.`
            : `${affected.join(' and ')} ${affected.length === 1 ? 'is' : 'are'} hard, so ${affected.length === 1 ? 'it filters' : 'they filter'} ads out. Urgent would list those anyway, flagged.`}
      </p>
    </div>
  );
}
