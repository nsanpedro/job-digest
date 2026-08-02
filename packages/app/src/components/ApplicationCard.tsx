'use client';

import { useOptimistic, useTransition } from 'react';
import type { ApplicationEvent, ApplicationStatus, TrackedApplication } from '@job-digest/db';
import { recordApplicationEvent, removeApplicationEvent } from '@/lib/actions';
import { formatShortDate, formatTimestamp } from '@/lib/format';
import styles from './ApplicationCard.module.css';

/**
 * Authored copy per status — a closed enum precisely so every value has a
 * sentence someone wrote (design §9, same reasoning as cause_code).
 */
const STATUS_COPY: Record<ApplicationStatus, { label: string; tone: 'open' | 'good' | 'closed' }> = {
  applied: { label: 'Applied', tone: 'open' },
  interviewing: { label: 'Interviewing', tone: 'open' },
  offer: { label: 'Offer', tone: 'good' },
  rejected: { label: 'Rejected', tone: 'closed' },
  withdrawn: { label: 'Withdrawn', tone: 'closed' },
};

/** What you can record next. Every transition is allowed — a search is not a state machine. */
const NEXT_STATUSES: ApplicationStatus[] = ['interviewing', 'offer', 'rejected', 'withdrawn'];

function elapsed(days: number): string {
  if (days === 0) return 'today';
  if (days === 1) return 'yesterday';
  return `${days} days ago`;
}

type TimelineAction = { kind: 'record'; status: ApplicationStatus } | { kind: 'remove'; eventId: string };

/**
 * Optimistic status + timeline (design: perf pass, Aug 2026). Recording a
 * status used to wait for the full round trip before the badge or the
 * timeline showed anything new; now the click writes both immediately and
 * reconciles once the server confirms. `open`/`needsFollowUp`, computed
 * server-side from the whole account's data, deliberately stay as the server
 * last reported them rather than being re-derived here — they still catch up
 * on the next revalidate, same as which section (open/closed) the card sits
 * in on the page above this one.
 */
export function ApplicationCard({ app }: { app: TrackedApplication }) {
  const [, startTransition] = useTransition();
  const [optimistic, applyOptimistic] = useOptimistic<
    { status: ApplicationStatus; events: ApplicationEvent[] },
    TimelineAction
  >({ status: app.status, events: app.events }, (state, action) => {
    if (action.kind === 'record') {
      return {
        status: action.status,
        events: [{ id: `optimistic-${action.status}`, status: action.status, at: new Date(), note: null }, ...state.events],
      };
    }
    return { ...state, events: state.events.filter((e) => e.id !== action.eventId) };
  });
  const status = STATUS_COPY[optimistic.status];

  return (
    <div className={`${styles.card} ${app.needsFollowUp ? styles.cardNudged : ''}`}>
      <div className={styles.head}>
        <div className={styles.headLeft}>
          <h2 className={styles.title}>
            {app.externalUrl ? (
              <a href={app.externalUrl} target="_blank" rel="noreferrer" className={styles.titleLink}>
                {app.title}&nbsp;↗
              </a>
            ) : (
              app.title
            )}
          </h2>
          <div className={styles.meta}>
            {app.company && <span className={styles.metaCompany}>{app.company}</span>}
            {app.company && app.location && <span className={styles.metaSep}>|</span>}
            {app.location && <span>{app.location}</span>}
            <span className={styles.metaSep}>|</span>
            <span className={styles.metaSource}>via {app.source}</span>
          </div>
        </div>
        <span className={`${styles.status} ${styles[`status_${status.tone}`]}`}>{status.label}</span>
      </div>

      {/*
        The nudge states elapsed time and nothing else. The system cannot see
        whether anyone replied — I14 means that mail is never fetched — so it
        does not get to say "no response yet" (I15).
      */}
      {app.needsFollowUp && (
        <p className={styles.nudge}>
          Nothing recorded here since {elapsed(app.daysSinceLastEvent)}. If something has changed,
          add it below.
        </p>
      )}

      <ol className={styles.timeline}>
        {optimistic.events.map((e) => (
          <li key={e.id} className={styles.event}>
            <span className={styles.eventDot} aria-hidden />
            <span className={styles.eventLabel}>{STATUS_COPY[e.status].label}</span>
            <span className={styles.eventDate} title={formatTimestamp(e.at)}>
              {formatShortDate(e.at)}
            </span>
            {e.note && <span className={styles.eventNote}>{e.note}</span>}
            <button
              type="button"
              className={styles.eventUndo}
              title="Remove this entry"
              onClick={() =>
                startTransition(async () => {
                  applyOptimistic({ kind: 'remove', eventId: e.id });
                  await removeApplicationEvent(e.id);
                })
              }
            >
              remove
            </button>
          </li>
        ))}
      </ol>

      <div className={styles.actions}>
        <span className={styles.actionsLabel}>Record</span>
        {NEXT_STATUSES.filter((s) => s !== optimistic.status).map((s) => (
          <button
            key={s}
            type="button"
            className={styles.actionBtn}
            onClick={() =>
              startTransition(async () => {
                applyOptimistic({ kind: 'record', status: s });
                await recordApplicationEvent(app.id, s);
              })
            }
          >
            {STATUS_COPY[s].label}
          </button>
        ))}
      </div>
    </div>
  );
}
