import { RULE_KEYS, type Ruleset } from '@job-digest/core';
import type { Digest } from '@job-digest/db';
import { formatTimestamp, formatWeekKicker } from '@/lib/format';
import { RefreshButton } from './RefreshButton';
import styles from './DigestHeader.module.css';

/** Mirrors the prototype's hardRulesNote — derived from the ruleset in force, not copied text. */
function hardRulesNote(rules: Ruleset): string {
  const hard = RULE_KEYS.filter((k) => rules[k].severity === 'hard');
  if (hard.length === 0) return 'No hard rules — nothing gets filtered out';
  if (hard.length === 1) return `${hard[0]} is the only hard rule`;
  return `${hard.join(' & ')} are hard rules`;
}

function platformList(platforms: readonly string[]): string {
  if (platforms.length === 0) return 'no platforms';
  if (platforms.length === 1) return platforms[0]!;
  return `${platforms.slice(0, -1).join(', ')} and ${platforms.at(-1)}`;
}

export function DigestHeader({ digest, rules }: { digest: Digest; rules: Ruleset }) {
  const { metrics, parse, window } = digest;
  const runNote = parse.lastRunAt ? `last run ${formatTimestamp(parse.lastRunAt)}` : 'no run yet';

  return (
    <>
      <div className={styles.header}>
        <div className={styles.left}>
          <div className={styles.kicker}>{formatWeekKicker(window)}</div>
          <h1 className={styles.h1}>
            <span className={styles.h1Count}>{metrics.inDigest}</span> passed the sift
          </h1>
          <p className={styles.subtitle}>
            {parse.emailsRead} alert email{parse.emailsRead === 1 ? '' : 's'} read from{' '}
            {platformList(parse.platforms)} · {runNote}
          </p>
        </div>
        <div className={styles.right}>
          <RefreshButton />
        </div>
      </div>

      <div className={`mesh-rule ${styles.headerRule}`} />

      <div className={styles.metrics}>
        <div className={styles.cell}>
          <div className={styles.label}>Received</div>
          <div className={styles.value}>{metrics.adsReceived}</div>
          <p className={styles.context}>
            {metrics.explore !== null
              ? `${metrics.explore.total} in the explore bucket`
              : `from ${parse.emailsRead} alert email${parse.emailsRead === 1 ? '' : 's'}`}
          </p>
        </div>
        <div className={`${styles.cell} ${styles.cellFeature}`}>
          <span className={styles.cellFeatureBar} />
          <div className={`${styles.label} ${styles.labelAccent}`}>Through the sift</div>
          <div className={`${styles.value} ${styles.valueFeature}`}>{metrics.inDigest}</div>
          <p className={styles.context}>{metrics.filteredByRule} held by the sift</p>
        </div>
        <div className={styles.cell}>
          <div className={styles.label}>Seen before</div>
          <div className={styles.value}>{metrics.alreadySeen}</div>
          <p className={styles.context}>Repeats from earlier weeks</p>
        </div>
      </div>

      {/*
        Rule-lane strip: names the five rules the sift is built on and, on the
        right, notes which of them are hard right now. Purely presentational —
        the per-ad chips read `rules` themselves.
      */}
      <div className={styles.laneLegend}>
        <span className={styles.laneLegendText}>Rule lane</span>
        <span className={styles.laneRules}>
          {RULE_KEYS.map((k, i) => (
            <span key={k}>
              {i > 0 && <span className={styles.laneSep}>·</span>}
              <span
                className={rules[k].severity === 'hard' ? styles.laneRuleHard : styles.laneRule}
              >
                {k}
              </span>
            </span>
          ))}
        </span>
        <span className={`mesh-rule ${styles.laneLegendRule}`} />
        <span className={styles.laneLegendText}>{hardRulesNote(rules)}</span>
      </div>
    </>
  );
}
