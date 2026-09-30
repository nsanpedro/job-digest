'use client';

import { useOptimistic, useState, useTransition } from 'react';
import { DISMISS_REASON_LABEL, describeCondition, type Ruleset } from '@job-digest/core';
import type { DismissedAd } from '@job-digest/db';
import { overrideRule, undoDismiss } from '@/lib/actions';
import { DismissReasonPicker } from './DismissReasonPicker';
import { STATE_VISUALS } from './rule-visuals';
import styles from './DismissedRow.module.css';

/**
 * "value — your hard rule: description", one clause per blocker (design:
 * "El motivo siempre nombra la regla que disparó"). The description comes
 * from @job-digest/core's own describeCondition — the same sentence the
 * engine would give anywhere else — not copied prose.
 */
function reasonText(ad: DismissedAd, rules: Ruleset): string {
  if (ad.reason.kind === 'user') {
    return ad.reason.why
      ? `Dismissed by you — ${DISMISS_REASON_LABEL[ad.reason.why].toLowerCase()}`
      : 'Dismissed by you — no rule triggered this';
  }
  return ad.reason.blockers
    .map((b) => {
      const value = ad.wording[b.key]?.value ?? b.because.find((s) => s.kind === 'compared')?.fact ?? '';
      return `${value} — your hard rule: ${describeCondition(b.key, rules[b.key].condition)}`;
    })
    .join(' · ');
}

export function DismissedRow({
  ad,
  rules,
  rulesetVersion,
}: {
  ad: DismissedAd;
  rules: Ruleset;
  rulesetVersion: number;
}) {
  const [, startTransition] = useTransition();
  // Same pattern as AdCard (design: perf pass, Aug 2026): the click can't
  // actually move this row out of "Filtered out" until the server re-splits
  // the digest, but it can confirm instantly instead of leaving the button
  // sitting there ambiguous for however long that round trip takes.
  const [justActed, setJustActed] = useOptimistic(false, (_state: boolean, next: boolean) => next);
  const sv = STATE_VISUALS[ad.reason.kind === 'user' ? 'unknown' : 'block'];
  // Your own dismissals take a reason here too, any time (ADR-003 §8.11,
  // "Dismiss reason UX"): the follow-up row under a dismissed card is gone
  // once closed, and this is where the dismissal is still on record.
  const [editing, setEditing] = useState(false);
  const why = ad.reason.kind === 'user' ? (ad.reason.why ?? null) : null;
  const pickerId = `dismiss-reason-${ad.id}`;

  return (
    <div className={styles.row} style={{ opacity: justActed ? 0.6 : 1 }}>
      <span className={styles.bar} style={{ background: sv.fg }} />
      <div className={styles.main}>
        <span className={styles.title}>{ad.title}</span>
        {ad.company && (
          <>
            <span className={styles.dot} />
            <span className={styles.company}>{ad.company}</span>
          </>
        )}
        <span className={styles.source}>{ad.source}</span>
      </div>
      <div className={styles.reason} style={{ color: sv.fg }}>
        <span
          className={styles.reasonGlyph}
          style={{ background: sv.bg, color: sv.fg }}
          aria-hidden="true"
        >
          {sv.glyph}
        </span>
        <span>
          {reasonText(ad, rules)}
          {ad.reason.kind === 'user' && (
            <>
              {' '}
              <button
                type="button"
                className={styles.reasonEdit}
                aria-expanded={editing}
                aria-controls={pickerId}
                aria-label={why ? `Change the reason for ${ad.title}` : `Add a reason for ${ad.title}`}
                onClick={() => setEditing((v) => !v)}
              >
                {editing ? 'Done' : why ? 'Change' : 'Add reason'}
              </button>
            </>
          )}
        </span>
      </div>
      <div className={styles.score}>{ad.score !== null ? `${ad.score}%` : '—'}</div>
      <button
        type="button"
        className={styles.btn}
        disabled={justActed}
        onClick={() =>
          startTransition(async () => {
            setJustActed(true);
            if (ad.reason.kind === 'user') await undoDismiss(ad.id);
            else await overrideRule(ad.id, ad.reason.blockers[0]!.key, rulesetVersion);
          })
        }
      >
        {justActed ? '✓' : ad.reason.kind === 'user' ? 'Undo' : 'Show anyway'}
      </button>
      {editing && ad.reason.kind === 'user' && (
        <div id={pickerId} className={styles.picker}>
          <DismissReasonPicker adId={ad.id} label="Why?" current={why} />
        </div>
      )}
    </div>
  );
}
