'use client';

import { useTransition } from 'react';
import type { DigestAd } from '@job-digest/db';
import { dismissAd, toggleSaved, toggleSeen, undoDismiss } from '@/lib/actions';
import { formatShortDate, formatTimestamp } from '@/lib/format';
import { RuleLane } from './RuleLane';
import { EDGE_COLOR, STATE_VISUALS, worstOf } from './rule-visuals';
import styles from './AdCard.module.css';

export function AdCard({
  ad,
  expanded,
  onToggle,
  dismissed,
}: {
  ad: DigestAd;
  expanded: boolean;
  onToggle: () => void;
  /** Rendered from the "Filtered out" section — action bar shrinks to Undo. */
  dismissed?: boolean;
}) {
  const [pending, startTransition] = useTransition();
  const edge = EDGE_COLOR[worstOf(ad.verdicts.map((v) => v.state))];

  return (
    <div className={styles.card} style={{ borderLeftColor: edge }}>
      <div className={styles.body}>
        <div className={styles.titleRow}>
          <button type="button" className={styles.titleBtn} onClick={onToggle}>
            {ad.title}
          </button>
          {ad.repeat && <span className={styles.badge}>seen {formatShortDate(ad.firstSeenAt)}</span>}
          {ad.incomplete && <span className={`${styles.badge} ${styles.badgePartial}`}>partly read</span>}
        </div>

        <div className={styles.metaRow}>
          {ad.company && <span className={styles.metaCompany}>{ad.company}</span>}
          {ad.company && ad.location && <span className={styles.metaSep}>|</span>}
          {ad.location && <span>{ad.location}</span>}
          {(ad.company || ad.location) && <span className={styles.metaSep}>|</span>}
          <span className={styles.metaSource}>via {ad.source}</span>
        </div>

        <div className={styles.main}>
          <div className={styles.mainLeft}>
            <RuleLane verdicts={ad.verdicts} wording={ad.wording} />
            {(ad.fit || ad.gap) && (
              <div className={styles.prose}>
                {ad.fit && <p className={styles.proseFit}>{ad.fit}</p>}
                {ad.gap && <p className={styles.proseGap}>{ad.gap}</p>}
              </div>
            )}
          </div>
          <div className={styles.score}>
            <div className={styles.scoreLabel}>match</div>
            <div className={styles.scoreValue}>{ad.score !== null ? `${ad.score}%` : '—'}</div>
            {ad.score !== null && (
              <div className={styles.scoreBar}>
                <div className={styles.scoreFill} style={{ width: `${ad.score}%` }} />
              </div>
            )}
          </div>
        </div>
      </div>

      <div className={styles.actions}>
        {!dismissed && (
          <>
            <button
              type="button"
              className={`${styles.actionBtn} ${ad.saved ? styles.actionBtnActive : ''}`}
              disabled={pending}
              onClick={() => startTransition(() => toggleSaved(ad.id, !ad.saved))}
            >
              {ad.saved ? 'Saved' : 'Save for later'}
            </button>
            <button
              type="button"
              className={styles.actionBtn}
              disabled={pending}
              onClick={() => startTransition(() => toggleSeen(ad.id, !ad.seen))}
            >
              {ad.seen ? 'Marked seen' : 'Mark as seen'}
            </button>
          </>
        )}
        {ad.externalUrl && (
          <a href={ad.externalUrl} target="_blank" rel="noreferrer" className={styles.actionLink}>
            Original ad&nbsp;↗
          </a>
        )}
        <span className={styles.spacer} />
        {dismissed ? (
          <button
            type="button"
            className={styles.actionBtn}
            disabled={pending}
            onClick={() => startTransition(() => undoDismiss(ad.id))}
          >
            Undo
          </button>
        ) : (
          <button
            type="button"
            className={styles.dismissBtn}
            disabled={pending}
            onClick={() => startTransition(() => dismissAd(ad.id))}
          >
            Dismiss
          </button>
        )}
      </div>

      {expanded && <ExpandedPanel ad={ad} />}
    </div>
  );
}

function ExpandedPanel({ ad }: { ad: DigestAd }) {
  return (
    <div className={styles.panel}>
      <div>
        <p className={styles.panelLabel}>Rule by rule — wording from the ad</p>
        <div className={styles.ruleTable}>
          {ad.verdicts.map((v) => {
            const sv = STATE_VISUALS[v.state];
            const w = ad.wording[v.key];
            return (
              <div key={v.key} className={styles.ruleRow}>
                <div className={styles.ruleName}>
                  {v.key}
                  {v.severity === 'hard' && <span className={styles.hardMark}> • hard</span>}
                </div>
                <div className={styles.ruleGlyph} style={{ background: sv.bg, color: sv.fg, border: `1px solid ${sv.bd}` }}>
                  {sv.glyph}
                </div>
                <div>
                  {w?.quote && w.quote !== '—' ? (
                    <>
                      <span className={styles.quote}>„{w.quote}“</span>
                      {w.note && <> — <span className={styles.gloss}>{w.note}</span></>}
                    </>
                  ) : (
                    <span className={styles.gloss}>
                      {w?.note || 'not read from this email — open the original ad to check'}
                    </span>
                  )}
                </div>
              </div>
            );
          })}
        </div>
        {(ad.fit || ad.gap) && (
          <div className={styles.fullProse}>
            {ad.fit && <p className={styles.proseFit}>{ad.fit}</p>}
            {ad.gap && <p className={styles.proseGap}>{ad.gap}</p>}
          </div>
        )}
      </div>
      <div className={styles.panelRight}>
        <p className={styles.panelLabel}>Where this came from</p>
        <p className={styles.sourceLine}>
          {ad.alert && <>{ad.source} alert „{ad.alert}“<br /></>}
          received {formatTimestamp(ad.receivedAt)}
        </p>
        {ad.incomplete && ad.incompleteNote && (
          <p className={styles.missingNote}>{ad.incompleteNote}</p>
        )}
        <div className={styles.panelLinks}>
          {ad.externalUrl && (
            <a href={ad.externalUrl} target="_blank" rel="noreferrer" className={styles.panelLink}>
              Open the ad on {ad.source}&nbsp;↗
            </a>
          )}
        </div>
      </div>
    </div>
  );
}
