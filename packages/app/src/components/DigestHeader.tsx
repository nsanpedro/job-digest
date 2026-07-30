import { RULE_KEYS, type Ruleset } from '@job-digest/core';
import type { Digest } from '@job-digest/db';
import { formatTimestamp, formatWindow } from '@/lib/format';
import { RefreshButton } from './RefreshButton';
import styles from './DigestHeader.module.css';

/** Mirrors the prototype's hardRulesNote — derived from the ruleset in force, not copied text. */
function hardRulesNote(rules: Ruleset): string {
  const hard = RULE_KEYS.filter((k) => rules[k].severity === 'hard');
  if (hard.length === 0) return 'No hard rules — nothing gets filtered out';
  if (hard.length === 1) return `${hard[0]} is the only hard rule`;
  return `${hard.join(' & ')} ${hard.length === 2 ? 'are hard rules' : 'are hard rules'}`;
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
          <h1 className={styles.h1}>{formatWindow(window)}</h1>
          <p className={styles.subtitle}>
            {parse.emailsRead} alert email{parse.emailsRead === 1 ? '' : 's'} read from{' '}
            {platformList(parse.platforms)} · {runNote}
          </p>
        </div>
        <div className={styles.right}>
          <RefreshButton />
        </div>
      </div>

      <div className={styles.metrics}>
        <div className={styles.cell}>
          <div className={styles.label}>Ads received</div>
          <div className={styles.value}>{metrics.adsReceived}</div>
          <p className={styles.context}>
            {metrics.offTarget !== null
              ? `${metrics.offTarget} off-target (wrong field or city), not listed`
              : `from ${parse.emailsRead} alert email${parse.emailsRead === 1 ? '' : 's'}`}
          </p>
        </div>
        <div className={styles.cell}>
          <div className={styles.label}>Pass your rules</div>
          <div className={styles.value}>{metrics.passing}</div>
          <p className={styles.context}>
            {metrics.filteredByRule} filtered out on a hard rule
          </p>
        </div>
        <div className={styles.cell}>
          <div className={styles.label}>Already seen</div>
          <div className={styles.value}>{metrics.alreadySeen}</div>
          <p className={styles.context}>Repeats from earlier weeks</p>
        </div>
      </div>

      <div className={styles.laneLegend}>
        <span className={styles.laneLegendText}>
          Rule lane, same order every row: Shift · German · Onsite · Pay · Contract
        </span>
        <span className={styles.laneLegendRule} />
        <span className={styles.laneLegendText}>{hardRulesNote(rules)}</span>
      </div>
    </>
  );
}
