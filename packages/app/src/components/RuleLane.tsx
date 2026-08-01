import type { Verdict, Wording } from '@job-digest/core';
import { STATE_VISUALS } from './rule-visuals';
import styles from './RuleLane.module.css';

/**
 * Chip text: the ad's own wording when we have it. When it's genuinely
 * unknown, a plain "not read" conflates two different things (design §9) — a
 * field the platform is on record as never sending (platformFields[key] ===
 * false) reads instead as "not sent", which is the honest claim and the one
 * that stops the user re-opening the ad hoping to find something that was
 * never there. No evidence either way (the common case today — see migration
 * 0007) stays "not read".
 */
function cellValue(v: Verdict, wording: Partial<Wording>, platformFields: Record<string, boolean>): string {
  const w = wording[v.key];
  if (w?.value) return w.value;
  if (v.state !== 'unknown') return '—';
  return platformFields[v.key.toLowerCase()] === false ? 'not sent' : 'not read';
}

/**
 * Chips treatment (design's three explorations — Nico's pick, 30 Jul, over
 * the doc's own `lane` recommendation). Always renders all five rules, in
 * the fixed order, even the ones that pass: seeing a rule pass is
 * information (design principle).
 */
export function RuleLane({
  verdicts,
  wording,
  platformFields = {},
  compact = false,
}: {
  verdicts: Verdict[];
  wording: Partial<Wording>;
  /** From DigestAd.platformFields (design §9) — see cellValue. */
  platformFields?: Record<string, boolean>;
  compact?: boolean;
}) {
  return (
    <div className={styles.lane}>
      {verdicts.map((v) => {
        const sv = STATE_VISUALS[v.state];
        const value = cellValue(v, wording, platformFields);
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
    </div>
  );
}
