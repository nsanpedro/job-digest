'use client';

import { useState, useTransition } from 'react';
import type { Skill } from '@job-digest/core';
import type { DirectionRow } from '@job-digest/db';
import { setDirectionState } from '@/lib/discovery-actions';
import styles from './DirectionCard.module.css';

/**
 * One role direction (docs/adr-001-role-discovery.md §3). Renders exactly
 * what the ADR's presentation section specifies: label, rationale, distance
 * marker, each bridging skill with its verbatim CV quote (I17 — the
 * inference is the label, the premises are these), then one of two states:
 *
 * - Served: `seenTitles` (snapshot at derivation time) is non-empty — ads
 *   like this already reached the user, listed as evidence.
 * - Unserved: nothing has arrived yet — the search terms are shown as plain
 *   text to copy into a platform search, honestly marked as unproven. A
 *   real deep link to each platform's search page is deferred (ADR-001 §5,
 *   phase 5) — the exact URL formats need verifying live, not assuming.
 */
export function DirectionCard({ direction, skills }: { direction: DirectionRow; skills: Skill[] }) {
  const [state, setState] = useState(direction.state);
  const [pending, startTransition] = useTransition();

  const bridgeSkills = direction.bridge
    .map((text) => skills.find((s) => s.text === text))
    .filter((s): s is Skill => s !== undefined);

  const served = direction.seenTitles.length > 0;

  function act(next: 'interested' | 'dismissed') {
    startTransition(async () => {
      setState(next);
      await setDirectionState(direction.id, next);
    });
  }

  if (state === 'dismissed') return null;

  return (
    <div className={styles.card}>
      <div className={styles.head}>
        <h3 className={styles.label}>{direction.label}</h3>
        <span className={`${styles.distance} ${direction.distance === 'stretch' ? styles.distanceStretch : ''}`}>
          {direction.distance === 'adjacent' ? 'Adjacent to your background' : 'A real stretch'}
        </span>
      </div>

      <p className={styles.rationale}>{direction.rationale}</p>

      {bridgeSkills.length > 0 && (
        <div className={styles.bridge}>
          <p className={styles.bridgeLabel}>From your CV</p>
          <ul className={styles.bridgeList}>
            {bridgeSkills.map((s) => (
              <li key={s.text} className={styles.bridgeItem}>
                <span className={styles.skillText}>{s.text}</span>
                <span className={styles.skillQuote}>&ldquo;{s.quote}&rdquo;</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {served ? (
        <div className={styles.servedBox}>
          <p className={styles.servedLabel}>Ads like this are already reaching you</p>
          <ul className={styles.titleList}>
            {direction.seenTitles.map((t) => (
              <li key={t}>{t}</li>
            ))}
          </ul>
        </div>
      ) : (
        <div className={styles.unservedBox}>
          <p className={styles.unservedLabel}>We have no ads for this yet — set up an alert and find out</p>
          <p className={styles.searchTermsHint}>Search terms to try on your job platforms:</p>
          <ul className={styles.termList}>
            {direction.searchTerms.map((t) => (
              <li key={t} className={styles.term}>
                {t}
              </li>
            ))}
          </ul>
        </div>
      )}

      {state === 'suggested' && (
        <div className={styles.actions}>
          <button type="button" className={styles.actionBtn} disabled={pending} onClick={() => act('interested')}>
            Interested
          </button>
          <button type="button" className={styles.dismissBtn} disabled={pending} onClick={() => act('dismissed')}>
            Not for me
          </button>
        </div>
      )}
      {state === 'interested' && <p className={styles.confirmed}>Marked interested ✓</p>}
    </div>
  );
}
