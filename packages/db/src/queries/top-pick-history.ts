/**
 * Top-pick history reads and writes (ADR-003 §2.9, I25).
 *
 * `getTopPickHistory` returns the set of ad ids that appeared in Top pick last
 * week — the set `selectTiers` uses to block re-promotion. The caller passes
 * `now` so replays of past digests under an older calibration see the same
 * history as the original run did.
 *
 * `recordTopPicks` writes one row per promoted ad. Called by `getDigest` after
 * tiering, only when the week is fresh (the digest was not already recorded for
 * this week). Idempotent via the unique index: re-running for the same week
 * silently ignores duplicate inserts.
 */
import { and, eq, gte, lt } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { adsTopPickHistory } from '../schema';
import type { TopPickHistory } from '@job-digest/core';
import { previousWeekWindow, weekWindow } from './window';

type Db = PostgresJsDatabase<Record<string, unknown>>;

/** ISO date string "YYYY-MM-DD" for a window's Monday. */
function toIsoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * Returns the set of ad ids that were in Top pick during the week immediately
 * before the window containing `now`. Empty set when no history exists yet —
 * a new user's first week has no constraint.
 */
export async function getTopPickHistory(
  db: Db,
  userId: string,
  now: Date,
): Promise<TopPickHistory> {
  const prev = previousWeekWindow(now);
  const start = toIsoDate(prev.start);
  const end = toIsoDate(prev.end);

  const rows = await db
    .select({ adId: adsTopPickHistory.adId })
    .from(adsTopPickHistory)
    .where(
      and(
        eq(adsTopPickHistory.userId, userId),
        gte(adsTopPickHistory.weekStart, start),
        lt(adsTopPickHistory.weekStart, end),
      ),
    );

  return new Set(rows.map((r) => r.adId));
}

/**
 * Writes one row per promoted ad for the current week. Safe to call more than
 * once — the unique index on (user_id, ad_id, week_start) absorbs duplicates
 * via ON CONFLICT DO NOTHING.
 *
 * `adIds` is the list of ad ids that `selectTiers` placed in `topPicks` this
 * week. Pass an empty array when the top tier is empty (no rows written).
 */
export async function recordTopPicks(
  db: Db,
  userId: string,
  adIds: readonly string[],
  now: Date,
): Promise<void> {
  if (adIds.length === 0) return;
  const weekStart = toIsoDate(weekWindow(now).start);
  await db
    .insert(adsTopPickHistory)
    .values(adIds.map((adId) => ({ userId, adId, weekStart })))
    .onConflictDoNothing();
}

/**
 * Prunes history rows older than 4 weeks. Called by the worker on a weekly
 * schedule, not by the read path. Returns the count of deleted rows.
 *
 * The 4-week window is generous: I25 only needs the previous week, but a small
 * audit trail is useful for debugging ("did this ad already appear?") without
 * unbounded growth.
 */
export async function pruneTopPickHistory(
  db: Db,
  userId: string,
  now: Date,
): Promise<number> {
  const cutoff = new Date(now);
  cutoff.setUTCDate(cutoff.getUTCDate() - 28);
  const cutoffStr = toIsoDate(cutoff);

  const deleted = await db
    .delete(adsTopPickHistory)
    .where(
      and(
        eq(adsTopPickHistory.userId, userId),
        lt(adsTopPickHistory.weekStart, cutoffStr),
      ),
    )
    .returning({ id: adsTopPickHistory.id });

  return deleted.length;
}
