'use client';

import { useState, useTransition } from 'react';
import { toggleCuratedCompany, type CuratedEntry } from '@/lib/source-actions';
import { marketLabel, type Market } from '@/lib/market';
import styles from './CuratedCatalog.module.css';

/**
 * The primary "add companies" flow: a grid of curated cards from our catalog,
 * one toggle each. Replaces URL-pasting as the default path — the user picks
 * from companies we've already vetted rather than knowing board slugs by
 * heart. The URL form stays available as an escape hatch (SourcesManager
 * hides it behind an "Add custom board" toggle).
 *
 * Optimistic: the toggle flips on click, the server action runs after. On
 * error we revert and surface the message inline. The one thing we do NOT
 * do here is refetch immediately after enabling — the ad won't appear in
 * the next digest until the next fetch cycle runs (adding is a
 * subscription, not a search).
 */
export function CuratedCatalog({
  initialMarket,
  initialEntries,
  cityKnown,
}: {
  initialMarket: Market;
  initialEntries: CuratedEntry[];
  cityKnown: boolean;
}) {
  const [market, setMarket] = useState<Market>(initialMarket);
  const [entries, setEntries] = useState(initialEntries);
  const [pendingSlugs, setPendingSlugs] = useState<Set<string>>(new Set());
  const [err, setErr] = useState<string | null>(null);
  const [, startTransition] = useTransition();

  function key(e: CuratedEntry): string {
    return `${e.provider}::${e.slug}`;
  }

  function handleToggle(entry: CuratedEntry) {
    setErr(null);
    const k = key(entry);
    const nextActive = !entry.active;

    // Optimistic flip.
    setEntries((prev) => prev.map((e) => (key(e) === k ? { ...e, active: nextActive } : e)));
    setPendingSlugs((prev) => new Set(prev).add(k));

    startTransition(async () => {
      const result = await toggleCuratedCompany({
        provider: entry.provider,
        slug: entry.slug,
        on: nextActive,
      });
      setPendingSlugs((prev) => {
        const next = new Set(prev);
        next.delete(k);
        return next;
      });
      if ('error' in result) {
        // Revert.
        setEntries((prev) =>
          prev.map((e) => (key(e) === k ? { ...e, active: !nextActive } : e)),
        );
        setErr(result.error);
      }
    });
  }

  function handleMarketChange(next: Market) {
    setMarket(next);
    // Full page reload to re-fetch the catalog for the new market. Cheap;
    // the whole profile page revalidates.
    const url = new URL(window.location.href);
    url.searchParams.set('catalogMarket', next);
    window.location.href = url.toString();
  }

  const enabledCount = entries.filter((e) => e.active).length;

  return (
    <div className={styles.wrapper}>
      <div className={styles.header}>
        <div>
          <p className={styles.title}>Curated companies</p>
          <p className={styles.sub}>
            {enabledCount}/{entries.length} selected for {marketLabel(market)}
            {!cityKnown && market !== 'ALL' && ' (set your city in Location to remember this)'}
          </p>
        </div>
        <div className={styles.marketPicker}>
          {(['DACH', 'ES', 'AR', 'ALL'] as Market[]).map((m) => (
            <button
              key={m}
              type="button"
              onClick={() => handleMarketChange(m)}
              className={`${styles.marketBtn} ${market === m ? styles.marketBtnActive : ''}`}
            >
              {m === 'DACH' ? 'DACH' : m === 'ES' ? 'Spain' : m === 'AR' ? 'Argentina' : 'All'}
            </button>
          ))}
        </div>
      </div>

      {entries.length === 0 ? (
        <p className={styles.empty}>
          No curated companies yet for this market. Add boards manually below.
        </p>
      ) : (
        <div className={styles.grid}>
          {entries.map((e) => {
            const k = key(e);
            const pending = pendingSlugs.has(k);
            return (
              <label
                key={k}
                className={`${styles.card} ${e.active ? styles.cardActive : ''} ${pending ? styles.cardPending : ''}`}
              >
                <div className={styles.cardHead}>
                  <span className={styles.name}>{e.name}</span>
                  <input
                    type="checkbox"
                    className={styles.checkbox}
                    checked={e.active}
                    onChange={() => handleToggle(e)}
                    disabled={pending}
                    aria-label={`${e.active ? 'Remove' : 'Add'} ${e.name}`}
                  />
                </div>
                {e.city && <span className={styles.city}>{e.city}</span>}
                {e.curatorNote && <p className={styles.note}>{e.curatorNote}</p>}
                {e.tags.length > 0 && (
                  <div className={styles.tags}>
                    {e.tags.map((t) => (
                      <span key={t} className={styles.tag}>{t}</span>
                    ))}
                  </div>
                )}
              </label>
            );
          })}
        </div>
      )}
      {err && <p className={styles.error}>{err}</p>}
    </div>
  );
}
