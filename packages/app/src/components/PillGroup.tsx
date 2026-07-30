'use client';

import styles from './PillGroup.module.css';

export interface PillOption {
  label: string;
  active: boolean;
  onClick: () => void;
}

/** Pill toggles, transcribed from the prototype's opt() styling (active: ink/white). */
export function PillGroup({ label, options }: { label: string; options: PillOption[] }) {
  return (
    <div className={styles.group}>
      <p className={styles.groupLabel}>{label}</p>
      <div className={styles.pills}>
        {options.map((o) => (
          <button
            key={o.label}
            type="button"
            className={`${styles.pill} ${o.active ? styles.pillActive : ''}`}
            onClick={o.onClick}
          >
            {o.label}
          </button>
        ))}
      </div>
    </div>
  );
}
