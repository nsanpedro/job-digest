'use client';

import { useState } from 'react';
import type { Ruleset } from '@job-digest/core';
import type { Digest, DigestAd } from '@job-digest/db';
import { AdCard } from './AdCard';
import { FilteredSection } from './FilteredSection';
import styles from './DigestList.module.css';

const PAGE_SIZE = 30;

function AdPage({
  ads,
  expandedId,
  onToggle,
}: {
  ads: DigestAd[];
  expandedId: string | null;
  onToggle: (id: string) => void;
}) {
  return (
    <>
      {ads.map((ad) => (
        <AdCard
          key={ad.id}
          ad={ad}
          expanded={expandedId === ad.id}
          onToggle={() => onToggle(ad.id)}
        />
      ))}
    </>
  );
}

/**
 * Collapsed explore bucket — all ads that didn't make the Top 10.
 * Step 4 will add tier labels (Top / Read / Stretch) above this component;
 * for now it keeps the existing "scroll past the main list" UX intact.
 */
function ExploreSection({ ads, expandedId, onToggle }: { ads: DigestAd[]; expandedId: string | null; onToggle: (id: string) => void }) {
  const [open, setOpen] = useState(false);
  const [page, setPage] = useState(1);
  if (ads.length === 0) return null;
  const shown = ads.slice(0, page * PAGE_SIZE);
  const hasMore = shown.length < ads.length;

  return (
    <div className={styles.offTarget}>
      <button className={styles.offTargetToggle} onClick={() => setOpen((v) => !v)} type="button">
        <span>{open ? '▾' : '▸'}</span>
        <span>
          {ads.length} more job{ads.length === 1 ? '' : 's'} — explore
        </span>
      </button>
      {open && (
        <div className={styles.offTargetList}>
          <AdPage ads={shown} expandedId={expandedId} onToggle={onToggle} />
          {hasMore && (
            <button
              className={styles.loadMore}
              onClick={() => setPage((p) => p + 1)}
              type="button"
            >
              Show {Math.min(PAGE_SIZE, ads.length - shown.length)} more
            </button>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Owns the accordion state (design: "Un solo aviso expandido a la vez —
 * abrir uno cierra el otro"), which is why it has to be one client component
 * spanning every card rather than local state inside each AdCard.
 *
 * Step 4 will add tier section headers (Top picks / Worth a read / Stretch).
 * For now the three tiers are rendered as a flat list so the digest remains
 * functional while step 3 lands.
 */
export function DigestList({ digest, rules }: { digest: Digest; rules: Ruleset }) {
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [page, setPage] = useState(1);

  const toggle = (id: string) => setExpandedId((cur) => (cur === id ? null : id));

  const inDigest = [...digest.topPicks, ...digest.worthAReading, ...digest.stretch];

  if (inDigest.length === 0 && digest.dismissed.length === 0 && digest.explore.length === 0) {
    return <p className={styles.empty}>No ads arrived in this window.</p>;
  }

  const shown = inDigest.slice(0, page * PAGE_SIZE);
  const hasMore = shown.length < inDigest.length;

  return (
    <>
      <div className={styles.list}>
        <AdPage ads={shown} expandedId={expandedId} onToggle={toggle} />
      </div>
      {hasMore && (
        <button
          className={styles.loadMore}
          onClick={() => setPage((p) => p + 1)}
          type="button"
        >
          Show {Math.min(PAGE_SIZE, inDigest.length - shown.length)} more
        </button>
      )}
      <ExploreSection ads={digest.explore} expandedId={expandedId} onToggle={toggle} />
      <FilteredSection dismissed={digest.dismissed} rules={rules} rulesetVersion={digest.rulesetVersion} />
    </>
  );
}
