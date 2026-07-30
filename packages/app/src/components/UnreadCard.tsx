import type { UnreadEmail } from '@job-digest/db';
import { formatTimestamp } from '@/lib/format';
import { EDGE_COLOR, STATE_VISUALS } from './rule-visuals';
import styles from './UnreadCard.module.css';

/**
 * Mechanism-naming, non-apologetic copy per cause_code (design: "explains
 * the cause, not sorry"). These are generic rather than per-incident
 * narrative — this app doesn't yet capture the richer freeform "cause" text
 * the prototype's fixtures show (e.g. a specific date a layout changed); the
 * cause_code enum is what's actually stored, so the copy stays truthful to
 * that rather than inventing detail no field carries.
 */
const CAUSE_COPY: Record<string, string> = {
  layout_changed: "This platform's alert layout changed, and the reader's rules for it no longer match.",
  unknown_layout: "This is a page layout we haven't seen before. Nothing has been read from it yet.",
  no_text_part: 'The email body contains no readable text — likely an image with no text version.',
  unknown_block: "Some ads in this email used a markup pattern the reader doesn't recognize.",
  field_not_provided_by_platform: "This platform doesn't include this field in its alert emails — the data was never sent.",
  not_an_alert: 'This matched the sender filter but contains no vacancies.',
};

function outcomeState(outcome: UnreadEmail['outcome']): 'warn' | 'block' | 'unknown' {
  if (outcome === 'partial') return 'warn';
  if (outcome === 'none') return 'block';
  return 'unknown';
}

export function UnreadCard({ email }: { email: UnreadEmail }) {
  const state = outcomeState(email.outcome);
  const sv = STATE_VISUALS[state];
  const cause = email.causeCode ? CAUSE_COPY[email.causeCode] : null;
  const consequence = email.inDigest
    ? 'The ads that were read are in the digest, marked partly read.'
    : "None of this email's ads made it into the digest.";

  return (
    <div className={styles.card} style={{ borderLeftColor: EDGE_COLOR[state] }}>
      <div>
        {email.source && <span className={styles.chip}>{email.source}</span>}
        <p className={styles.subject}>„{email.subject}“</p>
        <span className={styles.timestamp}>{formatTimestamp(email.receivedAt)}</span>
        <div>
          <span className={styles.pill} style={{ background: sv.bg, borderColor: sv.bd, color: sv.fg }}>
            <span className={styles.pillGlyph}>{sv.glyph}</span>
            {email.status}
          </span>
        </div>
        {cause && <p className={styles.cause}>{cause}</p>}
        <p className={styles.consequence}>{consequence}</p>
      </div>
      <div>
        <p className={styles.fieldsLabel}>Fields</p>
        {email.fields.length > 0 && (
          <div className={styles.fieldsTable}>
            {email.fields.map((f) => (
              <div key={f.name} className={styles.fieldRow}>
                <span className={styles.fieldGlyph} style={{ color: f.ok ? 'var(--pass-fg)' : 'var(--block-fg)' }}>
                  {f.ok ? '✓' : '✕'}
                </span>
                <span className={styles.fieldName}>{f.name}</span>
                <span className={styles.fieldValue} style={{ color: f.ok ? 'inherit' : 'var(--block-fg)' }}>
                  {f.value}
                </span>
              </div>
            ))}
          </div>
        )}
        <div className={styles.links}>
          <a href={`/api/emails/${email.rawEmailId}/raw`} target="_blank" rel="noreferrer" className={styles.link}>
            Open the original email&nbsp;↗
          </a>
          {email.inDigest && (
            <a href="/digest" className={styles.link}>
              See what made it into the digest
            </a>
          )}
        </div>
      </div>
    </div>
  );
}
