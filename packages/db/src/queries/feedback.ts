/**
 * Dismiss reasons and their saved effects (ADR-003 §8.11 "Dismiss reasons as
 * explicit feedback"). The decisions — what a reason does, which word to
 * propose, whether a company is muted — are pure functions in
 * `@job-digest/core` (feedback.ts); this file only reads and writes the
 * rows those decisions produce.
 *
 * Two stores:
 *   - `ad_user_state.dismiss_reason` — the label, one per dismissed ad;
 *   - `feedback_effects` — one row per effect (a muted company, an exclude
 *     term the user confirmed), timestamped and deletable. For an exclude
 *     the term itself goes into `directions.exclude_terms`, where the
 *     matcher already reads it; the row is its provenance.
 */
import type { DismissReason, FeedbackEffect, FeedbackEffectKind } from '@job-digest/core';
import { and, eq, inArray, ne } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { ads, adUserState, directions, dismissReasonEnum, feedbackEffects } from '../schema';

type Db = PostgresJsDatabase<Record<string, unknown>>;

// The core type and the Postgres enum must list the same values.
const _reasonsMatch: readonly DismissReason[] = dismissReasonEnum.enumValues;
void _reasonsMatch;

export interface FeedbackEffectRow extends FeedbackEffect {
  id: string;
  adId: string | null;
  /** Label of the direction an exclude belongs to; null for a mute. */
  directionLabel: string | null;
}

/** Every saved effect for this user, oldest first. */
export async function listFeedbackEffects(db: Db, userId: string): Promise<FeedbackEffectRow[]> {
  const rows = await db
    .select({ effect: feedbackEffects, directionLabel: directions.label })
    .from(feedbackEffects)
    .leftJoin(directions, eq(directions.id, feedbackEffects.directionId))
    .where(eq(feedbackEffects.userId, userId))
    .orderBy(feedbackEffects.createdAt);
  return rows.map(({ effect, directionLabel }) => ({
    id: effect.id,
    kind: effect.kind,
    adId: effect.adId,
    directionId: effect.directionId,
    directionLabel: directionLabel ?? null,
    value: effect.value,
    valueKey: effect.valueKey,
    createdAt: effect.createdAt,
  }));
}

/** What the reason's effect is computed from. */
export interface DismissedAdFacts {
  title: string;
  company: string | null;
  location: string | null;
}

/**
 * Records the reason. The reason only ever accompanies a dismissal, so an
 * ad that is not dismissed yet is dismissed now; one that is keeps its
 * original `dismissed_at` (the eval's clock). Null when the ad does not
 * exist for this user.
 */
export async function recordDismissReason(
  db: Db,
  userId: string,
  adId: string,
  reason: DismissReason | null,
): Promise<DismissedAdFacts | null> {
  const ad = await db
    .select({ title: ads.title, company: ads.company, location: ads.locationRaw })
    .from(ads)
    .where(and(eq(ads.userId, userId), eq(ads.id, adId)))
    .limit(1);
  if (!ad[0]) return null;

  const existing = await db
    .select({ dismissedAt: adUserState.dismissedAt })
    .from(adUserState)
    .where(eq(adUserState.adId, adId))
    .limit(1);
  const now = new Date();
  if (existing[0]) {
    await db
      .update(adUserState)
      .set({ dismissReason: reason, dismissedAt: existing[0].dismissedAt ?? now, updatedAt: now })
      .where(eq(adUserState.adId, adId));
  } else {
    await db.insert(adUserState).values({ adId, userId, dismissedAt: now, dismissReason: reason });
  }
  return ad[0];
}

/** Mute a company. A company already muted (from any ad) stays muted under its first row. */
export async function muteCompany(
  db: Db,
  userId: string,
  input: { adId: string | null; company: string; companyKey: string },
): Promise<void> {
  await db
    .insert(feedbackEffects)
    .values({
      userId,
      kind: 'mute_company',
      adId: input.adId,
      value: input.company,
      valueKey: input.companyKey,
    })
    .onConflictDoNothing();
}

export async function unmuteCompany(db: Db, userId: string, companyKey: string): Promise<void> {
  await db
    .delete(feedbackEffects)
    .where(
      and(
        eq(feedbackEffects.userId, userId),
        eq(feedbackEffects.kind, 'mute_company'),
        eq(feedbackEffects.valueKey, companyKey),
      ),
    );
}

/**
 * Adds a confirmed exclude term to each direction and records where it came
 * from. A term the direction already has (any case) is not added twice.
 */
export async function addExcludeFromDismissal(
  db: Db,
  userId: string,
  input: { adId: string; directionIds: readonly string[]; term: string },
): Promise<void> {
  const term = input.term.trim();
  const key = term.toLowerCase();
  if (!key || input.directionIds.length === 0) return;
  const rows = await db
    .select({ id: directions.id, excludeTerms: directions.excludeTerms })
    .from(directions)
    .where(and(eq(directions.userId, userId), inArray(directions.id, [...input.directionIds])));
  for (const d of rows) {
    if (!d.excludeTerms.some((t) => t.trim().toLowerCase() === key)) {
      await db
        .update(directions)
        .set({ excludeTerms: [...d.excludeTerms, term], updatedAt: new Date() })
        .where(eq(directions.id, d.id));
    }
    await db
      .insert(feedbackEffects)
      .values({ userId, kind: 'exclude_term', adId: input.adId, directionId: d.id, value: term, valueKey: key })
      .onConflictDoNothing();
  }
}

/**
 * Undo one effect. An exclude also leaves its direction's `exclude_terms`
 * — the row is only provenance, the term there is what the matcher reads.
 */
export async function removeFeedbackEffect(db: Db, userId: string, effectId: string): Promise<void> {
  const rows = await db
    .select()
    .from(feedbackEffects)
    .where(and(eq(feedbackEffects.userId, userId), eq(feedbackEffects.id, effectId)))
    .limit(1);
  const effect = rows[0];
  if (!effect) return;
  if (effect.kind === 'exclude_term' && effect.directionId) {
    const dir = await db
      .select({ excludeTerms: directions.excludeTerms })
      .from(directions)
      .where(eq(directions.id, effect.directionId))
      .limit(1);
    if (dir[0]) {
      await db
        .update(directions)
        .set({
          excludeTerms: dir[0].excludeTerms.filter((t) => t.trim().toLowerCase() !== effect.valueKey),
          updatedAt: new Date(),
        })
        .where(eq(directions.id, effect.directionId));
    }
  }
  await db.delete(feedbackEffects).where(eq(feedbackEffects.id, effect.id));
}

/**
 * Undo the effects one dismissal produced — on Undo, and when the reason
 * changes (`keep` is the kind the new reason owns, if any).
 */
export async function removeEffectsFromAd(
  db: Db,
  userId: string,
  adId: string,
  keep: FeedbackEffectKind | null = null,
): Promise<void> {
  const rows = await db
    .select({ id: feedbackEffects.id })
    .from(feedbackEffects)
    .where(
      and(
        eq(feedbackEffects.userId, userId),
        eq(feedbackEffects.adId, adId),
        ...(keep ? [ne(feedbackEffects.kind, keep)] : []),
      ),
    );
  for (const r of rows) await removeFeedbackEffect(db, userId, r.id);
}
