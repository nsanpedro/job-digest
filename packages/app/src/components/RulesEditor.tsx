'use client';

import { useState, useTransition } from 'react';
import { RULE_KEYS, type ConditionByKey, type Level, type Ruleset, type RuleKey } from '@job-digest/core';
import { saveRuleset } from '@/lib/actions';
import { PillGroup } from './PillGroup';
import styles from './RulesEditor.module.css';

const LEVELS: Level[] = ['A2', 'B1', 'B2', 'C1', 'C2'];
const HOME_DAYS = [0, 1, 2, 3, 4, 5];
const RULE_SUBTITLE: Record<string, string> = {
  Shift: 'working hours in the ad',
  German: 'level the ad demands',
  Onsite: 'home office in the ad',
  Pay: 'gross monthly figure in the ad',
  Contract: 'befristet or unbefristet',
};

/**
 * Rule editing (design §7.2, screen 3 — unbuilt in the prototype). Covers
 * condition + severity per rule; exceptions (§7.2's relax/waive clause) have
 * no design for authoring yet (design §13.4 flags this explicitly), so this
 * editor does not attempt one — a rule saved here simply has no exception,
 * which evaluate() already treats as the common case.
 */
export function RulesEditor({ initialRules, version }: { initialRules: Ruleset; version: number }) {
  const [draft, setDraft] = useState<Ruleset>(initialRules);
  const [pending, startTransition] = useTransition();
  const [savedAt, setSavedAt] = useState<number | null>(null);

  const dirty = JSON.stringify(draft) !== JSON.stringify(initialRules);

  function setSeverity(key: RuleKey, severity: 'hard' | 'preference') {
    setDraft((d) => ({ ...d, [key]: { ...d[key], severity } }));
    setSavedAt(null);
  }

  function setCondition<K extends RuleKey>(key: K, condition: ConditionByKey[K]) {
    setDraft((d) => ({ ...d, [key]: { ...d[key], key, condition } }));
    setSavedAt(null);
  }

  function save() {
    startTransition(async () => {
      await saveRuleset(draft);
      setSavedAt(Date.now());
    });
  }

  return (
    <div>
      {RULE_KEYS.map((key) => {
        const rule = draft[key];
        return (
          <div key={key} className={styles.rule}>
            <div className={styles.ruleHead}>
              <div>
                <div className={styles.ruleName}>{key}</div>
                <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>{RULE_SUBTITLE[key]}</div>
              </div>
              <PillGroup
                label=""
                options={[
                  { label: 'Hard', active: rule.severity === 'hard', onClick: () => setSeverity(key, 'hard') },
                  {
                    label: 'Preference',
                    active: rule.severity === 'preference',
                    onClick: () => setSeverity(key, 'preference'),
                  },
                ]}
              />
            </div>

            {key === 'Shift' && (
              <PillGroup
                label="What you will not take"
                options={[
                  {
                    label: 'No rotating shifts',
                    active: draft.Shift.condition.noRotating,
                    onClick: () =>
                      setCondition('Shift', { ...draft.Shift.condition, noRotating: !draft.Shift.condition.noRotating }),
                  },
                  {
                    label: 'No weekend work',
                    active: draft.Shift.condition.noWeekend,
                    onClick: () =>
                      setCondition('Shift', { ...draft.Shift.condition, noWeekend: !draft.Shift.condition.noWeekend }),
                  },
                ]}
              />
            )}

            {key === 'German' && (
              <PillGroup
                label="Highest level an ad may demand"
                options={LEVELS.map((l) => ({
                  label: l,
                  active: draft.German.condition.maxDemanded === l,
                  onClick: () => setCondition('German', { maxDemanded: l }),
                }))}
              />
            )}

            {key === 'Onsite' && (
              <PillGroup
                label="Home-office days per week, minimum"
                options={HOME_DAYS.map((n) => ({
                  label: String(n),
                  active: draft.Onsite.condition.minHomeDays === n,
                  onClick: () => setCondition('Onsite', { minHomeDays: n }),
                }))}
              />
            )}

            {key === 'Pay' && (
              <>
                <div className={styles.groupLabel} style={{ marginBottom: 6, fontSize: 12.5, color: 'var(--text-secondary)' }}>
                  Monthly gross floor
                </div>
                <input
                  type="number"
                  step={50}
                  value={draft.Pay.condition.minMonthly}
                  onChange={(e) =>
                    setCondition('Pay', {
                      ...draft.Pay.condition,
                      minMonthly: Number(e.target.value),
                    })
                  }
                  style={{
                    marginBottom: 14,
                    padding: '6px 10px',
                    borderRadius: 5,
                    border: '1px solid var(--border)',
                    fontSize: 13,
                    width: 120,
                    fontFamily: 'var(--font-sans)',
                  }}
                />
                <PillGroup
                  label="Compare part-time ads against"
                  options={[
                    {
                      label: 'Full-time equivalent',
                      active: draft.Pay.condition.basis === 'fte',
                      onClick: () => setCondition('Pay', { ...draft.Pay.condition, basis: 'fte' }),
                    },
                    {
                      label: 'Actual monthly',
                      active: draft.Pay.condition.basis === 'actual',
                      onClick: () => setCondition('Pay', { ...draft.Pay.condition, basis: 'actual' }),
                    },
                  ]}
                />
              </>
            )}

            {key === 'Contract' && (
              <PillGroup
                label="Contract type"
                options={[
                  {
                    label: 'Permanent only',
                    active: draft.Contract.condition.permanentOnly,
                    onClick: () => setCondition('Contract', { permanentOnly: true }),
                  },
                  {
                    label: 'Any contract',
                    active: !draft.Contract.condition.permanentOnly,
                    onClick: () => setCondition('Contract', { permanentOnly: false }),
                  },
                ]}
              />
            )}
          </div>
        );
      })}

      <div className={styles.saveRow}>
        <button type="button" className={styles.saveBtn} disabled={!dirty || pending} onClick={save}>
          Save changes
        </button>
        {dirty && !pending && <span className={styles.saveHint}>Unsaved changes</span>}
        {pending && <span className={styles.saveHint}>Saving…</span>}
        {!dirty && savedAt && (
          <span className={`${styles.saveHint} ${styles.saveHintOk}`}>
            Saved as version {version + 1} — takes effect on this week&apos;s digest immediately.
          </span>
        )}
      </div>
    </div>
  );
}
