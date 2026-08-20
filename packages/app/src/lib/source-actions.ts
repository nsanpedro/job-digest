'use server';

/**
 * Server actions for managing API sources (ADR-002). Same file shape as
 * discovery-actions.ts — source mutations live here, not in actions.ts,
 * to keep each file's scope clear.
 *
 * I20: a source is validated on add or it is not added. `addSource` calls
 * the provider's validateSlug() before inserting — a slug that 404s on the
 * API never reaches the database.
 */
import { revalidatePath } from 'next/cache';
import { after } from 'next/server';
import { runs, sources } from '@job-digest/db';
import { eq, and } from 'drizzle-orm';
import { fetchApiSources, parseSourceUrl, withTenant as workerWithTenant } from '@job-digest/worker';
import { currentUserId, rawPool, withTenant } from './session';

/** Freshness window: skip re-fetch if a source was fetched less than this ago. */
const MIN_FETCH_INTERVAL_MS = 5 * 60 * 1000;

/**
 * Parse and validate a user-pasted URL, then insert the source if valid.
 * Returns the new source id on success, or an error string on failure.
 */
export async function addSource(
  url: string,
): Promise<{ sourceId: string } | { error: string }> {
  const userId = await currentUserId();

  const parsed = parseSourceUrl(url.trim());
  if (!parsed) {
    return { error: 'URL not recognised — paste the job board URL directly (e.g. boards.greenhouse.io/stripe).' };
  }

  const { provider, slug } = parsed;

  // I20: validate slug against the real API before inserting.
  let displayName: string;
  try {
    displayName = await provider.validateSlug(slug);
  } catch (err) {
    return { error: err instanceof Error ? err.message : 'Company not found — check the URL and try again.' };
  }

  // Insert or return existing (same user, same provider+slug = idempotent).
  const existing = await withTenant(userId, (tx) =>
    tx
      .select({ id: sources.id })
      .from(sources)
      .where(
        and(
          eq(sources.userId, userId),
          eq(sources.provider, provider.name),
          eq(sources.externalSlug, slug),
        ),
      )
      .limit(1),
  );

  if (existing[0]) return { sourceId: existing[0].id };

  const rows = await withTenant(userId, (tx) =>
    tx
      .insert(sources)
      .values({ userId, provider: provider.name, externalSlug: slug, displayName })
      .returning({ id: sources.id }),
  );
  const row = rows[0];
  if (!row) return { error: 'Failed to save source — try again.' };

  revalidatePath('/profile');
  return { sourceId: row.id };
}

/** Remove a source the user owns. Silently no-ops if not found (idempotent). */
export async function removeSource(sourceId: string): Promise<void> {
  const userId = await currentUserId();
  await withTenant(userId, (tx) =>
    tx.delete(sources).where(and(eq(sources.id, sourceId), eq(sources.userId, userId))),
  );
  revalidatePath('/profile');
}

/**
 * List all sources for the current user, ordered by display name.
 * Used by the Profile page to render the "Companies to watch" section.
 */
export async function getSources(): Promise<
  Array<{
    id: string;
    provider: string;
    externalSlug: string;
    displayName: string;
    status: string;
    lastFetchedAt: Date | null;
    lastError: { kind: string; message: string; at: string } | null;
  }>
> {
  const userId = await currentUserId();
  return withTenant(userId, (tx) =>
    tx
      .select({
        id: sources.id,
        provider: sources.provider,
        externalSlug: sources.externalSlug,
        displayName: sources.displayName,
        status: sources.status,
        lastFetchedAt: sources.lastFetchedAt,
        lastError: sources.lastError,
      })
      .from(sources)
      .where(eq(sources.userId, userId))
      .orderBy(sources.displayName),
  );
}

/**
 * Trigger a fetch for all active sources. Called from "Update now" alongside
 * the Gmail fetch (step 5 of the implementation plan). Respects the freshness
 * window — sources fetched less than 5 min ago are skipped silently.
 *
 * Returns the run id so the client can poll progress.
 */
export async function fetchSourcesNow(): Promise<{ runId: string }> {
  const userId = await currentUserId();
  const db = rawPool();

  const run = await workerWithTenant(db, userId, (tx) =>
    tx
      .insert(runs)
      .values({ userId, parserVersion: 0 })
      .returning({ id: runs.id }),
  );
  const runId = run[0]!.id;

  after(() => fetchApiSources(db, { userId, runId }));

  return { runId };
}
