'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import {
  completeOnboarding,
  connectGmailForOnboarding,
  fetchOnboardingPreview,
  skipOnboarding,
  type OnboardingCategory,
} from '@/lib/onboarding-actions';
import styles from './OnboardingModal.module.css';

const CATEGORIES: { label: OnboardingCategory; emoji: string }[] = [
  { label: 'Engineering', emoji: '💻' },
  { label: 'Product', emoji: '🗂️' },
  { label: 'Design', emoji: '🎨' },
  { label: 'Data', emoji: '📊' },
  { label: 'Marketing', emoji: '📣' },
  { label: 'Sales', emoji: '🤝' },
  { label: 'Operations', emoji: '⚙️' },
  { label: 'Other', emoji: '✦' },
];

interface PreviewJob {
  displayName: string;
  title: string;
  locationRaw: string | null;
  externalUrl: string;
}

export function OnboardingModal() {
  const router = useRouter();
  const [step, setStep] = useState(1);
  const [category, setCategory] = useState<OnboardingCategory | null>(null);
  const [city, setCity] = useState('');
  const [remoteOk, setRemoteOk] = useState(false);
  const [preview, setPreview] = useState<PreviewJob[] | null>(null);
  const [isPending, startTransition] = useTransition();

  function goToStep3() {
    setPreview(null);
    setStep(3);
    startTransition(async () => {
      const jobs = await fetchOnboardingPreview(category!, city || null, remoteOk);
      setPreview(jobs);
    });
  }

  function handleSkip() {
    startTransition(async () => {
      await skipOnboarding();
      router.refresh();
    });
  }

  function handleComplete() {
    startTransition(async () => {
      await completeOnboarding({ category: category!, city: city || null, remoteOk });
      router.refresh();
    });
  }

  function handleConnectGmail() {
    startTransition(async () => {
      await connectGmailForOnboarding({ category: category!, city: city || null, remoteOk });
    });
  }

  return (
    <div className={styles.backdrop}>
      <div className={styles.card}>
        {/* Step indicators */}
        <div className={styles.steps}>
          {[1, 2, 3, 4].map((s) => (
            <div
              key={s}
              className={`${styles.stepBar} ${step >= s ? styles.stepBarActive : ''}`}
            />
          ))}
        </div>

        {/* ── Step 1: Category ── */}
        {step === 1 && (
          <>
            <p className={styles.title}>What kind of job are you looking for?</p>
            <p className={styles.subtitle}>
              We'll show you real openings from companies in your field.
            </p>
            <div className={styles.categoryGrid}>
              {CATEGORIES.map(({ label, emoji }) => (
                <button
                  key={label}
                  className={`${styles.categoryCard} ${category === label ? styles.categoryCardSelected : ''}`}
                  onClick={() => setCategory(label)}
                >
                  <span className={styles.categoryEmoji}>{emoji}</span>
                  {label}
                </button>
              ))}
            </div>
            <div className={styles.footer}>
              <button className={styles.skipBtn} onClick={handleSkip} disabled={isPending}>
                Skip setup
              </button>
              <div className={styles.footerActions}>
                <button
                  className={styles.btnPrimary}
                  disabled={!category || isPending}
                  onClick={() => setStep(2)}
                >
                  Continue
                </button>
              </div>
            </div>
          </>
        )}

        {/* ── Step 2: Location ── */}
        {step === 2 && (
          <>
            <p className={styles.title}>Where are you looking?</p>
            <p className={styles.subtitle}>
              Used to filter the preview — you can change this any time from your profile.
            </p>
            <div className={styles.field}>
              <label className={styles.fieldLabel} htmlFor="onboarding-city">
                City
              </label>
              <input
                id="onboarding-city"
                className={styles.input}
                type="text"
                placeholder="e.g. Barcelona, Berlin, Buenos Aires"
                value={city}
                onChange={(e) => setCity(e.target.value)}
                autoFocus
              />
            </div>
            <label className={styles.checkRow}>
              <input
                type="checkbox"
                checked={remoteOk}
                onChange={(e) => setRemoteOk(e.target.checked)}
              />
              <span className={styles.checkLabel}>Remote OK</span>
            </label>
            <div className={styles.footer}>
              <button className={styles.skipBtn} onClick={handleSkip} disabled={isPending}>
                Skip setup
              </button>
              <div className={styles.footerActions}>
                <button className={styles.btnSecondary} onClick={() => setStep(1)}>
                  Back
                </button>
                <button className={styles.btnPrimary} disabled={isPending} onClick={goToStep3}>
                  Show me jobs
                </button>
              </div>
            </div>
          </>
        )}

        {/* ── Step 3: Preview ── */}
        {step === 3 && (
          <>
            <p className={styles.title}>
              {category} roles{city ? ` near ${city}` : ''}
              {remoteOk ? ' (+ remote)' : ''}
            </p>
            <p className={styles.subtitle}>
              Live openings from curated companies — no inbox needed yet.
            </p>
            {preview === null ? (
              <div className={styles.loading}>Loading jobs…</div>
            ) : preview.length === 0 ? (
              <div className={styles.previewEmpty}>
                No matches in the preview cache yet — the cache refreshes daily.
                <br />
                Once you connect Gmail, your real alerts will start populating your digest.
              </div>
            ) : (
              <div className={styles.previewList}>
                {preview.map((job, i) => (
                  <a
                    key={i}
                    href={job.externalUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className={styles.previewJob}
                  >
                    <span className={styles.previewJobTitle}>{job.title}</span>
                    <span className={styles.previewJobMeta}>
                      {job.displayName}
                      {job.locationRaw ? ` · ${job.locationRaw}` : ''}
                    </span>
                  </a>
                ))}
              </div>
            )}
            <div className={styles.footer}>
              <button className={styles.skipBtn} onClick={handleSkip} disabled={isPending}>
                Skip setup
              </button>
              <div className={styles.footerActions}>
                <button className={styles.btnSecondary} onClick={() => setStep(2)}>
                  Back
                </button>
                <button
                  className={styles.btnPrimary}
                  disabled={isPending || preview === null}
                  onClick={() => setStep(4)}
                >
                  Continue
                </button>
              </div>
            </div>
          </>
        )}

        {/* ── Step 4: Gmail ── */}
        {step === 4 && (
          <>
            <p className={styles.title}>Get jobs from your inbox too</p>
            <p className={styles.subtitle}>
              Connect Gmail to pull job alerts you already get from LinkedIn, Xing, and other
              platforms. Job Digest reads only job-alert emails.
            </p>
            <div className={styles.gmailBox}>
              <p className={styles.gmailBoxTitle}>Connect Gmail</p>
              <p className={styles.gmailBoxHint}>
                We request read-only access. Your credentials stay encrypted and are never shared.
                You can disconnect at any time from your profile.
              </p>
              <button
                className={styles.btnPrimary}
                type="button"
                disabled={isPending}
                onClick={handleConnectGmail}
              >
                {isPending ? 'Connecting…' : 'Connect Gmail'}
              </button>
            </div>
            <div className={styles.footer}>
              <button className={styles.btnSecondary} onClick={() => setStep(3)}>
                Back
              </button>
              <div className={styles.footerActions}>
                <button
                  className={styles.btnPrimary}
                  disabled={isPending}
                  onClick={handleComplete}
                >
                  {isPending ? 'Saving…' : "I'll connect later"}
                </button>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
