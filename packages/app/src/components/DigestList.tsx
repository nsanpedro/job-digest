'use client';

import { useState } from 'react';
import type { Ruleset } from '@job-digest/core';
import type { Digest } from '@job-digest/db';
import { AdCard } from './AdCard';
import { FilteredSection } from './FilteredSection';
import styles from './DigestList.module.css';

/**
 * Owns the accordion state (design: "Un solo aviso expandido a la vez —
 * abrir uno cierra el otro"), which is why it has to be one client component
 * spanning every card rather than local state inside each AdCard.
 */
export function DigestList({ digest, rules }: { digest: Digest; rules: Ruleset }) {
  const [expandedId, setExpandedId] = useState<string | null>(null);

  if (digest.visible.length === 0 && digest.dismissed.length === 0) {
    return <p className={styles.empty}>No ads arrived in this window.</p>;
  }

  return (
    <>
      <div className={styles.list}>
        {digest.visible.map((ad) => (
          <AdCard
            key={ad.id}
            ad={ad}
            expanded={expandedId === ad.id}
            onToggle={() => setExpandedId((id) => (id === ad.id ? null : ad.id))}
          />
        ))}
      </div>
      <FilteredSection dismissed={digest.dismissed} rules={rules} rulesetVersion={digest.rulesetVersion} />
    </>
  );
}
