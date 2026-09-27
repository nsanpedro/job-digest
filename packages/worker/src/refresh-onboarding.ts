/**
 * Rebuild the onboarding preview cache from all curated companies.
 *
 * Runs as the worker role (INSERT/UPDATE/DELETE grants on onboarding_cache).
 * Safe to call at any time — upserts are idempotent. A failing company is
 * logged and skipped; it does not abort the rest of the batch.
 */
import { sql } from 'drizzle-orm';
import { onboardingCache } from '@job-digest/db';
import { ashby } from './providers/ashby';
import { greenhouse } from './providers/greenhouse';
import { lever } from './providers/lever';
import { personio } from './providers/personio';
import type { JobBoardProvider } from './providers/types';
import { CURATED_COMPANIES, type CuratedCompany } from './curated-companies';
import { mapWithConcurrency } from './concurrency';
import type { Db } from './tenant';

/**
 * How many companies refresh in parallel. Each one opens its own
 * `db.transaction` with `SET LOCAL ROLE worker`, so this directly caps
 * how many Postgres connections the refresh holds at once against the
 * shared 15-connection Supabase pooler. 3 leaves margin over the app
 * pool (max: 4) and above whatever ingest happens to be running.
 * CURATED_COMPANIES.length is 28 today — the old
 * `Promise.allSettled(CURATED_COMPANIES.map(...))` would have opened all
 * 28 transactions concurrently, blowing past the pool the same way the
 * /profile incident (2026-09-18) did.
 */
const REFRESH_CONCURRENCY = 3;

const PROVIDERS: Record<string, JobBoardProvider> = {
  Greenhouse: greenhouse,
  Lever: lever,
  Ashby: ashby,
  Personio: personio,
};

async function refreshCompany(db: Db, company: CuratedCompany): Promise<void> {
  const provider = PROVIDERS[company.provider];
  if (!provider) return;

  let jobs;
  try {
    jobs = await provider.fetchJobs(company.slug);
  } catch (err) {
    console.warn(`[onboarding-cache] skip ${company.name}: ${err instanceof Error ? err.message : err}`);
    return;
  }

  if (jobs.length === 0) return;

  await db.transaction(async (tx) => {
    await tx.execute(sql`SET LOCAL ROLE worker`);
    await tx
      .insert(onboardingCache)
      .values(
        jobs.map((job) => ({
          provider: company.provider,
          slug: company.slug,
          displayName: company.name,
          title: job.title,
          locationRaw: job.locationRaw,
          externalUrl: job.externalUrl,
          externalId: job.externalId,
          postedAt: job.postedAt,
        })),
      )
      .onConflictDoUpdate({
        target: [onboardingCache.provider, onboardingCache.slug, onboardingCache.externalId],
        set: {
          title: sql`EXCLUDED.title`,
          locationRaw: sql`EXCLUDED.location_raw`,
          externalUrl: sql`EXCLUDED.external_url`,
          postedAt: sql`EXCLUDED.posted_at`,
          fetchedAt: sql`now()`,
        },
      });
  });
}

export async function refreshOnboardingCache(db: Db): Promise<void> {
  // refreshCompany catches its own provider fetch errors, but a
  // transaction-level failure (connection reset, lock timeout, malformed
  // row) would still escape. The old Promise.allSettled swallowed those;
  // this wrapper preserves that tolerance — one company failing does not
  // stop the rest — while capping in-flight transactions to REFRESH_CONCURRENCY.
  await mapWithConcurrency(CURATED_COMPANIES.slice(), REFRESH_CONCURRENCY, async (c) => {
    try {
      await refreshCompany(db, c);
    } catch (err) {
      console.warn(`[onboarding-cache] tx failed for ${c.name}: ${err instanceof Error ? err.message : err}`);
    }
  });
}
