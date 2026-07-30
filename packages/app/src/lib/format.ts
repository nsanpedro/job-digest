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
