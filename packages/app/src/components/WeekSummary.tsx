import type { WeekSummary as Summary } from '@job-digest/db';
import styles from './WeekSummary.module.css';

/**
 * What the week looks like across ads rather than one ad at a time.
 *
 * The card can only say what the email carried, and the email carries very
 * little — measured 3 Aug 2026, three of the five rule facts are null on every
 * ad in the database. The set, however, is informative: one recruiter sending
 * the same role six times, how much of the week states pay at all, which alert
 * is actually producing. None of that is visible while reading the emails one
 * by one, which is exactly the reading this product exists to replace.
 *
 * Every line is a count over stored rows, and a line with nothing to count is
 * not rendered rather than shown as a zero — a zero here would be a sentence
 * about nothing.
 */
export function WeekSummary({ summary, payFloor }: { summary: Summary; payFloor: string | null }) {
  const { senders, alerts, pay, repostedAcrossCities, total } = summary;
  if (total === 0) return null;

  const lines: Array<{ key: string; body: React.ReactNode }> = [];

  if (senders.length > 0) {
    const shown = senders.slice(0, 4);
    const rest = senders.length - shown.length;
    lines.push({
      key: 'senders',
      body: (
        <>
          <strong>{shown[0]!.company}</strong> sent {shown[0]!.count}
          {shown.length > 1 && (
            <>
              {' '}
              · {shown.slice(1).map((s) => `${s.company} ${s.count}`).join(' · ')}
            </>
          )}
          {rest > 0 && <> · and {rest} more company{rest === 1 ? '' : 'ies'} with repeats</>}
        </>
      ),
    });
  }

  /*
   * The per-alert breakdown is computed but deliberately not rendered yet.
   * Run live against the real corpus on 3 Aug 2026, `ad_sightings.alert_name`
   * turned out to hold the *email subject*, not the alert's name — 123 ads
   * spread across 20 "alerts" like "SOMI Group, Seaside Collection … und
   * andere spannende Firmen suchen nach Kandidaten wie Dir!". That is a
   * genuinely useful line once the upstream field carries an alert name, and
   * pure noise until then, so it stays in `WeekSummary` and off the screen.
   */
  void alerts;

  lines.push({
    key: 'pay',
    body:
      pay.stated === 0 ? (
        <>
          <strong>None</strong> of the {total} ads stated pay — no platform sent a number this week
        </>
      ) : (
        <>
          <strong>
            {pay.stated} of {total}
          </strong>{' '}
          stated pay
          {payFloor ? (
            <>
              , {pay.clears} clear your {payFloor} floor
            </>
          ) : null}
        </>
      ),
  });

  if (repostedAcrossCities.length > 0) {
    const first = repostedAcrossCities[0]!;
    const rest = repostedAcrossCities.length - 1;
    lines.push({
      key: 'reposted',
      body: (
        <>
          {first.company ?? 'One company'} posted <strong>{first.title}</strong> for {first.cities.length}{' '}
          cities ({first.cities.join(', ')})
          {rest > 0 && <> · and {rest} more role{rest === 1 ? '' : 's'} like it</>} — reading one tells you most
          of the rest
        </>
      ),
    });
  }

  return (
    <section className={styles.summary}>
      <p className={styles.label}>Across the week</p>
      <ul className={styles.list}>
        {lines.map((l) => (
          <li key={l.key} className={styles.line}>
            {l.body}
          </li>
        ))}
      </ul>
    </section>
  );
}
