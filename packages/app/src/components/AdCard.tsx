'use client';

import { useOptimistic, useTransition } from 'react';
import type { DigestAd } from '@job-digest/db';
import { dismissAd, recordApplicationEvent, toggleSaved, toggleSeen, undoDismiss } from '@/lib/actions';
import { formatShortDate, formatTimestamp } from '@/lib/format';
import { RuleLane } from './RuleLane';
import { ScoreBreakdown } from './ScoreBreakdown';
import { TitleFactChips } from './TitleFactChips';
import { EDGE_COLOR, STATE_VISUALS, worstOf } from './rule-visuals';
import styles from './AdCard.module.css';

/** Short forms for the action bar; the applications view spells them out. */
const APPLIED_LABEL: Record<NonNullable<DigestAd['applicationStatus']>, string> = {
  applied: 'Applied ✓',
  interviewing: 'Interviewing',
  offer: 'Offer',
  rejected: 'Rejected',
  withdrawn: 'Withdrawn',
};

/**
 * Local, optimistic view of the fields a click on this card can change
 * (design: perf pass, Aug 2026). Every action here used to wait for the full
 * mutate → revalidatePath → re-render round trip before the button even
 * changed label — on a real network that's real seconds of "did my click
 * register?" for the single most-used interaction in the app.
 *
 * `justActed` covers Dismiss/Undo specifically: neither actually removes the
 * card from its list on click — that still requires the server's re-split
 * between visible/dismissed (I10) — but the button confirms instantly rather
 * than sitting there ambiguous until the real list catches up.
 */
interface OptimisticState {
  saved: boolean;
  seen: boolean;
  applicationStatus: DigestAd['applicationStatus'];
  justActed: boolean;
}

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
  const [optimistic, setOptimistic] = useOptimistic<OptimisticState, Partial<OptimisticState>>(
    { saved: ad.saved, seen: ad.seen, applicationStatus: ad.applicationStatus, justActed: false },
    (state, patch) => ({ ...state, ...patch }),
  );
  const edge = EDGE_COLOR[worstOf(ad.verdicts.map((v) => v.state))];

  // The server call reads the target value from optimistic state, not the
  // `ad` prop — a rapid second click lands before the prop refreshes, and
  // reading from the (stale) prop there would send the same value twice,
  // leaving the display and the database disagreeing about the outcome.
  const onToggleSaved = () =>
    startTransition(async () => {
      const next = !optimistic.saved;
      setOptimistic({ saved: next });
      await toggleSaved(ad.id, next);
    });
  const onToggleSeen = () =>
    startTransition(async () => {
      const next = !optimistic.seen;
      setOptimistic({ seen: next });
      await toggleSeen(ad.id, next);
    });
  const onApply = () =>
    startTransition(async () => {
      setOptimistic({ applicationStatus: 'applied' });
      await recordApplicationEvent(ad.id, 'applied');
    });
  const onDismiss = () =>
    startTransition(async () => {
      setOptimistic({ justActed: true });
      await dismissAd(ad.id);
    });
  const onUndo = () =>
    startTransition(async () => {
      setOptimistic({ justActed: true });
      await undoDismiss(ad.id);
    });

  return (
    <div className={styles.card} style={{ borderLeftColor: edge, opacity: optimistic.justActed ? 0.6 : 1 }}>
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
            {/*
              Above the rule lane on purpose: measured on the corpus, title
              facts populate more often (avg 1.67/ad) than the rule lane does
              — the more informative row goes first.
            */}
            <TitleFactChips facts={ad.titleFacts} />
            <RuleLane
              verdicts={ad.verdicts}
              wording={ad.wording}
              platformFields={ad.platformFields}
              source={ad.source}
            />
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
              className={`${styles.actionBtn} ${optimistic.saved ? styles.actionBtnActive : ''}`}
              disabled={optimistic.justActed}
              onClick={onToggleSaved}
            >
              {optimistic.saved ? 'Saved' : 'Save for later'}
            </button>
            <button
              type="button"
              className={styles.actionBtn}
              disabled={optimistic.justActed}
              onClick={onToggleSeen}
            >
              {optimistic.seen ? 'Marked seen' : 'Mark as seen'}
            </button>
            {/*
              Recording an application is the user telling us something we
              have no way to observe (I15) — so this is a plain assertion
              button, and once made it links to the record rather than
              pretending to track anything further on its own.
            */}
            {optimistic.applicationStatus ? (
              <a href="/applications" className={`${styles.actionBtn} ${styles.actionBtnApplied}`}>
                {APPLIED_LABEL[optimistic.applicationStatus]}
              </a>
            ) : (
              <button type="button" className={styles.actionBtn} disabled={optimistic.justActed} onClick={onApply}>
                I applied
              </button>
            )}
          </>
        )}
        {ad.externalUrl && (
          <a href={ad.externalUrl} target="_blank" rel="noreferrer" className={styles.actionLink}>
            Original ad&nbsp;↗
          </a>
        )}
        <span className={styles.spacer} />
        {dismissed ? (
          <button type="button" className={styles.actionBtn} disabled={optimistic.justActed} onClick={onUndo}>
            {optimistic.justActed ? 'Restored' : 'Undo'}
          </button>
        ) : (
          <button type="button" className={styles.dismissBtn} disabled={optimistic.justActed} onClick={onDismiss}>
            {optimistic.justActed ? 'Dismissed ✓' : 'Dismiss'}
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
                      {w?.note ||
                        (ad.platformFields[v.key.toLowerCase()] === false
                          ? `${ad.source} alerts don't include this — not a failure of the reader`
                          : 'not read from this email — open the original ad to check')}
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
        {ad.scoreBreakdown && (
          <div className={styles.scoreBreakdownWrap}>
            <ScoreBreakdown breakdown={ad.scoreBreakdown} />
          </div>
        )}
      </div>
      <div className={styles.panelRight}>
        <p className={styles.panelLabel}>Where this came from</p>
        <p className={styles.sourceLine}>
          {/*
            `ad.alert` is `email_parses`' subject line, not the name of a
            saved search the user configured — no platform's alert email
            exposes that. Checked live (3 Aug 2026): for a single-job
            LinkedIn send the subject happens to read like a job title
            ("Full Stack Engineer en Arrows"), and for a multi-job digest
            it's a marketing line unrelated to any search ("SOMI Group,
            Seaside Collection GmbH & Co. KG, adjoe und andere spannende
            Firmen suchen nach Kandidaten wie Dir!"). Calling either one
            "your alert" would be a claim the data does not support (I4's
            discipline: say what was read, not what would be nice to say),
            so this reads as the email's subject instead.
          */}
          {ad.alert && <>{ad.source} email „{ad.alert}“<br /></>}
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
