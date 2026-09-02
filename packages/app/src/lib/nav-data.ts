/**
 * Nav-badge data (design: perf pass, Aug 2026), wrapped in React's cache()
 * so the shared layout and any page that also needs the same data (today,
 * only /unread — its content *is* the list these counts are drawn from)
 * pay for one query per request, not one per caller. cache() dedupes by the
 * wrapped function's own arguments; the window computed inside always
 * matches within one request regardless of how many callers ask.
 *
 * Before this, every one of the six authenticated pages fetched all three
 * independently — 18 queries a navigation for data that never varies by
 * page, only by user and moment.
 */
import { cache } from 'react';
import { accounts, getApplicationCounts, getSavedCount, getUnreadEmails, weekWindow } from '@job-digest/db';
import { eq } from 'drizzle-orm';
import { withTenant } from './session';

export const getUnreadEmailsCached = cache((userId: string) =>
  withTenant(userId, (tx) => getUnreadEmails(tx, userId, weekWindow(new Date()))),
);

export const getSavedCountCached = cache((userId: string) => withTenant(userId, (tx) => getSavedCount(tx, userId)));

export const getApplicationCountsCached = cache((userId: string) =>
  withTenant(userId, (tx) => getApplicationCounts(tx, userId)),
);

export const getUserCityCached = cache((userId: string) =>
  withTenant(userId, async (tx) => {
    const rows = await tx.select({ city: accounts.city }).from(accounts).where(eq(accounts.id, userId)).limit(1);
    return rows[0]?.city ?? null;
  }),
);
