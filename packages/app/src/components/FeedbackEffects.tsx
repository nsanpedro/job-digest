'use client';

import { useOptimistic, useTransition } from 'react';
import type { ExcludeGroup } from '@job-digest/core';
import type { FeedbackEffectRow } from '@job-digest/db';
import { formatShortDate, joinLabels } from '@/lib/format';
import { removeExcludeWord, removeFeedback } from '@/lib/feedback-actions';
import styles from './FeedbackEffects.module.css';

/**
 * Profile → "From your dismissals" (ADR-003 §8.11): every standing effect a
 * dismiss reason had, each with its undo. Muted companies go to Explore
 * unscored; excluded words stop a title matching the directions named.
 *
 * A word is listed once however many directions hold it, and removed from
 * all of them at once. A word the matcher does not read — held on a
 * direction a CV analysis retired (§8.13) — is listed too, with why.
 */
export function FeedbackEffects({ mutes, excludes }: { mutes: FeedbackEffectRow[]; excludes: ExcludeGroup[] }) {
  const [, startTransition] = useTransition();
  const [hidden, hide] = useOptimistic(new Set<string>(), (state: Set<string>, key: string) => new Set(state).add(key));
  const remove = (key: string, action: () => Promise<void>) =>
    startTransition(async () => {
      hide(key);
      await action();
    });

  const shownMutes = mutes.filter((e) => !hidden.has(`mute:${e.id}`));
  const shownExcludes = excludes.filter((g) => !hidden.has(`word:${g.valueKey}`));
  const applied = shownExcludes.filter((g) => g.applied);
  const held = shownExcludes.filter((g) => !g.applied);

  return (
    <div className={styles.card}>
      {shownMutes.length === 0 && shownExcludes.length === 0 ? (
        <p className={styles.empty}>
          Nothing yet. When you dismiss an ad you can say why — “Company” mutes it, “Wrong role” proposes a word
          to exclude. Both show up here, with a way to undo.
        </p>
      ) : (
        <>
          {shownMutes.length > 0 && (
            <div className={styles.group}>
              <p className={styles.groupLabel}>Muted companies — their ads go to Explore, unscored</p>
              {shownMutes.map((e) => (
                <div key={e.id} className={styles.row}>
                  <span className={styles.value}>{e.value}</span>
                  <span className={styles.meta}>since {formatShortDate(e.createdAt)}</span>
                  <button
                    type="button"
                    className={styles.btn}
                    onClick={() => remove(`mute:${e.id}`, () => removeFeedback(e.id))}
                  >
                    Unmute
                  </button>
                </div>
              ))}
            </div>
          )}
          {applied.length > 0 && (
            <div className={styles.group}>
              <p className={styles.groupLabel}>Excluded words — a title with one no longer matches the directions named</p>
              {applied.map((g) => (
                <div key={g.valueKey} className={styles.row}>
                  <span className={styles.value}>
                    <span className={styles.term}>{g.value}</span> from {joinLabels(g.directionLabels)}
                  </span>
                  <span className={styles.meta}>since {formatShortDate(g.since)}</span>
                  <button
                    type="button"
                    className={styles.btn}
                    onClick={() => remove(`word:${g.valueKey}`, () => removeExcludeWord(g.valueKey))}
                  >
                    Remove
                  </button>
                </div>
              ))}
            </div>
          )}
          {held.length > 0 && (
            <div className={styles.group}>
              <p className={styles.groupLabel}>Not applied — saved on a direction you dismissed or a newer CV analysis replaced</p>
              {held.map((g) => (
                <div key={g.valueKey} className={styles.row}>
                  <span className={styles.value}>
                    <span className={styles.term}>{g.value}</span>{' '}
                    <span className={styles.why}>
                      {g.coveredBy
                        ? `— “${g.coveredBy}” searches for this word, so excluding it would hide that direction’s own matches.`
                        : '— not on any current direction. It moves to your directions at your next CV analysis.'}
                    </span>
                  </span>
                  <span className={styles.meta}>since {formatShortDate(g.since)}</span>
                  <button
                    type="button"
                    className={styles.btn}
                    onClick={() => remove(`word:${g.valueKey}`, () => removeExcludeWord(g.valueKey))}
                  >
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
