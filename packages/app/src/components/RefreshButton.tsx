'use client';

import { useEffect, useRef, useState, useTransition } from 'react';
import { getRunProgress, startRefresh } from '@/lib/actions';
import styles from './RefreshButton.module.css';

type RunState = 'idle' | 'running' | 'done' | 'error';

const VARIANTS: Record<RunState, { bg: string; fg: string; bd: string; dot: string }> = {
  idle: { bg: 'var(--ink)', fg: '#fff', bd: 'var(--ink)', dot: 'oklch(0.75 0.01 260)' },
  running: { bg: '#fff', fg: 'oklch(0.4 0.01 260)', bd: 'oklch(0.85 0.005 260)', dot: 'oklch(0.55 0.09 250)' },
  done: { bg: 'var(--pass-bg)', fg: 'var(--pass-fg)', bd: 'var(--pass-bd)', dot: 'oklch(0.55 0.1 152)' },
  error: { bg: '#fff', fg: 'oklch(0.44 0.11 25)', bd: 'oklch(0.83 0.06 25)', dot: 'oklch(0.55 0.15 25)' },
};

/** How often to poll runs while one is in flight — fast enough to feel live, not a query per frame. */
const POLL_MS = 1000;

/**
 * "Update now" — starts a run (returns almost immediately; the actual fetch
 * runs detached, see startRefresh) and polls its progress while it's in
 * flight. Design §10 specified this as SSE-or-poll against a run-status
 * endpoint; this is the poll half, over a Server Action rather than a REST
 * route, to match how the rest of the app is built.
 */
export function RefreshButton() {
  const [state, setState] = useState<RunState>('idle');
  const [progress, setProgress] = useState<{ processed: number; total: number | null } | null>(null);
  const [errorDetail, setErrorDetail] = useState<string | null>(null);
  const [, startTransition] = useTransition();
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => () => {
    if (pollRef.current) clearInterval(pollRef.current);
  }, []);

  function poll(runId: string) {
    pollRef.current = setInterval(() => {
      startTransition(async () => {
        const p = await getRunProgress(runId);
        if (!p) return;
        setProgress({ processed: p.emailsProcessed, total: p.emailsTotal });
        if (p.status === 'running') return;

        if (pollRef.current) clearInterval(pollRef.current);
        if (p.status === 'ok') {
          setState('done');
        } else {
          setState('error');
          setErrorDetail(p.errorMessage ?? 'Something went wrong reading the inbox.');
        }
      });
    }, POLL_MS);
  }

  function run() {
    setState('running');
    setProgress(null);
    setErrorDetail(null);
    startTransition(async () => {
      try {
        const { runId } = await startRefresh();
        poll(runId);
      } catch (err) {
        setState('error');
        setErrorDetail(err instanceof Error ? err.message : 'Something went wrong reading the inbox.');
      }
    });
  }

  const label =
    state === 'idle' ? 'Update now'
    : state === 'running' ?
      progress?.total ? `Reading the inbox… ${progress.processed} of ${progress.total}` : 'Reading the inbox…'
    : state === 'done' ? 'Up to date — just now'
    : 'Retry';

  const v = VARIANTS[state];

  return (
    <div className={styles.col}>
      <button
        type="button"
        className={styles.btn}
        style={{ background: v.bg, color: v.fg, borderColor: v.bd }}
        disabled={state === 'running'}
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
