import type { Verdict, Wording } from '@job-digest/core';
import { STATE_VISUALS } from './rule-visuals';
import styles from './RuleLane.module.css';

/** Chip text: the ad's own wording when we have it, an honest fallback when we don't. */
function cellValue(v: Verdict, wording: Partial<Wording>): string {
  const w = wording[v.key];
  if (w?.value) return w.value;
  return v.state === 'unknown' ? 'not read' : '—';
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
  compact = false,
}: {
  verdicts: Verdict[];
  wording: Partial<Wording>;
  compact?: boolean;
}) {
  return (
    <div className={styles.lane}>
      {verdicts.map((v) => {
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
    </div>
  );
}
