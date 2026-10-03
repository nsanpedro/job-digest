'use client';

import { useTransition } from 'react';
import type { DismissedAd } from '@job-digest/db';
import { undoOverride } from '@/lib/actions';
import type { Placement } from './override-follow-ups';
import styles from './OverrideFollowUp.module.css';

/**
 * What a "Show anyway" row turns into (ADR-003 §8.14): the override already
 * happened in one click; this row says where the ad went, because an
 * override restores eligibility, not a slot — the ad may not have made this
 * week's matches. "Go to it" opens the card wherever it landed.
 */

const WHERE: Record<Placement, string> = {
  matches: 'it’s in this week’s matches.',
  worthALook: 'it didn’t make this week’s matches, so it’s under Worth a look.',
  hidden: 'it didn’t make this week’s matches, so it’s under Hidden.',
};

function ruleNames(ad: DismissedAd): string {
  const keys = ad.reason.kind === 'rule' ? ad.reason.blockers.map((b) => b.key) : [];
  return keys.length <= 1 ? (keys[0] ?? '') : `${keys.slice(0, -1).join(', ')} and ${keys.at(-1)}`;
}

export function OverrideFollowUp({
  ad,
  placement,
  onReveal,
  onClose,
}: {
  ad: DismissedAd;
  placement: Placement | null;
  onReveal: () => void;
  onClose: () => void;
}) {
  const [pending, startTransition] = useTransition();
  const rules = ruleNames(ad);

  const undo = () =>
    startTransition(async () => {
      await undoOverride(ad.id);
      onClose();
    });

  return (
    <div className={styles.row} role="status">
      <div className={styles.head}>
        <span className={styles.status}>Shown anyway</span>
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
      <p className={styles.effect}>
        {placement === null ? (
          <>Placing it…</>
        ) : (
          <>
            Back among the candidates — {WHERE[placement]}{' '}
            <button type="button" className={styles.link} onClick={onReveal}>
              Go to it
            </button>
          </>
        )}
        {rules && (
          <>
            <br />
            <span className={styles.gloss}>Your {rules} rule still counts against its score.</span>
          </>
        )}
      </p>
    </div>
  );
}
