'use client';

import { useState } from 'react';
import type { Ruleset } from '@job-digest/core';
import type { Digest, DigestAd } from '@job-digest/db';
import { AdCard } from './AdCard';
import { FilteredSection } from './FilteredSection';
import styles from './DigestList.module.css';

function AdList({
  ads,
  expandedId,
  onToggle,
}: {
  ads: DigestAd[];
  expandedId: string | null;
  onToggle: (id: string) => void;
}) {
  return (
    <div className={styles.adList}>
      {ads.map((ad) => (
        <AdCard
          key={ad.id}
          ad={ad}
          expanded={expandedId === ad.id}
          onToggle={() => onToggle(ad.id)}
        />
      ))}
    </div>
  );
}

function matchCountLine(n: number): string {
  if (n === 0) return 'No matches this week.';
  if (n === 1) return '1 match this week.';
  if (n <= 3) return `${n} matches this week — all worth your time.`;
  return `${n} matches this week.`;
}

/**
 * Owns the single-expand accordion state across all sections — opening one
 * card closes any other.
 */
export function DigestList({ digest, rules }: { digest: Digest; rules: Ruleset }) {
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const toggle = (id: string) => setExpandedId((cur) => (cur === id ? null : id));

  // Merge all curated tiers into a single flat list sorted by score desc.
  const matches: DigestAd[] = [
    ...digest.topPicks,
    ...digest.worthAReading,
    ...digest.stretch,
    ...digest.stillOpen,
  ].sort((a, b) => (b.scoreBreakdown?.total ?? 0) - (a.scoreBreakdown?.total ?? 0));

  const hasAnything =
    matches.length > 0 ||
    digest.explore.length > 0 ||
    digest.dismissed.length > 0;

  if (!hasAnything) {
    return <p className={styles.empty}>No ads arrived in this window.</p>;
  }

  return (
    <div className={styles.root}>
      <p className={styles.matchCount}>{matchCountLine(matches.length)}</p>

      {matches.length > 0 && (
        <AdList ads={matches} expandedId={expandedId} onToggle={toggle} />
      )}

      <FilteredSection
        dismissed={digest.dismissed}
        rules={rules}
        rulesetVersion={digest.rulesetVersion}
      />
    </div>
  );
}
