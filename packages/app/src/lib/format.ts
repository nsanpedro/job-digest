import type { Window } from '@job-digest/db';

const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

/** "21 – 28 July 2026" — the window's Sunday, not its exclusive end. */
export function formatWindow(window: Window): string {
  const lastDay = new Date(window.end);
  lastDay.setUTCDate(lastDay.getUTCDate() - 1);
  const start = window.start;
  const sameMonth = start.getUTCMonth() === lastDay.getUTCMonth();
  const month = MONTHS[lastDay.getUTCMonth()];
  if (sameMonth) {
    return `${start.getUTCDate()} – ${lastDay.getUTCDate()} ${month} ${lastDay.getUTCFullYear()}`;
  }
  const startMonth = MONTHS[start.getUTCMonth()];
  return `${start.getUTCDate()} ${startMonth} – ${lastDay.getUTCDate()} ${month} ${lastDay.getUTCFullYear()}`;
}

export function formatTimestamp(d: Date): string {
  const day = d.getUTCDate();
  const month = MONTHS[d.getUTCMonth()]?.slice(0, 3);
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const mm = String(d.getUTCMinutes()).padStart(2, '0');
  return `${day} ${month}, ${hh}:${mm}`;
}

export function formatShortDate(d: Date): string {
  const day = d.getUTCDate();
  const month = MONTHS[d.getUTCMonth()]?.slice(0, 3);
  return `${day} ${month}`;
}

/** ISO-8601 week number. Thursday-anchored: whichever week contains
 *  the window's last full day gets the number the digest is labeled by. */
function isoWeek(d: Date): number {
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const dow = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - dow);
  const yearStart = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  return Math.ceil(((t.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
}

/** "Week 31 · 21 – 28 July 2026" — the kicker line above the digest H1. */
export function formatWeekKicker(window: Window): string {
  const lastDay = new Date(window.end);
  lastDay.setUTCDate(lastDay.getUTCDate() - 1);
  return `Week ${isoWeek(lastDay)} · ${formatWindow(window)}`;
}
