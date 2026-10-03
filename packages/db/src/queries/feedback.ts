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
import {
  planExcludeCarryOver,
  type DismissReason,
  type ExcludeCarryOver,
  type FeedbackEffect,
  type FeedbackEffectKind,
} from '@job-digest/core';
import { and, eq, inArray, ne } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import {
  ads,
  adUserState,
  directions,
  dismissReasonEnum,
  EFFECTIVE_DIRECTION_STATES,
  feedbackEffects,
  profiles,
} from '../schema';

type Db = PostgresJsDatabase<Record<string, unknown>>;

// The core type and the Postgres enum must list the same values.
const _reasonsMatch: readonly DismissReason[] = dismissReasonEnum.enumValues;
void _reasonsMatch;

export interface FeedbackEffectRow extends FeedbackEffect {
  id: string;
  adId: string | null;
  /** Label of the direction an exclude belongs to; null for a mute. */
  directionLabel: string | null;
  /**
   * Whether the matcher reads it now. Always true for a mute. For an
   * exclude: its direction is in the active profile version and not
   * dismissed — the set `listInterestedDirections` returns (I26).
   */
  applied: boolean;
}

const EFFECTIVE_STATES: ReadonlySet<string> = new Set(EFFECTIVE_DIRECTION_STATES);

/** Every saved effect for this user, oldest first — including excludes held on a retired direction. */
export async function listFeedbackEffects(db: Db, userId: string): Promise<FeedbackEffectRow[]> {
  const rows = await db
    .select({
      effect: feedbackEffects,
      directionLabel: directions.label,
      directionState: directions.state,
      versionActive: profiles.isActive,
    })
    .from(feedbackEffects)
    .leftJoin(directions, eq(directions.id, feedbackEffects.directionId))
    .leftJoin(
      profiles,
      and(eq(profiles.userId, directions.userId), eq(profiles.version, directions.profileVersion)),
    )
    .where(eq(feedbackEffects.userId, userId))
    .orderBy(feedbackEffects.createdAt);
  return rows.map(({ effect, directionLabel, directionState, versionActive }) => ({
    id: effect.id,
    kind: effect.kind,
    adId: effect.adId,
    directionId: effect.directionId,
    directionLabel: directionLabel ?? null,
    applied:
      effect.kind === 'mute_company' ||
      (versionActive === true && directionState !== null && EFFECTIVE_STATES.has(directionState)),
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
    await addTermToDirection(db, d, term);
    await db
      .insert(feedbackEffects)
      .values({ userId, kind: 'exclude_term', adId: input.adId, directionId: d.id, value: term, valueKey: key })
      .onConflictDoNothing();
  }
}

/**
 * Adds `term` to a direction's excludes unless it already has it (any case)
 * and returns the resulting list. The one writer of
 * `directions.exclude_terms`, for a dismissal and a carry-over alike.
 */
async function addTermToDirection(
  db: Db,
  direction: { id: string; excludeTerms: readonly string[] },
  term: string,
): Promise<string[]> {
  const key = term.trim().toLowerCase();
  if (direction.excludeTerms.some((t) => t.trim().toLowerCase() === key)) return [...direction.excludeTerms];
  const next = [...direction.excludeTerms, term];
  await db.update(directions).set({ excludeTerms: next, updatedAt: new Date() }).where(eq(directions.id, direction.id));
  return next;
}

/**
 * Moves every exclude saved on a direction outside `version` onto
 * `version`'s effective directions (ADR-003 §8.13, I27) — called by
 * `completeDerivation` in its transaction, right after the new version is
 * activated. The decision is `planExcludeCarryOver` (pure): a word goes to
 * every new direction unless one of them searches for it; a word that
 * cannot move stays on its retired direction, inert, listed in Profile as
 * not applied, and is planned again at the next derivation.
 *
 * A moved row keeps its `ad_id` (Undo on that dismissal still removes it)
 * and its `created_at` (the eval's temporal split). The source rows are
 * deleted; the retired directions' own `exclude_terms` are left as they
 * were — nothing reads a retired direction.
 *
 * Idempotent: a second run finds nothing outside `version` except the
 * held words, and holds them again.
 */
export async function carryOverExcludes(db: Db, userId: string, version: number): Promise<ExcludeCarryOver> {
  const retired = await db
    .select({
      id: feedbackEffects.id,
      adId: feedbackEffects.adId,
      value: feedbackEffects.value,
      valueKey: feedbackEffects.valueKey,
      createdAt: feedbackEffects.createdAt,
    })
    .from(feedbackEffects)
    .innerJoin(directions, eq(directions.id, feedbackEffects.directionId))
    .where(
      and(
        eq(feedbackEffects.userId, userId),
        eq(feedbackEffects.kind, 'exclude_term'),
        ne(directions.profileVersion, version),
      ),
    );
  if (retired.length === 0) return { carry: [], held: [] };

  const next = await db
    .select({
      id: directions.id,
      label: directions.label,
      searchTerms: directions.searchTerms,
      excludeTerms: directions.excludeTerms,
    })
    .from(directions)
    .where(
      and(
        eq(directions.userId, userId),
        eq(directions.profileVersion, version),
        inArray(directions.state, [...EFFECTIVE_DIRECTION_STATES]),
      ),
    );
  const plan = planExcludeCarryOver(retired, next);

  const excludeTerms = new Map(next.map((d) => [d.id, d.excludeTerms]));
  for (const word of plan.carry) {
    for (const directionId of word.directionIds) {
      const current = excludeTerms.get(directionId) ?? [];
      excludeTerms.set(directionId, await addTermToDirection(db, { id: directionId, excludeTerms: current }, word.value));
      await db
        .insert(feedbackEffects)
        .values({
          userId,
          kind: 'exclude_term',
          adId: word.adId,
          directionId,
          value: word.value,
          valueKey: word.valueKey,
          createdAt: word.createdAt,
        })
        .onConflictDoNothing();
    }
    await db
      .delete(feedbackEffects)
      .where(and(eq(feedbackEffects.userId, userId), inArray(feedbackEffects.id, word.sourceIds)));
  }
  return plan;
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
 * Remove a word from every direction that holds it — Profile → "From your
 * dismissals" lists a word once, however many directions hold it. Taking it
 * off one direction only would leave it filtering at ingest, where the
 * excludes of all directions apply together.
 */
export async function removeExcludeTerm(db: Db, userId: string, valueKey: string): Promise<void> {
  const rows = await db
    .select({ id: feedbackEffects.id })
    .from(feedbackEffects)
    .where(
      and(
        eq(feedbackEffects.userId, userId),
        eq(feedbackEffects.kind, 'exclude_term'),
        eq(feedbackEffects.valueKey, valueKey),
      ),
    );
  for (const r of rows) await removeFeedbackEffect(db, userId, r.id);
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
