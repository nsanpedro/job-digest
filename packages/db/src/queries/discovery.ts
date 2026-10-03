/**
 * Persistence for role discovery from a CV (docs/adr-001-role-discovery.md §3).
 *
 * Same shape as ruleset.ts and actions.ts's run-polling pair on purpose:
 * `startDerivation` inserts a 'running' row and returns immediately (the
 * caller runs the model call in `after()`, same as `startRefresh`), progress
 * is polled via `getDerivationProgress`, and the result lands in two places
 * for two different reasons — `profiles.data` holds the full CV-adjacent
 * snapshot (skills with their quotes, dropped items, prompt/model version),
 * `directions` holds only what a direction card renders, denormalized so
 * reading the list never touches the CV text again.
 *
 * Like every other query module here, these functions are tenant-agnostic —
 * the caller wraps the call in a tenant-scoped transaction (`withTenant`),
 * the same convention `ruleset.ts` and `digest.ts` already follow. The
 * explicit `eq(table.userId, userId)` filters below are not redundant with
 * that: they make each query correct on its own terms, independent of
 * whether RLS happens to be active for the connection running it.
 */
import type { AdMarket, Derivation, Direction, DroppedItem, Skill } from '@job-digest/core';
import { and, desc, eq, gte, inArray } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { ads, directions, EFFECTIVE_DIRECTION_STATES, profiles } from '../schema';
import { carryOverExcludes } from './feedback';
import type { DerivationProgress, DirectionRow } from './types';

type Db = PostgresJsDatabase<Record<string, unknown>>;

/** What a completed derivation needs to persist — `Derivation` plus the provenance a snapshot should carry. */
export interface DerivationResult extends Derivation {
  dropped: DroppedItem[];
  promptVersion: number;
  model: string;
  /** The job-ad market the search terms were written for (prompt v2+). Kept in the snapshot only. */
  market?: AdMarket;
}

/**
 * One `directions` insert row per surviving direction — pure, so the
 * mapping is testable without Postgres. `excludeTerms` are the model's
 * proposals, already gated by `parseDerivation` (never a word any of these
 * directions searches for). Every row is new: a re-derivation writes a new
 * `profile_version`, so nothing here can overwrite excludes a user added to
 * an earlier version's direction — those rows are left exactly as they are.
 */
export function directionInsertValues(userId: string, version: number, derived: readonly Direction[]) {
  return derived.map((d) => ({
    userId,
    profileVersion: version,
    label: d.label,
    rationale: d.rationale,
    bridge: d.bridge,
    searchTerms: d.searchTerms,
    excludeTerms: d.excludeTerms ?? [],
    distance: d.distance,
    seenTitles: d.seenTitles,
    state: 'interested' as const,
  }));
}

function nextVersion(db: Db, userId: string) {
  return db
    .select({ version: profiles.version })
    .from(profiles)
    .where(eq(profiles.userId, userId))
    .orderBy(desc(profiles.version))
    .limit(1);
}

/**
 * Insert a 'running' profile row and return its id/version immediately — the
 * caller starts the model call in `after()` right after this returns, same
 * split as `startRefresh`/`runIngestion`. `data` starts as `{}`, replaced by
 * `completeDerivation`; nothing reads it while `status` is 'running'.
 */
export async function startDerivation(db: Db, userId: string): Promise<{ profileId: string; version: number }> {
  const current = await nextVersion(db, userId);
  const version = (current[0]?.version ?? 0) + 1;
  const rows = await db
    .insert(profiles)
    .values({ userId, version, data: {}, isActive: false, status: 'running' })
    .returning({ id: profiles.id });
  const row = rows[0];
  if (!row) throw new Error('profile insert returned no row');
  return { profileId: row.id, version };
}

/**
 * Resolve a derivation on success: store the full snapshot, activate this
 * version (deactivating any prior one — same one-active-version pattern
 * `saveRuleset` uses for `rulesets`), create one `directions` row per
 * surviving direction (`directionInsertValues` — auto-confirmed,
 * `state: 'interested'`, with the model's gated exclude terms), and move the
 * user's dismissal excludes onto them.
 *
 * Activating the version is what retires the previous directions: only the
 * active version's directions are read (`listInterestedDirections`, I26).
 * Nothing is written to the old rows. Their excludes move in the same
 * transaction (`carryOverExcludes`, I27), so there is no moment where the
 * new directions are live and the user's excludes are not.
 *
 * `onConflictDoNothing` on the (user, version, label) unique index makes a
 * retried completion idempotent rather than erroring on a double-insert —
 * a retry never replaces `exclude_terms` a user has edited since — and the
 * carry-over is idempotent too.
 */
export async function completeDerivation(
  db: Db,
  userId: string,
  profileId: string,
  version: number,
  result: DerivationResult,
): Promise<void> {
  const { skills, directions: derivedDirections, dropped, promptVersion, model, market } = result;

  await db.update(profiles).set({ isActive: false }).where(eq(profiles.userId, userId));
  await db
    .update(profiles)
    .set({
      status: 'ok',
      isActive: true,
      data: { skills, dropped, promptVersion, model, market: market ?? null, derivedAt: new Date().toISOString() } satisfies Record<
        string,
        unknown
      >,
    })
    .where(and(eq(profiles.userId, userId), eq(profiles.id, profileId)));

  if (derivedDirections.length > 0) {
    await db
      .insert(directions)
      .values(directionInsertValues(userId, version, derivedDirections))
      .onConflictDoNothing({ target: [directions.userId, directions.profileVersion, directions.label] });
  }

  await carryOverExcludes(db, userId, version);
}

/** Resolve a derivation on failure — `errorKind` mirrors `CvExtractionFailure` plus 'refused' and 'internal'. */
export async function failDerivation(
  db: Db,
  userId: string,
  profileId: string,
  errorKind: string,
  message: string,
): Promise<void> {
  await db
    .update(profiles)
    .set({
      status: 'error',
      errorKind: errorKind as never, // enum-typed column; caller passes one of CvExtractionFailure | 'refused' | 'internal'
      errorDetail: { message },
    })
    .where(and(eq(profiles.userId, userId), eq(profiles.id, profileId)));
}

/** Polled by the client while a derivation is in flight — see `getRunProgress` for the identical shape. */
export async function getDerivationProgress(
  db: Db,
  userId: string,
  profileId: string,
): Promise<DerivationProgress | null> {
  const rows = await db
    .select({ status: profiles.status, errorKind: profiles.errorKind, errorDetail: profiles.errorDetail })
    .from(profiles)
    .where(and(eq(profiles.userId, userId), eq(profiles.id, profileId)))
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  const message = row.errorDetail && typeof row.errorDetail['message'] === 'string' ? row.errorDetail['message'] : null;
  return { status: row.status, errorKind: row.errorKind, errorMessage: message };
}

/** The most recent completed derivation, or null if none has ever succeeded. */
export async function getActiveProfile(
  db: Db,
  userId: string,
): Promise<{ version: number; skills: Skill[]; dropped: DroppedItem[]; promptVersion: number; model: string } | null> {
  const rows = await db
    .select({ version: profiles.version, data: profiles.data })
    .from(profiles)
    .where(and(eq(profiles.userId, userId), eq(profiles.isActive, true)))
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  const data = row.data as { skills?: Skill[]; dropped?: DroppedItem[]; promptVersion?: number; model?: string };
  return {
    version: row.version,
    skills: data.skills ?? [],
    dropped: data.dropped ?? [],
    promptVersion: data.promptVersion ?? 0,
    model: data.model ?? '',
  };
}

/** Directions from one derivation, most recently created first. */
export async function listDirections(db: Db, userId: string, profileVersion: number): Promise<DirectionRow[]> {
  const rows = await db
    .select()
    .from(directions)
    .where(and(eq(directions.userId, userId), eq(directions.profileVersion, profileVersion)))
    .orderBy(desc(directions.createdAt));
  return rows.map((r) => ({
    id: r.id,
    profileVersion: r.profileVersion,
    label: r.label,
    rationale: r.rationale,
    bridge: r.bridge,
    searchTerms: r.searchTerms,
    excludeTerms: r.excludeTerms,
    distance: r.distance,
    seenTitles: r.seenTitles,
    state: r.state,
  }));
}

/**
 * The user's own decision on a direction — 'interested' opts into the
 * digest coverage line (Phase 4), 'dismissed' hides it, 'alert_configured'
 * records that they followed through and set up the search themselves.
 */
export async function setDirectionState(
  db: Db,
  userId: string,
  directionId: string,
  state: 'suggested' | 'interested' | 'dismissed' | 'alert_configured',
): Promise<void> {
  await db
    .update(directions)
    .set({ state, updatedAt: new Date() })
    .where(and(eq(directions.userId, userId), eq(directions.id, directionId)));
}

/**
 * Every direction the digest, the ingest gate and the dismiss follow-up
 * read: the active profile version's directions in 'suggested',
 * 'interested' or 'alert_configured'. Directions start at 'interested'
 * after derivation (auto-confirmed); 'suggested' is kept for backward
 * compatibility with directions derived before that change.
 *
 * Active version only (ADR-003 §8.13, I26): a re-derivation retires the
 * previous version's directions by activating a new version. Profile lists
 * exactly that version (`listDirections(activeVersion)`), so every direction
 * read here is one the user can see and dismiss. No active version (no CV
 * yet) → no directions, and the ingest gate lets everything through.
 */
export async function listInterestedDirections(db: Db, userId: string): Promise<DirectionRow[]> {
  const rows = await db
    .select({ d: directions })
    .from(directions)
    .innerJoin(
      profiles,
      and(eq(profiles.userId, directions.userId), eq(profiles.version, directions.profileVersion)),
    )
    .where(
      and(
        eq(directions.userId, userId),
        eq(profiles.isActive, true),
        inArray(directions.state, [...EFFECTIVE_DIRECTION_STATES]),
      ),
    );
  return rows.map(({ d: r }) => ({
    id: r.id,
    profileVersion: r.profileVersion,
    label: r.label,
    rationale: r.rationale,
    bridge: r.bridge,
    searchTerms: r.searchTerms,
    excludeTerms: r.excludeTerms,
    distance: r.distance,
    seenTitles: r.seenTitles,
    state: r.state,
  }));
}

/**
 * The user's own distinct ad titles, for `deriveDirections`' second input —
 * capped here too (not just inside `deriveDirections`) so a user with
 * thousands of ads doesn't pull more rows than the model will ever see.
 */
export async function getDistinctAdTitles(db: Db, userId: string, limit = 50): Promise<string[]> {
  const rows = await db.selectDistinct({ title: ads.title }).from(ads).where(eq(ads.userId, userId)).limit(limit);
  return rows.map((r) => r.title);
}

/**
 * How many derivations this user has started since `since` — the rate-limit
 * check `uploadCv` runs before doing any work. Counts every attempt
 * (running/ok/error alike), not just successes: a user retrying against a
 * transient failure still spends the budget, same as a retried Gmail sync
 * still counts as a run.
 *
 * Counts every `profiles` row, on the assumption that role discovery is
 * still the table's only writer (true as of this feature) — if `profiles`
 * ever gets a second writer, this needs a `where` narrowing it back to rows
 * that came from a derivation.
 */
export async function countDerivationsSince(db: Db, userId: string, since: Date): Promise<number> {
  const rows = await db
    .select({ id: profiles.id })
    .from(profiles)
    .where(and(eq(profiles.userId, userId), gte(profiles.savedAt, since)));
  return rows.length;
}

/**
 * Does this ad title count as evidence for a direction the user is tracking?
 * Literal, case-insensitive substring match of a search term (or the
 * direction's own label) against the title — the same "cite the literal
 * text, never fuzzy-guess" discipline `verifyQuote` already applies to
 * quotes (I5/I17), applied here to counting instead of citing. Deliberately
 * not a scored/fuzzy match: a direction's coverage is something the UI
 * counts, never something it scores (I18 — no percentage, ever).
 */
function matchesDirection(title: string, direction: { label: string; searchTerms: string[] }): boolean {
  const t = title.toLowerCase();
  if (t.includes(direction.label.toLowerCase())) return true;
  return direction.searchTerms.some((term) => t.includes(term.toLowerCase()));
}

/**
 * How many of the user's own ads match a direction being tracked — the
 * "loop" from ADR-001 §3, computed at read time (I6's shape: nothing here is
 * ever stored), one query for all directions rather than one per direction.
 */
export async function getDirectionCoverage(
  db: Db,
  userId: string,
  directionsToCheck: readonly Pick<DirectionRow, 'id' | 'label' | 'searchTerms'>[],
): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  if (directionsToCheck.length === 0) return counts;

  const rows = await db.select({ title: ads.title }).from(ads).where(eq(ads.userId, userId));
  const titles = rows.map((r) => r.title);

  for (const d of directionsToCheck) {
    counts.set(
      d.id,
      titles.filter((title) => matchesDirection(title, d)).length,
    );
  }
  return counts;
}
