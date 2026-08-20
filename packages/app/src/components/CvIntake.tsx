'use client';

import { useEffect, useRef, useState, useTransition } from 'react';
import { getDerivationProgress, uploadCv } from '@/lib/discovery-actions';
import styles from './CvIntake.module.css';

type State = 'idle' | 'running' | 'error';

/** Same cadence RefreshButton polls run progress at — fast enough to feel live. */
const POLL_MS = 1000;

/**
 * Upload a CV, poll while it's being read (docs/adr-001-role-discovery.md
 * §3). Mirrors RefreshButton's start/poll shape exactly — `uploadCv` returns
 * almost immediately with a profile id, the model call runs detached, this
 * polls `getDerivationProgress` the same way RefreshButton polls
 * `getRunProgress`. On completion the parent page's next render picks up the
 * new directions (revalidatePath runs server-side in discovery-actions.ts);
 * no client-side refresh call needed, same as RefreshButton.
 *
 * The CV itself never leaves this upload — it's read once, server-side, into
 * text, and discarded (ADR-001 §2.8). This component doesn't know that; it
 * just posts a file and polls a status.
 */
export function CvIntake() {
  const [state, setState] = useState<State>('idle');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [, startTransition] = useTransition();
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(
    () => () => {
      if (pollRef.current) clearInterval(pollRef.current);
    },
    [],
  );

  function poll(profileId: string) {
    pollRef.current = setInterval(() => {
      startTransition(async () => {
        const p = await getDerivationProgress(profileId);
        if (!p || p.status === 'running') return;

        if (pollRef.current) clearInterval(pollRef.current);
        if (p.status === 'ok') {
          setState('idle');
          if (fileInputRef.current) fileInputRef.current.value = '';
        } else {
          setState('error');
          setErrorMessage(p.errorMessage ?? 'Something went wrong reading that CV.');
        }
      });
    }, POLL_MS);
  }

  function onFileSelected(file: File) {
    setState('running');
    setErrorMessage(null);
    const formData = new FormData();
    formData.set('cv', file);
    startTransition(async () => {
      const result = await uploadCv(formData);
      if ('error' in result) {
        setState('error');
        setErrorMessage(result.error);
        if (fileInputRef.current) fileInputRef.current.value = '';
        return;
      }
      poll(result.profileId);
    });
  }

  return (
    <div className={styles.box}>
      <p className={styles.label}>Find role directions from your CV</p>
      <p className={styles.hint}>
        Upload a PDF. We read it once, propose skills and directions with the exact words from your CV next to
        each one, and never store the file itself.
      </p>
      <label className={`${styles.uploadBtn} ${state === 'running' ? styles.uploadBtnDisabled : ''}`}>
        <input
          ref={fileInputRef}
          type="file"
          accept="application/pdf"
          disabled={state === 'running'}
          className={styles.fileInput}
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) onFileSelected(file);
          }}
        />
        {state === 'running' ? 'Reading your CV…' : 'Upload CV (PDF)'}
      </label>
      {state === 'error' && errorMessage && <p className={styles.error}>{errorMessage}</p>}
    </div>
  );
}
