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
 *
 * The follow-up loop (3 Aug 2026): the system cannot observe whether the
 * user actually went and created a search alert on LinkedIn/Xing/StepStone —
 * exactly the same gap I15 already names for application tracking ("the
 * system cannot know that"). So `alert_configured` is a second self-report,
 * asked only after "Interested", never inferred. Once set, `coverageCount`
 * (a literal title-substring count, computed at read time — see
 * `getDirectionCoverage`) replaces the confirmation line: a number the user
 * can act on, never a score. Deliberately not a percentage, matching I18 —
 * the same reason the model's own prompt is forbidden from attaching one.
 */
export function DirectionCard({
  direction,
  skills,
  coverageCount,
}: {
  direction: DirectionRow;
  skills: Skill[];
  /** Ads matching this direction's search terms, computed at read time — only meaningful once state is 'alert_configured'. */
  coverageCount: number;
}) {
  const [state, setState] = useState(direction.state);
  const [pending, startTransition] = useTransition();

  const bridgeSkills = direction.bridge
    .map((text) => skills.find((s) => s.text === text))
    .filter((s): s is Skill => s !== undefined);

  const served = direction.seenTitles.length > 0;

  function act(next: 'interested' | 'dismissed' | 'alert_configured') {
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

      {state === 'interested' && (
        <div className={styles.followUp}>
          <p className={styles.confirmed}>Marked interested ✓</p>
          <p className={styles.followUpHint}>Went and set up a real search alert for this on the platform?</p>
          <button type="button" className={styles.actionBtn} disabled={pending} onClick={() => act('alert_configured')}>
            Yes, I set it up
          </button>
        </div>
      )}

      {state === 'alert_configured' && (
        <p className={styles.confirmed}>
          {coverageCount === 0
            ? "Alert configured — nothing matching has arrived yet. We'll count them here once they do."
            : `Alert configured — ${coverageCount} ad${coverageCount === 1 ? '' : 's'} matching this so far.`}
        </p>
      )}
    </div>
  );
}
