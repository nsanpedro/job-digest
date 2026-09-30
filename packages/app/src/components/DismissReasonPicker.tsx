'use client';

import { useEffect, useRef, useState, useTransition } from 'react';
import {
  DISMISS_REASONS,
  DISMISS_REASON_LABEL,
  type DismissFeedback,
  type DismissReason,
  type LevelFeedback,
} from '@job-digest/core';
import { acceptExcludeSuggestion, removeExcludeFromAd, setDismissReason, unmuteCompany } from '@/lib/feedback-actions';
import styles from './DismissReasonPicker.module.css';

/**
 * The five reason chips and what the picked one did (ADR-003 §8.11). Shared
 * by the follow-up row a dismissed card turns into and by the Dismissed list
 * (DismissedRow), so a reason can be given or changed in either place with
 * the same effects: `setDismissReason` undoes the previous reason's effect
 * before applying the new one. Every effect it reports has its own undo
 * right here, and again in Profile.
 */

const LEVEL_COPY: Record<LevelFeedback, string> = {
  gated: 'Entry-level titles already go to Explore for the level you target.',
  no_target: 'Your directions name no level, so nothing is filtered by level. Noted.',
  not_gated: 'Noted. Only entry-level titles are filtered by level today.',
};

function joinLabels(labels: readonly string[]): string {
  const quoted = labels.map((l) => `“${l}”`);
  return quoted.length <= 1 ? (quoted[0] ?? '') : `${quoted.slice(0, -1).join(', ')} and ${quoted.at(-1)}`;
}

export function DismissReasonPicker({
  adId,
  label,
  current,
  applyCurrent = false,
}: {
  adId: string;
  /** Lead-in before the chips, e.g. "Why? Optional". */
  label: string;
  /** The reason already stored (Dismissed list) or chosen on the card. */
  current: DismissReason | null;
  /**
   * Save `current` on mount — the card's "Dismiss because" strip, where the
   * reason is chosen before this row exists. `setDismissReason` also
   * dismisses the ad, so this is the only request that click makes.
   */
  applyCurrent?: boolean;
}) {
  const [pending, startTransition] = useTransition();
  const [reason, setReason] = useState<DismissReason | null>(current);
  const [outcome, setOutcome] = useState<DismissFeedback | null>(null);
  const [excluded, setExcluded] = useState<{ term: string; directions: string[] } | null>(null);
  const [unmuted, setUnmuted] = useState(false);

  const apply = (next: DismissReason) => {
    setReason(next);
    setOutcome(null);
    setExcluded(null);
    setUnmuted(false);
    startTransition(async () => {
      setOutcome(await setDismissReason(adId, next));
    });
  };

  // Mount only, and once per mounted row even under StrictMode's double
  // effect run.
  const applied = useRef(false);
  useEffect(() => {
    if (applyCurrent && current && !applied.current) {
      applied.current = true;
      apply(current);
    }
  }, []);

  const accept = (term: string) =>
    startTransition(async () => {
      const res = await acceptExcludeSuggestion(adId, term);
      if (res.saved) setExcluded({ term, directions: res.directions });
    });

  return (
    <>
      <div className={styles.reasons} role="group" aria-label="Why did you dismiss it?">
        <span className={styles.ask}>{label}</span>
        {DISMISS_REASONS.map((r) => (
          <button
            key={r}
            type="button"
            className={`${styles.chip} ${reason === r ? styles.chipOn : ''}`}
            aria-pressed={reason === r}
            disabled={pending && reason !== r}
            onClick={() => r !== reason && apply(r)}
          >
            {DISMISS_REASON_LABEL[r]}
          </button>
        ))}
      </div>

      {outcome && reason && (
        <p className={styles.effect} role="status">
          <Effect
            reason={reason}
            outcome={outcome}
            excluded={excluded}
            unmuted={unmuted}
            pending={pending}
            onAccept={accept}
            onRemoveExclude={() =>
              startTransition(async () => {
                await removeExcludeFromAd(adId);
                // Back to the proposal: the user may pick another word, or none.
                setExcluded(null);
              })
            }
            onUnmute={(company) =>
              startTransition(async () => {
                await unmuteCompany(company);
                setUnmuted(true);
              })
            }
          />
        </p>
      )}
    </>
  );
}

function Effect({
  reason,
  outcome,
  excluded,
  unmuted,
  pending,
  onAccept,
  onRemoveExclude,
  onUnmute,
}: {
  reason: DismissReason;
  outcome: DismissFeedback;
  excluded: { term: string; directions: string[] } | null;
  unmuted: boolean;
  pending: boolean;
  onAccept: (term: string) => void;
  onRemoveExclude: () => void;
  onUnmute: (company: string) => void;
}) {
  switch (outcome.kind) {
    case 'mute':
      return unmuted ? (
        <>{outcome.company} unmuted.</>
      ) : (
        <>
          Muted {outcome.company} — its ads go to Explore, unscored.{' '}
          <button type="button" className={styles.link} disabled={pending} onClick={() => onUnmute(outcome.company)}>
            Unmute
          </button>
        </>
      );
    case 'suggest_exclude': {
      const labels = joinLabels(outcome.suggestion.directions.map((d) => d.label));
      if (excluded) {
        return (
          <>
            Added “{excluded.term}” to the excludes of {joinLabels(excluded.directions)} — titles with it no longer
            match.{' '}
            <button type="button" className={styles.link} disabled={pending} onClick={onRemoveExclude}>
              Remove
            </button>
          </>
        );
      }
      return (
        <>
          Exclude a word from {labels}?{' '}
          {outcome.suggestion.terms.map((t) => (
            <button key={t} type="button" className={styles.term} disabled={pending} onClick={() => onAccept(t)}>
              {t}
            </button>
          ))}{' '}
          <span className={styles.gloss}>Nothing is added unless you pick one.</span>
        </>
      );
    }
    case 'level':
      return <>{LEVEL_COPY[outcome.level]}</>;
    case 'noted':
      if (reason === 'company') return <>This ad names no company, so there is nothing to mute. Noted.</>;
      if (reason === 'wrong_role') return <>Noted. No word in this title can be excluded without touching your own search terms.</>;
      return <>Noted. Used to check the ranking; nothing is filtered.</>;
  }
}
