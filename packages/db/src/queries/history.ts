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
import { and, count, desc, eq, inArray, isNotNull } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { adSightings, ads, adUserState } from '../schema';
import { getLatestApplicationStatuses } from './applications';
import { getPlatformCapabilities } from './capabilities';
import { getActiveRuleset } from './ruleset';
import type { ApplicationStatus, DigestAd, DismissedAd, Platform } from './types';

type Db = PostgresJsDatabase<Record<string, unknown>>;

type Sighting = { alertName: string | null; receivedAt: Date | null };
const NO_SIGHTING: Sighting = { alertName: null, receivedAt: null };

/**
 * The most recent sighting per ad, in one query rather than one per ad.
 * `selectDistinctOn` ordered by recency gives the latest row per `ad_id`
 * directly — the same pattern getDigest uses for the same reason.
 */
async function latestSightingsByAd(db: Db, adIds: string[]): Promise<Map<string, Sighting>> {
  if (adIds.length === 0) return new Map();
  const rows = await db
    .selectDistinctOn([adSightings.adId], {
      adId: adSightings.adId,
      alertName: adSightings.alertName,
      receivedAt: adSightings.receivedAt,
    })
    .from(adSightings)
    .where(inArray(adSightings.adId, adIds))
    .orderBy(adSightings.adId, desc(adSightings.receivedAt));
  return new Map(rows.map((r) => [r.adId, { alertName: r.alertName, receivedAt: r.receivedAt }]));
}

function toDigestAd(row: {
  ad: typeof ads.$inferSelect;
  state: typeof adUserState.$inferSelect | null;
  sighting: { alertName: string | null; receivedAt: Date | null };
  rules: Ruleset;
  applicationStatus: ApplicationStatus | null;
  platformFields: Record<string, boolean>;
}): DigestAd {
  const { ad, state, sighting, rules, applicationStatus, platformFields } = row;
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
    titleFacts: ad.titleFacts,
    fit: null,
    gap: null,
    applicationStatus,
    platformFields,
    fieldProvenance: ad.fieldProvenance ?? null,
    scoreBreakdown: null,
    matchedDirectionLabels: [],
    matchExplanations: [],
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

  const [applied, sightings, capabilities] = await Promise.all([
    getLatestApplicationStatuses(db, userId),
    latestSightingsByAd(db, rows.map((r) => r.ad.id)),
    getPlatformCapabilities(db),
  ]);
  return rows.map((row) =>
    toDigestAd({
      ...row,
      sighting: sightings.get(row.ad.id) ?? NO_SIGHTING,
      rules,
      applicationStatus: applied.get(row.ad.id) ?? null,
      platformFields: capabilities[row.ad.source as Platform] ?? {},
    }),
  );
}

export async function getDismissedAds(db: Db, userId: string): Promise<DismissedAd[]> {
  const { rules } = await getActiveRuleset(db, userId);
  const rows = await db
    .select({ ad: ads, state: adUserState })
    .from(adUserState)
    .innerJoin(ads, eq(ads.id, adUserState.adId))
    .where(and(eq(adUserState.userId, userId), isNotNull(adUserState.dismissedAt)))
    .orderBy(desc(adUserState.dismissedAt));

  const [applied, sightings, capabilities] = await Promise.all([
    getLatestApplicationStatuses(db, userId),
    latestSightingsByAd(db, rows.map((r) => r.ad.id)),
    getPlatformCapabilities(db),
  ]);
  return rows.map((row) => ({
    ...toDigestAd({
      ...row,
      sighting: sightings.get(row.ad.id) ?? NO_SIGHTING,
      rules,
      applicationStatus: applied.get(row.ad.id) ?? null,
      platformFields: capabilities[row.ad.source as Platform] ?? {},
    }),
    reason: { kind: 'user' as const },
  }));
}
