'use client';

import { useState, useTransition } from 'react';
import { addSource, approveSuggestedSource, dismissSuggestedSource, removeSource, type CuratedEntry } from '@/lib/source-actions';
import type { Market } from '@/lib/market';
import { CuratedCatalog } from './CuratedCatalog';
import styles from './SourcesManager.module.css';

interface Source {
  id: string;
  provider: string;
  externalSlug: string;
  displayName: string;
  status: string;
  lastFetchedAt: Date | null;
  lastError: { kind: string; message: string; at: string } | null;
}

interface SuggestedSource {
  id: string;
  provider: string;
  displayName: string;
  externalSlug: string;
}

export function SourcesManager({
  initial,
  initialSuggestions,
  catalog,
}: {
  initial: Source[];
  initialSuggestions: SuggestedSource[];
  catalog: {
    market: Market;
    entries: CuratedEntry[];
    cityKnown: boolean;
  };
}) {
  const [sources, setSources] = useState(initial);
  const [suggestions, setSuggestions] = useState(initialSuggestions);
  const [url, setUrl] = useState('');
  const [addError, setAddError] = useState<string | null>(null);
  const [showCustom, setShowCustom] = useState(false);
  const [pending, startTransition] = useTransition();

  function handleAdd(e: React.FormEvent) {
    e.preventDefault();
    if (!url.trim()) return;
    setAddError(null);
    startTransition(async () => {
      const result = await addSource(url.trim());
      if ('error' in result) {
        setAddError(result.error);
        return;
      }
      window.location.reload();
    });
  }

  function handleRemove(id: string) {
    startTransition(async () => {
      setSources((prev) => prev.filter((s) => s.id !== id));
      await removeSource(id);
    });
  }

  function handleApprove(id: string) {
    startTransition(async () => {
      const s = suggestions.find((s) => s.id === id);
      setSuggestions((prev) => prev.filter((s) => s.id !== id));
      if (s) {
        setSources((prev) => [
          ...prev,
          { id: s.id, provider: s.provider, externalSlug: s.externalSlug, displayName: s.displayName, status: 'active', lastFetchedAt: null, lastError: null },
        ].sort((a, b) => a.displayName.localeCompare(b.displayName)));
      }
      await approveSuggestedSource(id);
    });
  }

  function handleDismiss(id: string) {
    startTransition(async () => {
      setSuggestions((prev) => prev.filter((s) => s.id !== id));
      await dismissSuggestedSource(id);
    });
  }

  return (
    <div>
      <CuratedCatalog
        initialMarket={catalog.market}
        initialEntries={catalog.entries}
        cityKnown={catalog.cityKnown}
      />

      <div className={styles.wrapper}>
        {suggestions.length > 0 && (
          <div className={styles.suggestions}>
            <p className={styles.suggestionsLabel}>
              Found {suggestions.length} job board{suggestions.length > 1 ? 's' : ''} from companies in your digest
            </p>
            {suggestions.map((s) => (
              <div key={s.id} className={styles.suggestionRow}>
                <div className={styles.info}>
                  <span className={styles.name}>{s.displayName}</span>
                  <span className={styles.meta}>{s.provider} · {s.externalSlug}</span>
                </div>
                <div className={styles.suggestionActions}>
                  <button
                    type="button"
                    className={styles.approveBtn}
                    disabled={pending}
                    onClick={() => handleApprove(s.id)}
                  >
                    Add
                  </button>
                  <button
                    type="button"
                    className={styles.dismissBtn}
                    disabled={pending}
                    onClick={() => handleDismiss(s.id)}
                  >
                    Dismiss
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}

        {sources.length > 0 && (
          <div className={styles.list}>
            {sources.map((s) => (
              <div key={s.id} className={styles.row}>
                <div className={styles.info}>
                  <span className={styles.name}>{s.displayName}</span>
                  <span className={styles.meta}>
                    {s.provider} · {s.externalSlug}
                    {s.lastFetchedAt && (
                      <> · last fetched {new Date(s.lastFetchedAt).toLocaleDateString()}</>
                    )}
                  </span>
                  {s.status === 'failing' && s.lastError && (
                    <span className={styles.errorNote}>{s.lastError.message}</span>
                  )}
                </div>
                <div className={styles.right}>
                  <span className={`${styles.pill} ${s.status === 'failing' ? styles.pillFail : styles.pillOk}`}>
                    {s.status}
                  </span>
                  <button
                    type="button"
                    className={styles.removeBtn}
                    disabled={pending}
                    onClick={() => handleRemove(s.id)}
                  >
                    Remove
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}

        <button
          type="button"
          className={styles.customToggle}
          onClick={() => setShowCustom((v) => !v)}
          aria-expanded={showCustom}
        >
          {showCustom ? '− Hide custom board' : '+ Add a custom board (paste URL)'}
        </button>

        {showCustom && (
          <>
            <form className={styles.form} onSubmit={handleAdd}>
              <input
                type="url"
                className={styles.input}
                placeholder="boards.greenhouse.io/stripe"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                disabled={pending}
              />
              <button type="submit" className={styles.addBtn} disabled={pending || !url.trim()}>
                {pending ? 'Adding…' : 'Add company'}
              </button>
            </form>
            {addError && <p className={styles.error}>{addError}</p>}
            <p className={styles.hint}>
              Paste a Greenhouse, Lever, Ashby, or Personio job board URL. We fetch open roles and
              filter them through your rules — no alert setup needed.
            </p>
          </>
        )}
      </div>
    </div>
  );
}
