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
import type { Db } from './tenant';

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
  await Promise.allSettled(CURATED_COMPANIES.map((c) => refreshCompany(db, c)));
}
