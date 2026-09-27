'use client';

import { useOptimistic, useTransition } from 'react';
import type { FeedbackEffectRow } from '@job-digest/db';
import { formatShortDate } from '@/lib/format';
import { removeFeedback } from '@/lib/feedback-actions';
import styles from './FeedbackEffects.module.css';

/**
 * Profile → "From your dismissals" (ADR-003 §8.11): every standing effect a
 * dismiss reason had, each with its undo. Muted companies go to Explore
 * unscored; excluded words stop a title matching the direction named.
 */
export function FeedbackEffects({ effects }: { effects: FeedbackEffectRow[] }) {
  const [, startTransition] = useTransition();
  const [shown, hide] = useOptimistic(effects, (state: FeedbackEffectRow[], id: string) =>
    state.filter((e) => e.id !== id),
  );
  const remove = (id: string) =>
    startTransition(async () => {
      hide(id);
      await removeFeedback(id);
    });

  const mutes = shown.filter((e) => e.kind === 'mute_company');
  const excludes = shown.filter((e) => e.kind === 'exclude_term');

  return (
    <div className={styles.card}>
      {shown.length === 0 ? (
        <p className={styles.empty}>
          Nothing yet. When you dismiss an ad you can say why — “Company” mutes it, “Wrong role” proposes a word
          to exclude. Both show up here, with a way to undo.
        </p>
      ) : (
        <>
          {mutes.length > 0 && (
            <div className={styles.group}>
              <p className={styles.groupLabel}>Muted companies — their ads go to Explore, unscored</p>
              {mutes.map((e) => (
                <div key={e.id} className={styles.row}>
                  <span className={styles.value}>{e.value}</span>
                  <span className={styles.meta}>since {formatShortDate(e.createdAt)}</span>
                  <button type="button" className={styles.btn} onClick={() => remove(e.id)}>
                    Unmute
                  </button>
                </div>
              ))}
            </div>
          )}
          {excludes.length > 0 && (
            <div className={styles.group}>
              <p className={styles.groupLabel}>Excluded words — a title with one no longer matches that direction</p>
              {excludes.map((e) => (
                <div key={e.id} className={styles.row}>
                  <span className={styles.value}>
                    <span className={styles.term}>{e.value}</span>
                    {e.directionLabel && <> from “{e.directionLabel}”</>}
                  </span>
                  <span className={styles.meta}>since {formatShortDate(e.createdAt)}</span>
                  <button type="button" className={styles.btn} onClick={() => remove(e.id)}>
                    Remove
                  </button>
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}
