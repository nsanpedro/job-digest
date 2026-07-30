/**
 * Saved and Dismissed as standing views, not window-scoped (unlike
 * getDigest — design §13.2's fixed Mon–Sun window is specifically about
 * "already seen" meaning the same thing all week). Saving an ad is done
 * precisely so it survives past the week it arrived in; dismissing it
 * yourself is a decision worth being able to audit and undo regardless of
 * when it happened.
 *
 * Both reuse evaluate() over the active ruleset at read time (I6) — the same
 * rule as getDigest, so a rule change re-colors these lists too, not just
 * this week's.
 *
 * Neither includes rule-blocked-but-never-reviewed ads: those live only in
 * the weekly digest's "Filtered out" section, whose purpose is "shown so you
 * can check the filter, not to re-read them" for *this* week (design,
 * screen 1). Dismissed here means the user acted (I10) — a decision, not a
 * rule outcome.
 */
import { evaluate, type Ruleset } from '@job-digest/core';
import { and, count, desc, eq, isNotNull } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { adSightings, ads, adUserState } from '../schema';
import { getActiveRuleset } from './digest';
import type { DigestAd, DismissedAd, Platform } from './types';

type Db = PostgresJsDatabase<Record<string, unknown>>;

async function latestSighting(db: Db, userId: string, adId: string) {
  const rows = await db
    .select({ alertName: adSightings.alertName, receivedAt: adSightings.receivedAt })
    .from(adSightings)
    .where(eq(adSightings.adId, adId))
    .orderBy(desc(adSightings.receivedAt))
    .limit(1);
  return rows[0] ?? { alertName: null, receivedAt: null };
}

function toDigestAd(row: {
  ad: typeof ads.$inferSelect;
  state: typeof adUserState.$inferSelect | null;
  sighting: { alertName: string | null; receivedAt: Date | null };
  rules: Ruleset;
}): DigestAd {
  const { ad, state, sighting, rules } = row;
  return {
    id: ad.id,
    title: ad.title,
    company: ad.company,
    location: ad.locationRaw,
    source: ad.source as Platform,
    externalUrl: ad.externalUrl,
    score: ad.score,
    seen: state?.seen ?? false,
    saved: state?.saved ?? false,
    incomplete: ad.incomplete,
    incompleteNote: ad.incompleteNote,
    alert: sighting.alertName,
    receivedAt: sighting.receivedAt ?? ad.lastSeenAt,
    firstSeenAt: ad.firstSeenAt,
    repeat: false,
    verdicts: evaluate(ad.facts, rules),
    wording: ad.wording,
    fit: null,
    gap: null,
  };
}

/** For the TopBar badge — avoids building the full evaluated list just to count it. */
export async function getSavedCount(db: Db, userId: string): Promise<number> {
  const rows = await db
    .select({ n: count() })
    .from(adUserState)
    .where(and(eq(adUserState.userId, userId), eq(adUserState.saved, true)));
  return rows[0]?.n ?? 0;
}

export async function getSavedAds(db: Db, userId: string): Promise<DigestAd[]> {
  const { rules } = await getActiveRuleset(db, userId);
  const rows = await db
    .select({ ad: ads, state: adUserState })
    .from(adUserState)
    .innerJoin(ads, eq(ads.id, adUserState.adId))
    .where(and(eq(adUserState.userId, userId), eq(adUserState.saved, true)))
    .orderBy(desc(adUserState.updatedAt));

  const out: DigestAd[] = [];
  for (const row of rows) {
    const sighting = await latestSighting(db, userId, row.ad.id);
    out.push(toDigestAd({ ...row, sighting, rules }));
  }
  return out;
}

export async function getDismissedAds(db: Db, userId: string): Promise<DismissedAd[]> {
  const { rules } = await getActiveRuleset(db, userId);
  const rows = await db
    .select({ ad: ads, state: adUserState })
    .from(adUserState)
    .innerJoin(ads, eq(ads.id, adUserState.adId))
    .where(and(eq(adUserState.userId, userId), isNotNull(adUserState.dismissedAt)))
    .orderBy(desc(adUserState.dismissedAt));

  const out: DismissedAd[] = [];
  for (const row of rows) {
    const sighting = await latestSighting(db, userId, row.ad.id);
    out.push({ ...toDigestAd({ ...row, sighting, rules }), reason: { kind: 'user' } });
  }
  return out;
}
