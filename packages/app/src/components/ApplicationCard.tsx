'use client';

import { useTransition } from 'react';
import type { ApplicationStatus, TrackedApplication } from '@job-digest/db';
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

export function ApplicationCard({ app }: { app: TrackedApplication }) {
  const [pending, startTransition] = useTransition();
  const status = STATUS_COPY[app.status];

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
        {app.events.map((e) => (
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
              disabled={pending}
              title="Remove this entry"
              onClick={() => startTransition(() => removeApplicationEvent(e.id))}
            >
              remove
            </button>
          </li>
        ))}
      </ol>

      <div className={styles.actions}>
        <span className={styles.actionsLabel}>Record</span>
        {NEXT_STATUSES.filter((s) => s !== app.status).map((s) => (
          <button
            key={s}
            type="button"
            className={styles.actionBtn}
            disabled={pending}
            onClick={() => startTransition(() => recordApplicationEvent(app.id, s))}
          >
            {STATUS_COPY[s].label}
          </button>
        ))}
      </div>
    </div>
  );
}
