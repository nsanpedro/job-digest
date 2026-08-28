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
import { accounts, runs, sources } from '@job-digest/db';
import { and, eq, sql } from 'drizzle-orm';
import {
  CURATED_COMPANIES,
  fetchApiSources,
  parseSourceUrl,
  withTenant as workerWithTenant,
  type CuratedCompany,
  type Market as CuratedMarket,
} from '@job-digest/worker';
import { inferMarket, type Market } from './market';
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
      .select({ id: sources.id, status: sources.status })
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

  if (existing[0]) {
    // If it was auto-discovered (suggested) and the user manually adds the same
    // board, promote it to active — they've given explicit intent.
    if (existing[0].status === 'suggested') {
      await withTenant(userId, (tx) =>
        tx.update(sources).set({ status: 'active' }).where(eq(sources.id, existing[0]!.id)),
      );
      revalidatePath('/profile');
    }
    return { sourceId: existing[0].id };
  }

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
 * List active/failing/disabled sources for the current user (not suggested).
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
      .where(and(eq(sources.userId, userId), sql`${sources.status} != 'suggested'`))
      .orderBy(sources.displayName),
  );
}

/**
 * Boards discovered automatically that the user hasn't approved yet.
 * Shown as a separate "Suggested boards" section in SourcesManager.
 */
export async function getSuggestedSources(): Promise<
  Array<{ id: string; provider: string; displayName: string; externalSlug: string }>
> {
  const userId = await currentUserId();
  return withTenant(userId, (tx) =>
    tx
      .select({
        id: sources.id,
        provider: sources.provider,
        displayName: sources.displayName,
        externalSlug: sources.externalSlug,
      })
      .from(sources)
      .where(and(eq(sources.userId, userId), eq(sources.status, 'suggested')))
      .orderBy(sources.displayName),
  );
}

/** Approve a suggested board — it becomes active and will be fetched on next run. */
export async function approveSuggestedSource(sourceId: string): Promise<void> {
  const userId = await currentUserId();
  await withTenant(userId, (tx) =>
    tx
      .update(sources)
      .set({ status: 'active' })
      .where(and(eq(sources.id, sourceId), eq(sources.userId, userId), eq(sources.status, 'suggested'))),
  );
  revalidatePath('/profile');
}

/** Dismiss a suggested board — deletes the row so it won't resurface. */
export async function dismissSuggestedSource(sourceId: string): Promise<void> {
  const userId = await currentUserId();
  await withTenant(userId, (tx) =>
    tx
      .delete(sources)
      .where(and(eq(sources.id, sourceId), eq(sources.userId, userId), eq(sources.status, 'suggested'))),
  );
  revalidatePath('/profile');
}

// ── Curated catalog ─────────────────────────────────────────────────────────

/**
 * One entry in the curated catalog, decorated with whether the current user
 * already has it active. Rendered by CuratedCatalog as a toggle grid — the
 * primary "add companies" flow that replaces the URL-pasting form.
 */
export interface CuratedEntry {
  name: string;
  provider: 'Greenhouse' | 'Lever' | 'Ashby' | 'Personio';
  slug: string;
  markets: CuratedMarket[];
  city: string | null;
  tags: string[];
  curatorNote: string | null;
  /** True if the user has this slug in their sources (active or failing). */
  active: boolean;
}

/**
 * Return the curated catalog filtered to the requested market, decorated
 * with the user's active state per entry. `market='ALL'` returns every
 * entry regardless of geography — the fallback when the user hasn't set a
 * city and we can't infer.
 */
export async function getCuratedCatalog(market: Market): Promise<{
  market: Market;
  entries: CuratedEntry[];
}> {
  const userId = await currentUserId();

  const [userSources, city] = await withTenant(userId, async (tx) => {
    const s = await tx
      .select({ provider: sources.provider, externalSlug: sources.externalSlug })
      .from(sources)
      .where(and(eq(sources.userId, userId), sql`${sources.status} != 'suggested'`));
    const c = await tx
      .select({ city: accounts.city })
      .from(accounts)
      .where(eq(accounts.id, userId))
      .limit(1);
    return [s, c[0]?.city ?? null] as const;
  });

  // If the caller didn't force a market, use the stored city; the client can
  // still override by passing an explicit market to switch the filter.
  const resolved: Market = market === 'ALL' ? inferMarket(city) : market;

  const activeSet = new Set(userSources.map((s) => `${s.provider}::${s.externalSlug}`));
  const filtered: CuratedCompany[] =
    resolved === 'ALL'
      ? CURATED_COMPANIES
      : CURATED_COMPANIES.filter((c) => c.markets.includes(resolved as CuratedMarket));

  const entries: CuratedEntry[] = filtered
    .map((c) => ({
      name: c.name,
      provider: c.provider,
      slug: c.slug,
      markets: c.markets,
      city: c.city ?? null,
      tags: c.tags ?? [],
      curatorNote: c.curatorNote ?? null,
      active: activeSet.has(`${c.provider}::${c.slug}`),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));

  return { market: resolved, entries };
}

/**
 * Toggle a curated entry on the user's watchlist. `on=true` inserts (or
 * promotes a suggested row to active); `on=false` deletes the row. Idempotent
 * on both sides — safe to call regardless of current state. Trusts the
 * catalog constant for `(provider, slug, displayName)`; we intentionally do
 * NOT re-run `validateSlug` here since every catalog entry is pre-verified.
 */
export async function toggleCuratedCompany(params: {
  provider: 'Greenhouse' | 'Lever' | 'Ashby' | 'Personio';
  slug: string;
  on: boolean;
}): Promise<{ ok: true } | { error: string }> {
  const userId = await currentUserId();
  const { provider, slug, on } = params;

  const entry = CURATED_COMPANIES.find((c) => c.provider === provider && c.slug === slug);
  if (!entry) return { error: 'Company not in curated catalog.' };

  if (on) {
    const existing = await withTenant(userId, (tx) =>
      tx
        .select({ id: sources.id, status: sources.status })
        .from(sources)
        .where(
          and(
            eq(sources.userId, userId),
            eq(sources.provider, provider),
            eq(sources.externalSlug, slug),
          ),
        )
        .limit(1),
    );

    if (existing[0]) {
      if (existing[0].status === 'suggested') {
        await withTenant(userId, (tx) =>
          tx.update(sources).set({ status: 'active' }).where(eq(sources.id, existing[0]!.id)),
        );
      }
    } else {
      await withTenant(userId, (tx) =>
        tx
          .insert(sources)
          .values({ userId, provider, externalSlug: slug, displayName: entry.name })
          .onConflictDoNothing(),
      );
    }
  } else {
    await withTenant(userId, (tx) =>
      tx
        .delete(sources)
        .where(
          and(
            eq(sources.userId, userId),
            eq(sources.provider, provider),
            eq(sources.externalSlug, slug),
          ),
        ),
    );
  }

  revalidatePath('/profile');
  return { ok: true };
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
