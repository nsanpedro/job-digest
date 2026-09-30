'use client';

import { useEffect, useRef, useTransition } from 'react';
import type { DismissReason } from '@job-digest/core';
import type { DigestAd } from '@job-digest/db';
import { undoDismiss } from '@/lib/actions';
import { DismissReasonPicker } from './DismissReasonPicker';
import styles from './DismissFollowUp.module.css';

/**
 * What a just-dismissed card turns into (ADR-003 §8.11): the dismiss already
 * happened in one click; this row only asks, optionally, why — and says
 * plainly what the answer does. It stays until the user closes it, undoes
 * the dismiss or leaves the page; the reason can still be set or changed
 * later from the Dismissed list.
 *
 * `initialReason` is set when the card's "Dismiss because" strip was used:
 * the row then saves that reason (which also dismisses) and shows its effect.
 */
export function DismissFollowUp({
  ad,
  initialReason,
  onClose,
}: {
  ad: DigestAd;
  initialReason: DismissReason | null;
  onClose: () => void;
}) {
  const [pending, startTransition] = useTransition();
  const row = useRef<HTMLDivElement>(null);

  // The Dismiss button the user just pressed is gone with its card; keep a
  // keyboard user's place by focusing this row instead (Tab reaches Undo).
  useEffect(() => {
    if (document.activeElement === document.body) row.current?.focus({ preventScroll: true });
  }, []);

  const undo = () =>
    startTransition(async () => {
      await undoDismiss(ad.id);
      onClose();
    });

  return (
    <div ref={row} className={styles.row} tabIndex={-1} role="group" aria-label={`Dismissed: ${ad.title}`}>
      <div className={styles.head}>
        <span className={styles.status}>Dismissed</span>
        <span className={styles.title}>{ad.title}</span>
        {ad.company && <span className={styles.company}>{ad.company}</span>}
        <span className={styles.spacer} />
        <button type="button" className={styles.btn} disabled={pending} onClick={undo}>
          Undo
        </button>
        <button type="button" className={styles.close} aria-label="Close" onClick={onClose}>
          ×
        </button>
      </div>

      <DismissReasonPicker adId={ad.id} label="Why? Optional" current={initialReason} applyCurrent />
    </div>
  );
}
