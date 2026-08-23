/**
 * Auto-discover ATS boards for companies that appeared in this run's emails.
 *
 * After each Gmail ingestion, we look at companies that showed up in newly
 * created ads (email-sourced, not API-sourced) and don't already have a
 * matching source row. For each, we probe the four supported providers via
 * HTTP (no AI, no cost beyond the HTTP requests). A match is inserted as a
 * 'suggested' source — the user sees it and decides whether to add it.
 *
 * Bounded: at most MAX_PER_RUN companies probed per run, to keep the
 * background job fast regardless of how many new companies arrived.
 */
import { and, eq, gte, inArray, isNull, sql } from 'drizzle-orm';
import { ads, sources } from '@job-digest/db';
import { discoverBoard, normalizeToSlugs } from './providers/discover-board';
import { withTenant, type Db } from './tenant';

const MAX_PER_RUN = 5;

export async function discoverSources(db: Db, userId: string, since: Date): Promise<void> {
  // Ads created this run from email ingestion (sourceId IS NULL = email path).
  // Null company names can't be probed — excluded upfront.
  const newAds = await withTenant(db, userId, (tx) =>
    tx
      .selectDistinct({ company: ads.company })
      .from(ads)
      .where(
        and(
          eq(ads.userId, userId),
          gte(ads.firstSeenAt, since),
          isNull(ads.sourceId),
          // company is nullable in the schema; sql`` lets us filter cleanly.
          sql`${ads.company} IS NOT NULL AND ${ads.company} != ''`,
        ),
      )
      .limit(MAX_PER_RUN * 3), // fetch more than we probe to allow for already-known companies
  );

  if (newAds.length === 0) return;

  // For each company, generate slug candidates and skip if any already exist
  // in sources for this user (active, failing, disabled, or suggested).
  const toProbe: string[] = [];
  for (const { company } of newAds) {
    if (!company || toProbe.length >= MAX_PER_RUN) break;
    const slugCandidates = normalizeToSlugs(company);
    if (slugCandidates.length === 0) continue;

    const existing = await withTenant(db, userId, (tx) =>
      tx
        .select({ id: sources.id })
        .from(sources)
        .where(
          and(
            eq(sources.userId, userId),
            inArray(sources.externalSlug, slugCandidates),
          ),
        )
        .limit(1),
    );

    if (existing.length === 0) toProbe.push(company);
  }

  if (toProbe.length === 0) return;

  // Probe in parallel (discoverBoard already races internally per company).
  await Promise.allSettled(
    toProbe.map(async (company) => {
      const found = await discoverBoard(company);
      if (!found) return;

      // Insert as suggested — ignore conflicts (idempotent on provider+slug).
      await withTenant(db, userId, async (tx) => {
        const conflict = await tx
          .select({ id: sources.id })
          .from(sources)
          .where(
            and(
              eq(sources.userId, userId),
              eq(sources.provider, found.providerName as any),
              eq(sources.externalSlug, found.slug),
            ),
          )
          .limit(1);
        if (conflict.length > 0) return;

        await tx.insert(sources).values({
          userId,
          provider: found.providerName as any,
          externalSlug: found.slug,
          displayName: found.displayName,
          status: 'suggested',
        });
      });
    }),
  );
}
