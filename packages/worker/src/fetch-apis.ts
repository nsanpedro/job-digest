/**
 * API source acquisition (ADR-002). Mirrors gmail.ts in role — "talks to an
 * external service with the user's credentials, produces ads" — but without
 * the email-specific machinery: no raw bytes, no parsing pipeline, no
 * ad_sightings.raw_email_id. The provider interface normalizes each API's
 * idiosyncrasies; this file only handles the DB side and the concurrency cap.
 *
 * Idempotent by construction (same guarantee as ingest-email.ts):
 *   - ads are keyed on (user_id, dedupe_key) — re-fetching converges.
 *   - ad_sightings has no unique constraint on (ad_id, source_id), so each
 *     fetch appends a new sighting row. That is the correct shape: sightings
 *     record "this ad appeared in this fetch", the same way email sightings
 *     record "this ad appeared in this email". Dedup at the ad level, provenance
 *     at the sighting level — same invariant as §6.7.
 *
 * Concurrency: same cap as gmail.ts (5 in-flight) — the limit is DB
 * transactions, not API calls, since each provider's fetchJobs() is one HTTP
 * call that returns all jobs before we start writing.
 */
import { and, eq, inArray, sql } from 'drizzle-orm';
import { dedupeKeyFromStrings, extractTitleFacts } from '@job-digest/ingest';
import { adSightings, ads, runs, sources, listInterestedDirections } from '@job-digest/db';
import type { DirectionRow } from '@job-digest/db';
import { ashby } from './providers/ashby';
import { greenhouse } from './providers/greenhouse';
import { lever } from './providers/lever';
import { personio } from './providers/personio';
import type { JobBoardProvider, NormalizedJob } from './providers/types';
import { mergeFacts } from './merge-facts';
import {
  CURATION_THRESHOLDS,
  directionFitStrength,
  inferMode,
  provenanceFromFacts,
  type CurationDirection,
} from '@job-digest/core';
import { withTenant, type Db } from './tenant';

// Keep well below the app pool's max so web requests are never starved.
// The pool (max 5 in prod) is shared between the worker and the web process;
// using 2 here leaves 3 connections free for concurrent page loads.
const FETCH_CONCURRENCY = 2;

/** All registered providers, in order of preference for slug detection. */
const PROVIDERS: JobBoardProvider[] = [greenhouse, lever, ashby, personio];

/** Resolve a stored `provider` name to its adapter. */
function providerFor(name: string): JobBoardProvider | undefined {
  return PROVIDERS.find((p) => p.name === name);
}

// ── Concurrency helper (same shape as gmail.ts) ──────────────────────────────

async function mapWithConcurrency<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const item = items[next++]!;
      await fn(item);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

// ── DB write: one job → ads + ad_sightings ────────────────────────────────────

async function ingestJob(
  db: Db,
  params: {
    userId: string;
    sourceId: string;
    runId: string;
    job: NormalizedJob;
    fetchedAt: Date;
  },
): Promise<{ created: boolean }> {
  return withTenant(db, params.userId, async (tx) => {
    const { job, sourceId, userId, fetchedAt } = params;
    const key = dedupeKeyFromStrings(job.title, job.company, job.locationRaw);

    const existing = await tx
      .select()
      .from(ads)
      .where(
        and(
          eq(ads.userId, userId),
          // externalId (e.g. "greenhouse:8130725") is stable — use it when
          // available to catch a company rewording a title between fetches,
          // same secondary-match logic as the email path (§6.7).
          sql`(${ads.dedupeKey} = ${key} OR ${ads.externalId} = ${job.externalId})`,
        ),
      )
      .limit(1);

    const prior = existing[0];
    let adId: string;
    let created = false;

    if (prior) {
      const merged = mergeFacts(
        { facts: prior.facts, wording: prior.wording },
        { facts: job.facts, wording: job.wording },
      );
      await tx
        .update(ads)
        .set({
          facts: merged.facts,
          wording: merged.wording,
          lastSeenAt: fetchedAt > prior.lastSeenAt ? fetchedAt : prior.lastSeenAt,
          externalId: prior.externalId ?? job.externalId,
          externalUrl: prior.externalUrl ?? job.externalUrl,
          sourceId: prior.sourceId ?? sourceId,
        })
        .where(eq(ads.id, prior.id));
      adId = prior.id;
    } else {
      const rows = await tx
        .insert(ads)
        .values({
          userId,
          dedupeKey: key,
          externalId: job.externalId,
          externalUrl: job.externalUrl,
          title: job.title,
          company: job.company,
          locationRaw: job.locationRaw,
          source: job.platform,
          facts: job.facts,
          wording: job.wording,
          // API-sourced ads: the API is the original ad — non-null facts are
          // 'from_ad', null facts are 'unknown_after_fetch' (we already have
          // the authoritative source and the field wasn't there).
          fieldProvenance: provenanceFromFacts(job.facts, 'from_ad', true),
          titleFacts: extractTitleFacts(job.title, job.locationRaw),
          sourceId,
          // Use the fetch timestamp, not the job's original posting date: from
          // the user's perspective, they "first saw" this job when we ingested
          // it, not when the company posted it. Using postedAt would make all
          // historic jobs appear as "repeats from earlier weeks" on the first
          // fetch, which defeats the purpose of adding a source.
          firstSeenAt: fetchedAt,
          lastSeenAt: fetchedAt,
        })
        .returning({ id: ads.id });
      const row = rows[0];
      if (!row) throw new Error('ad insert returned no row');
      adId = row.id;
      created = true;
    }

    await tx.insert(adSightings).values({
      userId,
      adId,
      sourceId,
      receivedAt: fetchedAt,
    });

    return { created };
  });
}

// ── Public entry: fetch all sources for a user ────────────────────────────────

export interface FetchApisResult {
  sourceId: string;
  /** Jobs that passed the direction gate and were written (or updated) in the DB. */
  fetched: number;
  created: number;
  /** Jobs skipped because they didn't clear the gate — 0 when user has no directions. */
  skipped: number;
  error: string | null;
}

/** Project a DirectionRow to the fields the curation gate reads. */
function toCurationDirection(dir: DirectionRow): CurationDirection {
  return {
    distance: dir.distance,
    searchTerms: dir.searchTerms,
    excludeTerms: dir.excludeTerms,
  };
}

/**
 * Fetch all active API sources for a user and ingest the results.
 * Each source runs independently; a failure on one does not abort the others.
 * Updates `runs.emails_processed` as sources complete (same progress shape the
 * client polls via getRunProgress — "emails" == items here, see ADR-002 §2.8).
 */
export async function fetchApiSources(
  db: Db,
  params: {
    userId: string;
    runId: string;
  },
): Promise<FetchApisResult[]> {
  const { userId, runId } = params;

  // Read sources + directions in one transaction — same connection, same role scope.
  // Directions gate which jobs we ingest (see below); if empty, everything passes.
  const [userSources, interestedDirs] = await withTenant(db, userId, async (tx) => {
    const srcs = await tx
      .select({ id: sources.id, provider: sources.provider, externalSlug: sources.externalSlug })
      .from(sources)
      .where(and(eq(sources.userId, userId), inArray(sources.status, ['active', 'failing'])));
    const dirs = await listInterestedDirections(tx, userId);
    return [srcs, dirs] as const;
  });

  // Set total upfront so the progress bar is meaningful from the start.
  await withTenant(db, userId, (tx) =>
    tx.update(runs).set({ emailsTotal: userSources.length }).where(eq(runs.id, runId)),
  );

  const results: FetchApisResult[] = [];

  await mapWithConcurrency(userSources, FETCH_CONCURRENCY, async (source) => {
    const result: FetchApisResult = { sourceId: source.id, fetched: 0, created: 0, skipped: 0, error: null };

    try {
      const provider = providerFor(source.provider);
      if (!provider) throw new Error(`No adapter registered for provider "${source.provider}"`);

      const allJobs = await provider.fetchJobs(source.externalSlug);

      // Direction gate — Phase 1 of the curated-algo optimization. Was a
      // boolean substring match on title; now a graduated [0, 1] strength
      // (title + description + excludeTerms + distance factor) checked
      // against a mode-dependent threshold.
      //
      // Mode is inferred from the user's own direction set: 1–3 directions
      // → 'focused' (threshold 0.7), 4+ or 0 → 'discovery' (0.3). A user
      // who knows what they want gets a strict gate; one still exploring
      // gets breadth in explore. Users with no directions bypass the gate
      // entirely (as before) — nothing to gate against.
      //
      // The long-word tier (0.6) filters out role-suffix words
      // (NON_DISCRIMINATIVE_ROLE_WORDS in curation.ts) — a searchTerm
      // "Creative Director" cannot pull "Sales Director" in on "director"
      // alone. Excludes are ad-level: an exclude term in ANY direction
      // zeros the whole ad, matching the user's mental model.
      //
      // Descriptions aren't populated by the providers yet — this call
      // passes `null` and the gate degrades to title-only until the
      // provider adapters add `description` to NormalizedJob.
      const jobs = interestedDirs.length > 0
        ? (() => {
            const curationDirs = interestedDirs.map(toCurationDirection);
            const threshold = CURATION_THRESHOLDS[inferMode(curationDirs)];
            return allJobs.filter(
              (job) => directionFitStrength(job.title, null, curationDirs) >= threshold,
            );
          })()
        : allJobs;
      result.skipped = allJobs.length - jobs.length;

      const fetchedAt = new Date();

      await mapWithConcurrency(jobs, FETCH_CONCURRENCY, async (job) => {
        const r = await ingestJob(db, { userId, sourceId: source.id, runId, job, fetchedAt });
        result.fetched++;
        if (r.created) result.created++;
      });

      // Mark source healthy and record fetch time.
      await withTenant(db, userId, (tx) =>
        tx
          .update(sources)
          .set({ lastFetchedAt: fetchedAt, lastError: null, status: 'active' })
          .where(eq(sources.id, source.id)),
      );
    } catch (err) {
      result.error = err instanceof Error ? err.message : String(err);
      await withTenant(db, userId, (tx) =>
        tx
          .update(sources)
          .set({
            status: 'failing',
            lastError: { kind: 'fetch', message: result.error!, at: new Date().toISOString() },
          })
          .where(eq(sources.id, source.id)),
      );
    }

    results.push(result);

    // Increment progress after each source, same pattern as gmail.ts.
    await withTenant(db, userId, (tx) =>
      tx
        .update(runs)
        .set({ emailsProcessed: sql`${runs.emailsProcessed} + 1` })
        .where(eq(runs.id, runId)),
    );
  });

  return results;
}

/**
 * Parse a user-pasted URL and return the matching provider + slug, or null
 * if no registered provider recognises it. Used by the `addSource` server
 * action (I20 — validation on add).
 */
export function parseSourceUrl(url: string): { provider: JobBoardProvider; slug: string } | null {
  for (const provider of PROVIDERS) {
    const slug = provider.parseSlugFromUrl(url);
    if (slug) return { provider, slug };
  }
  return null;
}
