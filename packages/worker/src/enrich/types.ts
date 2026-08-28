/**
 * Enrichment types (ADR-003). Tier 1 only in this implementation:
 * Greenhouse and Lever single-job API endpoints.
 */
import type { Facts } from '@job-digest/core';

export type EnrichmentTier = 'api' | 'html';

/** Parsed from an ad's externalUrl to determine which API to call. */
export type Tier1Match =
  | { platform: 'greenhouse'; slug: string; jobId: string }
  | { platform: 'lever'; slug: string; postingId: string };

/** What a single-job API call returns (partial — API rarely has all five facts). */
export interface EnrichResult {
  facts: Partial<Facts>;
  tier: EnrichmentTier;
}
