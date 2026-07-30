'use client';

import { useState, useTransition } from 'react';
import { refreshDigest } from '@/lib/actions';
import styles from './RefreshButton.module.css';

type RunState = 'idle' | 'running' | 'done' | 'error';

const VARIANTS: Record<RunState, { bg: string; fg: string; bd: string; dot: string }> = {
  idle: { bg: 'var(--ink)', fg: '#fff', bd: 'var(--ink)', dot: 'oklch(0.75 0.01 260)' },
  running: { bg: '#fff', fg: 'oklch(0.4 0.01 260)', bd: 'oklch(0.85 0.005 260)', dot: 'oklch(0.55 0.09 250)' },
  done: { bg: 'var(--pass-bg)', fg: 'var(--pass-fg)', bd: 'var(--pass-bd)', dot: 'oklch(0.55 0.1 152)' },
  error: { bg: '#fff', fg: 'oklch(0.44 0.11 25)', bd: 'oklch(0.83 0.06 25)', dot: 'oklch(0.55 0.15 25)' },
};

export function RefreshButton() {
  const [state, setState] = useState<RunState>('idle');
  const [errorDetail, setErrorDetail] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const label =
    state === 'idle' ? 'Update now'
    : state === 'running' ? 'Reading the inbox…'
    : state === 'done' ? 'Up to date — just now'
    : 'Retry';

  const v = VARIANTS[state];

  function run() {
    setState('running');
    setErrorDetail(null);
    startTransition(async () => {
      try {
        await refreshDigest();
        setState('done');
      } catch (err) {
        setState('error');
        setErrorDetail(err instanceof Error ? err.message : 'Something went wrong reading the inbox.');
      }
    });
  }

  return (
    <div className={styles.col}>
      <button
        type="button"
        className={styles.btn}
        style={{ background: v.bg, color: v.fg, borderColor: v.bd }}
        disabled={pending}
        onClick={run}
      >
        <span
          className={`${styles.dot} ${state === 'running' ? styles.dotPulse : ''}`}
          style={{ background: v.dot }}
        />
        {label}
      </button>
      {state === 'error' && errorDetail && <p className={styles.error}>{errorDetail}</p>}
    </div>
  );
}
