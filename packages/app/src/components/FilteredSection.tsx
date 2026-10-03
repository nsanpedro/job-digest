'use client';

import { useState } from 'react';
import type { Ruleset } from '@job-digest/core';
import type { DismissedAd } from '@job-digest/db';
import { DismissedRow } from './DismissedRow';
import { OverrideFollowUp } from './OverrideFollowUp';
import { useOverrideFollowUps, type Placement } from './override-follow-ups';
import styles from './FilteredSection.module.css';

export function FilteredSection({
  dismissed,
  rules,
  rulesetVersion,
  placementOf,
  onReveal,
}: {
  dismissed: DismissedAd[];
  rules: Ruleset;
  rulesetVersion: number;
  /** Where an overridden ad landed on the page (see override-follow-ups). */
  placementOf: (adId: string) => Placement | null;
  /** Open and scroll to the card of an overridden ad. */
  onReveal: (adId: string) => void;
}) {
  // Open by default (design: "Abierta por defecto") — this is prototype-only
  // UI state, not synced server-side (design's State Management table lists
  // it the same way).
  const [open, setOpen] = useState(true);
  const followUps = useOverrideFollowUps(dismissed, placementOf);

  // A follow-up keeps the section up after its last held ad was overridden:
  // the section is where the user is looking for the answer.
  if (dismissed.length === 0 && followUps.count === 0) return null;

  return (
    <div className={styles.wrap}>
      <div className={styles.headRow}>
        <h2 className={styles.heading}>Held by the sift — {dismissed.length}</h2>
        <span className={styles.gloss}>shown so you can see where the sift catches</span>
        <span className={`mesh-rule ${styles.rule}`} />
        <button type="button" className={styles.toggle} onClick={() => setOpen((o) => !o)}>
          {open ? 'Hide' : 'Show'}
        </button>
      </div>
      {open && (
        <div className={styles.list}>
          {followUps.items.map((item, i) =>
            item.kind === 'followUp' ? (
              <OverrideFollowUp
                key={item.ad.id}
                ad={item.ad}
                placement={placementOf(item.ad.id)}
                onReveal={() => onReveal(item.ad.id)}
                onClose={() => followUps.close(item.ad.id)}
              />
            ) : (
              <DismissedRow
                key={item.ad.id}
                ad={item.ad}
                rules={rules}
                rulesetVersion={rulesetVersion}
                onOverridden={(ad) => followUps.onOverridden(ad, i)}
              />
            ),
          )}
        </div>
      )}
    </div>
  );
}
