'use client';

import { useEffect, useRef, useState, useTransition } from 'react';
import { getRunProgress, startRefresh } from '@/lib/actions';
import styles from './RefreshButton.module.css';

type RunState = 'idle' | 'running' | 'done' | 'error';

const VARIANTS: Record<RunState, { bg: string; fg: string; bd: string; dot: string }> = {
  idle: { bg: 'var(--ink)', fg: '#fff', bd: 'var(--ink)', dot: 'oklch(0.75 0.01 260)' },
  running: { bg: '#fff', fg: 'oklch(0.4 0.01 260)', bd: 'oklch(0.85 0.005 260)', dot: 'oklch(0.55 0.09 250)' },
  done: { bg: 'var(--pass-bg)', fg: 'var(--pass-fg)', bd: 'var(--pass-bd)', dot: 'oklch(0.55 0.1 152)' },
  error: { bg: '#fff', fg: 'oklch(0.44 0.11 25)', bd: 'oklch(0.83 0.06 25)', dot: 'oklch(0.55 0.15 25)' },
};

/** How often to poll runs while one is in flight — fast enough to feel live, not a query per frame. */
const POLL_MS = 1000;

/** How long the last narration stays visible after the run finishes — long enough
 *  for the user to read the counts, short enough not to loiter. */
const NARRATION_LINGER_MS = 8000;

/**
 * When to stop waiting on a run that never leaves 'running'. The work runs in
 * `after()`, which cannot outlive the route's `maxDuration` (60 s, see
 * digest/page.tsx): a run still open well past that was cut off by the
 * platform and will never be closed. 90 s leaves room for a slow last poll.
 */
const RUN_DEADLINE_MS = 90_000;

type RunSnapshot = Awaited<ReturnType<typeof getRunProgress>>;

/**
 * "Update now" — starts a run (returns almost immediately; the actual fetch
 * runs detached, see startRefresh) and polls its progress while it's in
 * flight. Design §10 specified this as SSE-or-poll against a run-status
 * endpoint; this is the poll half, over a Server Action rather than a REST
 * route, to match how the rest of the app is built.
 *
 * The narration under the button (feat/ingest-live-narration) is assembled
 * the same way ParseBanner is: from real counts on the run row, not authored
 * per-incident prose. A test PM autoconcluded "there won't be much this week"
 * from a mute finish; the narration replaces that silence with what actually
 * happened, so an empty result reads as "we looked and nothing cleared the
 * bar" rather than "the button glitched".
 */
export function RefreshButton() {
  const [state, setState] = useState<RunState>('idle');
  const [gmailProgress, setGmailProgress] = useState<RunSnapshot | null>(null);
  const [apiProgress, setApiProgress] = useState<RunSnapshot | null>(null);
  const [errorDetail, setErrorDetail] = useState<string | null>(null);
  const [narrationSticky, setNarrationSticky] = useState(false);
  const [, startTransition] = useTransition();
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const startedRef = useRef(0);
  const [timedOut, setTimedOut] = useState(false);
  const lingerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => {
    if (pollRef.current) clearInterval(pollRef.current);
    if (lingerRef.current) clearTimeout(lingerRef.current);
  }, []);

  function poll(runId: string, apiRunId: string | null) {
    pollRef.current = setInterval(() => {
      startTransition(async () => {
        const [g, a] = await Promise.all([
          getRunProgress(runId),
          apiRunId ? getRunProgress(apiRunId) : Promise.resolve(null),
        ]);
        if (g) setGmailProgress(g);
        if (a) setApiProgress(a);

        // Both runs must be terminal (or absent) before we stop polling —
        // or the deadline has passed, in which case a still-open run was cut
        // off by the platform and waiting longer would only hang the button.
        const gDone = !g || g.status !== 'running';
        const aDone = !apiRunId || !a || a.status !== 'running';
        const overdue = Date.now() - startedRef.current > RUN_DEADLINE_MS;
        if (!(gDone && aDone) && !overdue) return;
        if (!(gDone && aDone)) setTimedOut(true);

        if (pollRef.current) clearInterval(pollRef.current);

        const gErr = g && g.status === 'error';
        const aErr = a && a.status === 'error';
        if (gErr || aErr) {
          setState('error');
          const source = gErr ? g : a;
          setErrorDetail(errorCopy(source));
        } else {
          setState('done');
        }
        // Keep the narration on-screen for a beat after the run ends — that
        // beat is the whole point (the PM's autoconclusion came from a
        // narration that vanished at the same instant it might have said
        // "we looked and found nothing").
        setNarrationSticky(true);
        if (lingerRef.current) clearTimeout(lingerRef.current);
        lingerRef.current = setTimeout(() => setNarrationSticky(false), NARRATION_LINGER_MS);
      });
    }, POLL_MS);
  }

  function run() {
    startedRef.current = Date.now();
    setTimedOut(false);
    setState('running');
    setGmailProgress(null);
    setApiProgress(null);
    setErrorDetail(null);
    setNarrationSticky(false);
    if (lingerRef.current) clearTimeout(lingerRef.current);
    startTransition(async () => {
      try {
        const { runId, apiRunId } = await startRefresh();
        poll(runId, apiRunId);
      } catch (err) {
        setState('error');
        setErrorDetail(err instanceof Error ? err.message : 'Something went wrong reading the inbox.');
      }
    });
  }

  // Once Gmail has settled, what is still running is the public-sources
  // stage — saying "Reading the inbox…" through it read as a hung inbox.
  const gmailSettled = gmailProgress !== null && gmailProgress.status !== 'running';
  const label =
    state === 'idle' ? 'Update now'
    : state === 'running' ?
      gmailSettled ? 'Checking public sources…'
      : gmailProgress?.emailsTotal
        ? `Reading the inbox… ${gmailProgress.emailsProcessed} of ${gmailProgress.emailsTotal}`
        : 'Reading the inbox…'
    : state === 'done' ? 'Up to date — just now'
    : 'Retry';

  const v = VARIANTS[state];
  const narrationLines = buildNarration(gmailProgress, apiProgress, state, timedOut);
  const showNarration = (state === 'running' || (state === 'done' && narrationSticky)) && narrationLines.length > 0;

  return (
    <div className={styles.col}>
      <button
        type="button"
        className={styles.btn}
        style={{ background: v.bg, color: v.fg, borderColor: v.bd }}
        disabled={state === 'running'}
        onClick={run}
      >
        {state === 'running'
          ? <span className={styles.spinner} aria-hidden="true" />
          : <span className={styles.dot} style={{ background: v.dot }} />
        }
        {label}
      </button>
      {showNarration && (
        <ul className={styles.narration} aria-live="polite" aria-atomic="false">
          {narrationLines.map((line) => (
            <li key={line.key}>{line.text}</li>
          ))}
        </ul>
      )}
      {state === 'error' && errorDetail && <p className={styles.error}>{errorDetail}</p>}
    </div>
  );
}

/**
 * Turns raw run counters into short, factual sentences — one per stage that
 * has anything worth saying. The tone mirrors ParseBanner: names the
 * mechanism, no cheerleading, no exclamation marks. Every number here traces
 * to a `runs` column the pipeline wrote; nothing is invented.
 *
 * Silence-avoidance is the whole point: even if a stage finishes with
 * "nothing new", the copy says so plainly rather than disappearing.
 */
function buildNarration(
  gmail: RunSnapshot | null,
  api: RunSnapshot | null,
  overall: RunState,
  timedOut = false,
): Array<{ key: string; text: string }> {
  const lines: Array<{ key: string; text: string }> = [];

  // Gmail line: shown as soon as the first counter comes back, updated as
  // more messages land. The `emailsTotal !== null` gate avoids a flash of
  // "0 of null emails" between run start and the first list_messages call.
  if (gmail) {
    if (gmail.status === 'error') {
      lines.push({ key: 'gmail-err', text: errorCopy(gmail) });
    } else if (gmail.emailsTotal === null && gmail.status === 'running') {
      lines.push({ key: 'gmail-init', text: 'Reading Gmail — looking for new alerts…' });
    } else if (gmail.emailsTotal !== null) {
      const total = gmail.emailsTotal;
      const scanned = gmail.emailsProcessed;
      const alerts = gmail.adsCreated;
      if (total === 0) {
        lines.push({ key: 'gmail-empty', text: 'Read Gmail — no new alert emails since your last update.' });
      } else if (gmail.status === 'running') {
        lines.push({
          key: 'gmail-live',
          text: `Reading Gmail — ${scanned} of ${total} emails scanned, ${alerts} new ${alerts === 1 ? 'alert' : 'alerts'} so far.`,
        });
      } else {
        // status === 'ok' (or error handled above)
        lines.push({
          key: 'gmail-done',
          text: alerts === 0
            ? `Read Gmail — ${total} ${total === 1 ? 'email' : 'emails'}, none carried a new alert.`
            : `Read Gmail — ${total} ${total === 1 ? 'email' : 'emails'}, ${alerts} new ${alerts === 1 ? 'alert' : 'alerts'}.`,
        });
      }
    }
  }

  // API sources line: `emailsTotal` on the API run is the number of active
  // sources (see fetch-apis.ts). Zero-source users get no line at all — an
  // empty API stage is not news to someone who has never added a source.
  if (api) {
    if (api.status === 'error') {
      lines.push({ key: 'api-err', text: errorCopy(api) });
    } else if (api.emailsTotal !== null && api.emailsTotal > 0) {
      const sources = api.emailsTotal;
      const scanned = api.emailsProcessed;
      const reviewed = api.itemsReviewed;
      const created = api.adsCreated;
      if (api.status === 'running') {
        lines.push({
          key: 'api-live',
          text: reviewed > 0
            ? `Checking ${sources} public ${sources === 1 ? 'source' : 'sources'} — ${scanned} of ${sources} done, ${reviewed} postings reviewed.`
            : `Checking ${sources} public ${sources === 1 ? 'source' : 'sources'} — ${scanned} of ${sources} done.`,
        });
      } else if (reviewed === 0) {
        lines.push({
          key: 'api-done-empty',
          text: `Checked ${sources} public ${sources === 1 ? 'source' : 'sources'} — no new postings this run.`,
        });
      } else {
        lines.push({
          key: 'api-done',
          text: created === 0
            ? `Checked ${sources} public ${sources === 1 ? 'source' : 'sources'} — ${reviewed} postings reviewed, none new for you.`
            : `Checked ${sources} public ${sources === 1 ? 'source' : 'sources'} — ${reviewed} postings reviewed, ${created} new ${created === 1 ? 'match' : 'matches'}.`,
        });
      }
    } else if (api.status === 'running' && api.emailsTotal === null) {
      lines.push({ key: 'api-init', text: 'Checking public sources…' });
    }
  }

  if (timedOut) {
    lines.push({
      key: 'timed-out',
      text: 'This update ran out of time before every stage finished — what was read is kept, the rest is picked up next time.',
    });
  }

  // Final summary line, only after both stages have settled. Sums are trivial
  // (both counters are on `runs` already) and land the honest headline: the
  // one that keeps a quiet finish from reading as "nothing happened here".
  if (overall === 'done' && !timedOut) {
    const totalNew = (gmail?.adsCreated ?? 0) + (api?.adsCreated ?? 0);
    if (totalNew === 0) {
      lines.push({
        key: 'summary',
        text: 'Nothing new cleared your filters this run — the number above is the honest count, not a bug.',
      });
    }
  }

  return lines;
}

/**
 * Error copy without leaking internals — the same three-way split
 * `runs.error_kind` already uses (auth / network / internal). The stored
 * `message` is not surfaced to the user: it can contain provider IDs, URLs
 * or stack context we don't want on the button.
 */
function errorCopy(run: RunSnapshot | null): string {
  if (!run || run.status !== 'error') return 'Something went wrong reading the inbox.';
  switch (run.errorKind) {
    case 'auth':
      return 'Gmail asked us to reconnect — the stored credential is no longer accepted.';
    case 'network':
      return 'The upstream service did not answer in time.';
    case 'internal':
    default:
      return 'Something went wrong on our side while reading the inbox.';
  }
}
