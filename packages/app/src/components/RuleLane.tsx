import type { RuleKey, Verdict, Wording } from '@job-digest/core';
import { STATE_VISUALS } from './rule-visuals';
import styles from './RuleLane.module.css';

/**
 * Show less, but full (Nico, 3 Aug 2026).
 *
 * The lane used to render all five rules on every card, on the principle that
 * seeing a rule pass is information. Measured against the 103 ads actually in
 * the database, that principle was funding four chips of noise per card:
 * `rotating`, `weekend`, `german` and `payFte` are null on 103/103 ads,
 * `permanent` on 101/103. Four chips reading "not read" on every row is the
 * product announcing its own blind spot five times an ad, and it crowds out
 * the one chip that does carry something.
 *
 * So the split is by *whether the chip says anything about this ad*, not by
 * rule key:
 *
 * - a chip with the ad's own wording, or any `block`/`warn` outcome, renders
 *   as before — the outcome has to be visible even when the wording is thin;
 * - everything else collapses into at most three muted chips, grouped by the
 *   reason it is empty.
 *
 * Nothing is hidden: the expanded panel still walks all five rules, with the
 * quote and the per-rule explanation, exactly as it did. This is a change to
 * the density of the summary row, not to what the card is willing to tell you
 * — which keeps I4's bargain (an unread fact stays visible) while dropping the
 * repetition that made it unreadable.
 */
function cellValue(v: Verdict, wording: Partial<Wording>): string {
  return wording[v.key]?.value ?? '—';
}

interface Grouped {
  shown: Verdict[];
  /** The platform is on record as never sending this field (§9, migration 0007). */
  notSent: RuleKey[];
  /** No evidence either way — the common case today. */
  notRead: RuleKey[];
  /** The rule passed vacuously: the user set no constraint, so there is nothing to report. */
  noLimit: RuleKey[];
}

function group(
  verdicts: readonly Verdict[],
  wording: Partial<Wording>,
  platformFields: Record<string, boolean>,
): Grouped {
  const out: Grouped = { shown: [], notSent: [], notRead: [], noLimit: [] };
  for (const v of verdicts) {
    const hasWording = Boolean(wording[v.key]?.value);
    // A block or a warn is an outcome the user acts on; it renders even when
    // the wording is missing, or the card would silently drop the reason an
    // ad was filtered.
    if (hasWording || v.state === 'block' || v.state === 'warn') {
      out.shown.push(v);
    } else if (v.state === 'unknown') {
      if (platformFields[v.key.toLowerCase()] === false) out.notSent.push(v.key);
      else out.notRead.push(v.key);
    } else {
      out.noLimit.push(v.key);
    }
  }
  return out;
}

function MutedChip({ keys, text, compact }: { keys: RuleKey[]; text: string; compact?: boolean }) {
  if (keys.length === 0) return null;
  const label = `${keys.join(' · ')} ${text}`;
  return (
    <span className={`${styles.chip} ${styles.chipMuted} ${compact ? styles.chipCompact : ''}`} title={label}>
      {label}
    </span>
  );
}

export function RuleLane({
  verdicts,
  wording,
  platformFields = {},
  source,
  compact = false,
}: {
  verdicts: Verdict[];
  wording: Partial<Wording>;
  /** From DigestAd.platformFields (design §9) — separates "not sent" from "not read". */
  platformFields?: Record<string, boolean>;
  /** Named in the "not sent" copy, so the claim points at who did not send it. */
  source?: string;
  compact?: boolean;
}) {
  const { shown, notSent, notRead, noLimit } = group(verdicts, wording, platformFields);

  return (
    <div className={styles.lane}>
      {shown.map((v) => {
        const sv = STATE_VISUALS[v.state];
        const value = cellValue(v, wording);
        return (
          <span
            key={v.key}
            className={`${styles.chip} ${compact ? styles.chipCompact : ''}`}
            style={{ background: sv.bg, borderColor: sv.bd, color: sv.fg }}
            title={`${v.key}: ${sv.label} — ${value}`}
          >
            <span className={styles.glyph} style={{ background: sv.fg, color: sv.bg }} aria-label={sv.label}>
              {sv.glyph}
            </span>
            <span className={styles.name}>{v.key}:</span>
            {value}
          </span>
        );
      })}

      <MutedChip
        keys={notSent}
        text={source ? `not sent by ${source}` : 'not sent by this platform'}
        compact={compact}
      />
      <MutedChip keys={notRead} text="not in this email" compact={compact} />
      <MutedChip keys={noLimit} text="no limit set" compact={compact} />
    </div>
  );
}
