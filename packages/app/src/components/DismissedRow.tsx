'use client';

import { useTransition } from 'react';
import { describeCondition, type Ruleset } from '@job-digest/core';
import type { DismissedAd } from '@job-digest/db';
import { overrideRule, undoDismiss } from '@/lib/actions';
import { STATE_VISUALS } from './rule-visuals';
import styles from './DismissedRow.module.css';

/**
 * "value — your hard rule: description", one clause per blocker (design:
 * "El motivo siempre nombra la regla que disparó"). The description comes
 * from @job-digest/core's own describeCondition — the same sentence the
 * engine would give anywhere else — not copied prose.
 */
function reasonText(ad: DismissedAd, rules: Ruleset): string {
  if (ad.reason.kind === 'user') return 'Dismissed by you — no rule triggered this';
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
  const [pending, startTransition] = useTransition();
  const sv = STATE_VISUALS[ad.reason.kind === 'user' ? 'unknown' : 'block'];

  return (
    <div className={styles.row}>
      <div className={styles.main}>
        <div className={styles.title}>{ad.title}</div>
        <div className={styles.meta}>
          {ad.company} {ad.company && ad.location && '· '}
          {ad.location}
        </div>
      </div>
      <div className={styles.reason} style={{ color: sv.fg }}>
        <span className={styles.reasonGlyph}>{sv.glyph}</span>
        <span>{reasonText(ad, rules)}</span>
      </div>
      <div className={styles.score}>{ad.score !== null ? `${ad.score}%` : '—'}</div>
      <button
        type="button"
        className={styles.btn}
        disabled={pending}
        onClick={() =>
          startTransition(() =>
            ad.reason.kind === 'user'
              ? undoDismiss(ad.id)
              : overrideRule(ad.id, ad.reason.blockers[0]!.key, rulesetVersion),
          )
        }
      >
        {ad.reason.kind === 'user' ? 'Undo' : 'Show anyway'}
      </button>
    </div>
  );
}
