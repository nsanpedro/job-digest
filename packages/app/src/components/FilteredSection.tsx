'use client';

import { useState } from 'react';
import type { Ruleset } from '@job-digest/core';
import type { DismissedAd } from '@job-digest/db';
import { DismissedRow } from './DismissedRow';
import styles from './FilteredSection.module.css';

export function FilteredSection({
  dismissed,
  rules,
  rulesetVersion,
}: {
  dismissed: DismissedAd[];
  rules: Ruleset;
  rulesetVersion: number;
}) {
  // Open by default (design: "Abierta por defecto") — this is prototype-only
  // UI state, not synced server-side (design's State Management table lists
  // it the same way).
  const [open, setOpen] = useState(true);

  if (dismissed.length === 0) return null;

  return (
    <div className={styles.wrap}>
      <div className={styles.headRow}>
        <h2 className={styles.heading}>Filtered out — {dismissed.length}</h2>
        <span className={styles.gloss}>shown so you can check the filter, not to re-read them</span>
        <span className={styles.rule} />
        <button type="button" className={styles.toggle} onClick={() => setOpen((o) => !o)}>
          {open ? 'Hide' : 'Show'}
        </button>
      </div>
      {open && (
        <div className={styles.list}>
          {dismissed.map((ad) => (
            <DismissedRow key={ad.id} ad={ad} rules={rules} rulesetVersion={rulesetVersion} />
          ))}
        </div>
      )}
    </div>
  );
}
