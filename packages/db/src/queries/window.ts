/**
 * The digest window (design §13.2).
 *
 * Fixed Monday–Sunday rather than a rolling 7 days from the last run: the
 * user's habit is weekly, and a fixed window makes "already seen — repeats
 * from earlier weeks" mean the same thing on Monday and on Friday. A rolling
 * window would reclassify the same ad as new or repeated depending on when
 * the page was opened.
 */

export interface Window {
  start: Date;
  end: Date;
}

/** The Mon 00:00 → next Mon 00:00 window containing `now`, in UTC. */
export function weekWindow(now: Date): Window {
  const start = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 0, 0, 0, 0),
  );
  // getUTCDay: 0 = Sunday. Monday is the anchor, so Sunday walks back 6 days.
  const daysSinceMonday = (start.getUTCDay() + 6) % 7;
  start.setUTCDate(start.getUTCDate() - daysSinceMonday);
  const end = new Date(start);
  end.setUTCDate(end.getUTCDate() + 7);
  return { start, end };
}

/** The window `weeksAgo` weeks before the one containing `now`. */
export function previousWeekWindow(now: Date, weeksAgo = 1): Window {
  const { start } = weekWindow(now);
  const shifted = new Date(start);
  shifted.setUTCDate(shifted.getUTCDate() - 7 * weeksAgo);
  return weekWindow(shifted);
}
