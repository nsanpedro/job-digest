/**
 * Post-ingest enrichment for email-sourced ads (ADR-003 Tier 1).
 *
 * Called outside the ingest transaction — network I/O cannot run inside
 * a Postgres transaction. Writes one `ad_enrichments` row and patches
 * `ads.facts` + `ads.field_provenance` in a separate withTenant call.
 *
 * Idempotent: the unique index on (user_id, ad_id) in ad_enrichments makes
 * a re-run upsert the row; the facts patch is a merge (fills nulls only).
 */
import { eq } from 'drizzle-orm';
import { adEnrichments, ads } from '@job-digest/db';
import { mergeEnrichedFacts } from '@job-digest/core';
import { withTenant, type Db } from '../tenant';
import { detectTier1 } from './detect-tier';
import { fetchGreenhouseJob } from './greenhouse-single';
import { fetchLeverPosting } from './lever-single';
import { extractFactsFromText } from './extract-from-text';
import type { Facts } from '@job-digest/core';

export async function enrichAd(
  db: Db,
  userId: string,
  adId: string,
  externalUrl: string,
): Promise<void> {
  const match = detectTier1(externalUrl);
  if (!match) return;

  let extractedFacts: Partial<Facts> | null = null;
  let rawExcerpt: string | null = null;
  let status: 'fetched' | 'fetch_failed' = 'fetch_failed';

  try {
    let descriptionText: string | null = null;
    if (match.platform === 'greenhouse') {
      ({ facts: extractedFacts, descriptionText } = await fetchGreenhouseJob(match.slug, match.jobId));
    } else {
      ({ facts: extractedFacts, descriptionText } = await fetchLeverPosting(match.slug, match.postingId));
    }
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
