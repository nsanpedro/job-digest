'use client';

import { useState } from 'react';
import type { Ruleset } from '@job-digest/core';
import type { Digest, DigestAd, DigestMetrics } from '@job-digest/db';
import { AdCard } from './AdCard';
import { FilteredSection } from './FilteredSection';
import styles from './DigestList.module.css';

const EXPLORE_PAGE_SIZE = 30;

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

function TierSection({
  label,
  note,
  ads,
  expandedId,
  onToggle,
}: {
  label: string;
  note: string;
  ads: DigestAd[];
  expandedId: string | null;
  onToggle: (id: string) => void;
}) {
  if (ads.length === 0) return null;
  return (
    <section className={styles.tier}>
      <div className={styles.tierHeader}>
        <span className={styles.tierLabel}>{label}</span>
        <span className={styles.tierNote}>{note}</span>
      </div>
      <AdList ads={ads} expandedId={expandedId} onToggle={onToggle} />
    </section>
  );
}

function exploreNote(breakdown: DigestMetrics['explore']): string | null {
  if (!breakdown) return null;
  const parts: string[] = [];
  if (breakdown.preFilterMisses > 0) {
    parts.push(`${breakdown.preFilterMisses} filtered by location or direction`);
  }
  // Includes both new ads that scored below the curated thresholds and
  // repeats from earlier weeks that didn't fit under the "still open" cap.
  // The label stays neutral so it holds honest for both.
  if (breakdown.belowThreshold > 0) {
    parts.push(`${breakdown.belowThreshold} ranked outside the curated tiers`);
  }
  return parts.length > 0 ? parts.join(' · ') : null;
}

function ExploreSection({
  ads,
  breakdown,
  expandedId,
  onToggle,
}: {
  ads: DigestAd[];
  breakdown: DigestMetrics['explore'];
  expandedId: string | null;
  onToggle: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [page, setPage] = useState(1);
  if (ads.length === 0) return null;
  const shown = ads.slice(0, page * EXPLORE_PAGE_SIZE);
  const hasMore = shown.length < ads.length;
  const note = exploreNote(breakdown);

  return (
    <div className={styles.explore}>
      <button
        className={styles.exploreToggle}
        onClick={() => setOpen((v) => !v)}
        type="button"
      >
        <span className={styles.exploreChevron}>{open ? '▾' : '▸'}</span>
        <span>
          {ads.length} ad{ads.length === 1 ? '' : 's'} · explore
        </span>
      </button>
      {open && (
        <div className={styles.exploreList}>
          {note && <p className={styles.exploreNote}>{note}</p>}
          <AdList ads={shown} expandedId={expandedId} onToggle={onToggle} />
          {hasMore && (
            <button
              className={styles.loadMore}
              onClick={() => setPage((p) => p + 1)}
              type="button"
            >
              Show {Math.min(EXPLORE_PAGE_SIZE, ads.length - shown.length)} more
            </button>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Owns the single-expand accordion state across all tiers — opening one card
 * closes any other, regardless of which tier it's in.
 */
export function DigestList({ digest, rules }: { digest: Digest; rules: Ruleset }) {
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const toggle = (id: string) => setExpandedId((cur) => (cur === id ? null : id));

  const totalInDigest =
    digest.topPicks.length + digest.worthAReading.length + digest.stretch.length;

  if (totalInDigest === 0 && digest.dismissed.length === 0 && digest.explore.length === 0) {
    return <p className={styles.empty}>No ads arrived in this window.</p>;
  }

  return (
    <div className={styles.root}>
      <TierSection
        label="Top picks"
        note="Strong match — apply this week"
        ads={digest.topPicks}
        expandedId={expandedId}
        onToggle={toggle}
      />
      <TierSection
        label="Worth a read"
        note=""
        ads={digest.worthAReading}
        expandedId={expandedId}
        onToggle={toggle}
      />
      <TierSection
        label="Stretch"
        note="Failed a preference — good direction fit"
        ads={digest.stretch}
        expandedId={expandedId}
        onToggle={toggle}
      />
      <TierSection
        label="Still open from earlier weeks"
        note="First seen before this week — kept out of curated on purpose"
        ads={digest.stillOpen}
        expandedId={expandedId}
        onToggle={toggle}
      />
      <ExploreSection
        ads={digest.explore}
        breakdown={digest.metrics.explore}
        expandedId={expandedId}
        onToggle={toggle}
      />
      <FilteredSection
        dismissed={digest.dismissed}
        rules={rules}
        rulesetVersion={digest.rulesetVersion}
      />
    </div>
  );
}
