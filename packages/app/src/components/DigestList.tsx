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

function OffTargetSection({ ads, expandedId, onToggle }: { ads: DigestAd[]; expandedId: string | null; onToggle: (id: string) => void }) {
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
          {ads.length} job{ads.length === 1 ? '' : 's'} outside your role directions
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
 */
export function DigestList({ digest, rules }: { digest: Digest; rules: Ruleset }) {
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [page, setPage] = useState(1);

  const toggle = (id: string) => setExpandedId((cur) => (cur === id ? null : id));

  if (digest.visible.length === 0 && digest.dismissed.length === 0 && digest.offTarget.length === 0) {
    return <p className={styles.empty}>No ads arrived in this window.</p>;
  }

  const shown = digest.visible.slice(0, page * PAGE_SIZE);
  const hasMore = shown.length < digest.visible.length;

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
          Show {Math.min(PAGE_SIZE, digest.visible.length - shown.length)} more
        </button>
      )}
      <OffTargetSection ads={digest.offTarget} expandedId={expandedId} onToggle={toggle} />
      <FilteredSection dismissed={digest.dismissed} rules={rules} rulesetVersion={digest.rulesetVersion} />
    </>
  );
}
