'use client';

import { useState, useTransition } from 'react';
import { addSource, removeSource } from '@/lib/source-actions';
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

export function SourcesManager({ initial }: { initial: Source[] }) {
  const [sources, setSources] = useState(initial);
  const [url, setUrl] = useState('');
  const [addError, setAddError] = useState<string | null>(null);
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
      // Re-fetch the list by reloading the page data — simpler than passing
      // the full source object back from the action.
      window.location.reload();
    });
  }

  function handleRemove(id: string) {
    startTransition(async () => {
      setSources((prev) => prev.filter((s) => s.id !== id));
      await removeSource(id);
    });
  }

  return (
    <div className={styles.wrapper}>
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
    </div>
  );
}
