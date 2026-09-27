'use client';

import { useRef, useState, useTransition } from 'react';
import { updateLocation } from '@/lib/actions';
import styles from './LocationEditor.module.css';

export function LocationEditor({ city, remoteOk }: { city: string | null; remoteOk: boolean }) {
  const [, startTransition] = useTransition();
  const [saved, setSaved] = useState(false);
  const cityRef = useRef<HTMLInputElement>(null);
  const remoteRef = useRef<HTMLInputElement>(null);

  function handleSave() {
    const newCity = cityRef.current?.value ?? '';
    const newRemote = remoteRef.current?.checked ?? false;
    startTransition(async () => {
      await updateLocation(newCity, newRemote);
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    });
  }

  return (
    <div className={styles.card}>
      <div className={styles.field}>
        <label className={styles.label} htmlFor="location-city">
          City
        </label>
        <input
          id="location-city"
          ref={cityRef}
          type="text"
          className={styles.input}
          defaultValue={city ?? ''}
          placeholder="e.g. Hamburg"
        />
      </div>

      <label className={styles.checkLabel}>
        <input
          id="location-remote"
          ref={remoteRef}
          type="checkbox"
          className={styles.checkbox}
          defaultChecked={remoteOk}
        />
        Remote jobs count as local
      </label>

      <div className={styles.footer}>
        <button type="button" className={styles.saveBtn} onClick={handleSave}>
          {saved ? 'Saved' : 'Save'}
        </button>
        <p className={styles.hint}>
          {city
            ? `Jobs in ${city}${remoteOk ? ' or remote' : ''} rank first; the rest of the country, then Europe, then further away rank lower. Nothing is hidden for its location.`
            : 'No city set — jobs are not ranked by location.'}
        </p>
      </div>
    </div>
  );
}
