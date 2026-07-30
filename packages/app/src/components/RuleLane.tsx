import type { Verdict, Wording } from '@job-digest/core';
import { STATE_VISUALS } from './rule-visuals';
import styles from './RuleLane.module.css';

/** Chip text: the ad's own wording when we have it, an honest fallback when we don't. */
function cellValue(v: Verdict, wording: Partial<Wording>): string {
  const w = wording[v.key];
  if (w?.value) return w.value;
  return v.state === 'unknown' ? 'not read' : '—';
}

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
    <div className={`${styles.lane} ${compact ? styles.laneCompact : ''}`}>
      {verdicts.map((v) => {
        const sv = STATE_VISUALS[v.state];
        const detail = `${v.key}: ${sv.label} — ${cellValue(v, wording)}`;
        if (compact) {
          return (
            <div
              key={v.key}
              className={`${styles.cell} ${styles.cellCompact}`}
              style={{ background: sv.bg, borderColor: sv.bd }}
              title={detail}
            >
              <span className={styles.glyphCompact} style={{ color: sv.fg }} aria-label={sv.label}>
                {sv.glyph}
              </span>
            </div>
          );
        }
        return (
          <div
            key={v.key}
            className={styles.cell}
            style={{ background: sv.bg, borderColor: sv.bd }}
            title={detail}
          >
            <div className={styles.top}>
              <span className={styles.glyph} style={{ background: sv.fg, color: sv.bg }} aria-label={sv.label}>
                {sv.glyph}
              </span>
              <span className={styles.name} style={{ color: sv.fg }}>
                {v.key}
              </span>
            </div>
            <div className={styles.value} style={{ color: sv.fg }}>
              {cellValue(v, wording)}
            </div>
          </div>
        );
      })}
    </div>
  );
}
