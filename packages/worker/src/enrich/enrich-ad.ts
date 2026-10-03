/**
 * Post-ingest enrichment for email-sourced ads (ADR-003 Tier 1).
 *
 * Called outside the ingest transaction — network I/O cannot run inside
 * a Postgres transaction. Writes one `ad_enrichments` row and patches
 * `ads.facts` + `ads.field_provenance` in a separate withTenant call.
 *
 * Idempotent: the unique index on (user_id, ad_id) in ad_enrichments makes
 * a re-run upsert the row; the facts patch is a merge (fills nulls only).
 *
 * Also fills `ads.description` from the fetched description when the ad has
 * none yet (ADR-003 §8.10 "Descriptions in matching"): an email alert carries
 * only a title, so this is the one way an email-sourced ad gets a lede for
 * the matcher's description window. Fill-if-null, like the facts merge — a
 * description already on the row (e.g. from an API source with the same
 * dedupe key) is not overwritten.
 *
 * Re-runs (ADR-003 §8.17 "Description backfill"): before doing anything this
 * reads the ad's description and its existing enrichment row and asks
 * `planEnrichment`. An ad never enriched gets the full run above. An ad
 * whose enrichment predates migration 0018 (row exists, description null)
 * gets a description-only fetch — no Haiku call, no `ad_enrichments` or
 * provenance write: its facts were already extracted from that same text,
 * and paying the LLM again per ad would buy nothing. Anything else is a
 * no-op, so calling this for a re-sighted ad is safe.
 */
import { and, eq, isNull } from 'drizzle-orm';
import { adEnrichments, ads } from '@job-digest/db';
import { mergeEnrichedFacts } from '@job-digest/core';
import { withTenant, type Db } from '../tenant';
import { detectTier1 } from './detect-tier';
import { fetchGreenhouseJob } from './greenhouse-single';
import { fetchLeverPosting } from './lever-single';
import { extractFactsFromText } from './extract-from-text';
import { planEnrichment } from '../description-fill';
import type { Facts } from '@job-digest/core';
import type { Tier1Match } from './types';

/** One request to the posting's own API: structured facts + description text. */
export function fetchTier1(match: Tier1Match): Promise<{ facts: Partial<Facts>; descriptionText: string | null }> {
  return match.platform === 'greenhouse'
    ? fetchGreenhouseJob(match.slug, match.jobId)
    : fetchLeverPosting(match.slug, match.postingId);
}

export async function enrichAd(
  db: Db,
  userId: string,
  adId: string,
  externalUrl: string,
  opts: { retryFailed?: boolean } = {},
): Promise<void> {
  const match = detectTier1(externalUrl);
  if (!match) return;

  const state = await withTenant(db, userId, async (tx) => {
    const rows = await tx
      .select({ description: ads.description, enrichmentStatus: adEnrichments.status })
      .from(ads)
      .leftJoin(adEnrichments, and(eq(adEnrichments.adId, ads.id), eq(adEnrichments.userId, ads.userId)))
      .where(eq(ads.id, adId))
      .limit(1);
    return rows[0];
  });
  if (!state) return;
  const plan = planEnrichment(
    { enrichmentStatus: state.enrichmentStatus, hasDescription: state.description !== null },
    opts,
  );
  if (plan === 'skip') return;
  if (plan === 'description_only') {
    try {
      const { descriptionText } = await fetchTier1(match);
      if (!descriptionText) return;
      await withTenant(db, userId, (tx) =>
        tx
          .update(ads)
          .set({ description: descriptionText })
          .where(and(eq(ads.id, adId), isNull(ads.description))),
      );
    } catch (err) {
      // Description-only is best-effort: the ad keeps its earlier
      // enrichment outcome and provenance untouched.
      console.error(`enrich-ad: description fetch failed for ad ${adId} (${externalUrl}):`, err);
    }
    return;
  }

  let extractedFacts: Partial<Facts> | null = null;
  let rawExcerpt: string | null = null;
  let descriptionText: string | null = null;
  let status: 'fetched' | 'fetch_failed' = 'fetch_failed';

  try {
    ({ facts: extractedFacts, descriptionText } = await fetchTier1(match));
    status = 'fetched';

    // Tier 1.5: LLM extraction from description text fills fields the structured
    // API doesn't expose (shift, German, onsite, contract).
    if (descriptionText) {
      rawExcerpt = descriptionText.slice(0, 500);
      const llmFacts = await extractFactsFromText(descriptionText);
      // LLM facts fill nulls in structured facts only — structured data wins.
      extractedFacts = { ...llmFacts, ...extractedFacts };
    }
  } catch (err) {
    console.error(`enrich-ad: fetch failed for ad ${adId} (${externalUrl}):`, err);
  }

  await withTenant(db, userId, async (tx) => {
    // Upsert the enrichment record (one per ad — idempotent re-runs update in place).
    await tx
      .insert(adEnrichments)
      .values({
        userId,
        adId,
        sourceUrl: externalUrl,
        tier: 'api',
        status,
        extractedFacts: extractedFacts ?? null,
        rawExcerpt,
        checkedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: [adEnrichments.userId, adEnrichments.adId],
        set: {
          status,
          extractedFacts: extractedFacts ?? null,
          rawExcerpt,
          checkedAt: new Date(),
        },
      });

    if (status === 'fetched' && descriptionText) {
      await tx
        .update(ads)
        .set({ description: descriptionText })
        .where(and(eq(ads.id, adId), isNull(ads.description)));
    }

    if (!extractedFacts || status !== 'fetched') {
      // Fetch failed — mark provenance so the UI can show "couldn't check"
      // rather than the generic "not in email" state.
      const [ad] = await tx.select({ fieldProvenance: ads.fieldProvenance }).from(ads).where(eq(ads.id, adId));
      if (!ad) return;
      const prov = ad.fieldProvenance ?? {};
      // Only stamp fetch_failed on keys not already resolved.
      for (const key of ['Shift', 'German', 'Onsite', 'Pay', 'Contract'] as const) {
        if (!prov[key]) prov[key] = 'fetch_failed';
      }
      await tx.update(ads).set({ fieldProvenance: prov }).where(eq(ads.id, adId));
      return;
    }

    // Merge extracted facts into the ad, filling nulls only.
    const [ad] = await tx
      .select({ facts: ads.facts, fieldProvenance: ads.fieldProvenance })
      .from(ads)
      .where(eq(ads.id, adId));
    if (!ad) return;

    const { facts: mergedFacts, provenance } = mergeEnrichedFacts(
      ad.facts,
      extractedFacts,
      ad.fieldProvenance ?? {},
    );

    await tx
      .update(ads)
      .set({ facts: mergedFacts, fieldProvenance: provenance })
      .where(eq(ads.id, adId));
  });
}
