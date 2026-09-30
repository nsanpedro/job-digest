/**
 * Pure decisions behind filling `ads.description` for ads that already exist
 * (ADR-003 §8.10 "Descriptions in matching", and the §8.x "Description
 * backfill" follow-up). No DB, no network — the callers
 * (fetch-apis.ts, enrich/enrich-ad.ts, scripts/backfill-descriptions.ts) do
 * the I/O and ask this module what to write.
 *
 * Why this exists: 0018 added the column with no backfill, on the theory that
 * the next API re-fetch would fill it. It did not, for rows already in the
 * table, because fetch-apis.ts ran the ingest direction gate *before* the
 * upsert — a job that no longer clears today's (stricter, description-aware)
 * gate was dropped before the code that writes `description` ever saw it,
 * even when the ad was already in the user's table. And enrichment only ran
 * for newly created email ads. The rules here:
 *
 *   - Never clobber a known description with null (`mergeDescription`).
 *   - An existing ad with a null description gets the posting's description
 *     whenever a fetch carries one, gate or no gate (`matchDescriptionFills`)
 *     — the gate decides admission of *new* ads, not whether a row we
 *     already hold may learn its own text.
 *   - Enrichment re-runs for description only (no LLM call) when its
 *     earlier run predates the column (`planEnrichment`).
 */
import { dedupeKeyFromStrings } from '@job-digest/ingest';
import { detectTier1 } from './enrich/detect-tier';
import type { Tier1Match } from './enrich/types';
import type { NormalizedJob } from './providers/types';

/**
 * The upsert rule for an existing API ad: the provider's current description
 * wins (companies edit ads after posting); a fetch without one keeps what we
 * had — never erase to null.
 */
export function mergeDescription(prior: string | null, incoming: string | null): string | null {
  return incoming ?? prior;
}

/** A fetched job reduced to what the description fill matches on. */
export interface DescriptionSource {
  externalId: string;
  dedupeKey: string;
  description: string;
}

/**
 * Fetched jobs that carry a description, keyed the way `ingestJob` matches
 * an existing ad: `externalId` (stable across title edits) or the content
 * dedupe key. Jobs without a description are dropped — they have nothing to
 * fill with.
 */
export function descriptionSources(
  jobs: ReadonlyArray<Pick<NormalizedJob, 'externalId' | 'title' | 'company' | 'locationRaw' | 'description'>>,
): DescriptionSource[] {
  const out: DescriptionSource[] = [];
  for (const job of jobs) {
    if (!job.description) continue;
    out.push({
      externalId: job.externalId,
      dedupeKey: dedupeKeyFromStrings(job.title, job.company, job.locationRaw),
      description: job.description,
    });
  }
  return out;
}

/** An existing ad row whose description is null. */
export interface AdMissingDescription {
  id: string;
  externalId: string | null;
  dedupeKey: string;
}

export interface DescriptionFill {
  adId: string;
  description: string;
}

/**
 * Pair ads that lack a description with fetched jobs that have one. Match
 * order is the same as ingestJob's: externalId first, then dedupe key. Each
 * ad is filled at most once; one job may fill more than one ad (an old row
 * matched by externalId and another by dedupe key), which is harmless — it
 * is the same posting's text.
 */
export function matchDescriptionFills(
  missing: readonly AdMissingDescription[],
  sources: readonly DescriptionSource[],
): DescriptionFill[] {
  if (missing.length === 0 || sources.length === 0) return [];
  const byExternalId = new Map<string, string>();
  const byDedupeKey = new Map<string, string>();
  for (const s of sources) {
    if (!byExternalId.has(s.externalId)) byExternalId.set(s.externalId, s.description);
    if (!byDedupeKey.has(s.dedupeKey)) byDedupeKey.set(s.dedupeKey, s.description);
  }
  const fills: DescriptionFill[] = [];
  const seen = new Set<string>();
  for (const ad of missing) {
    if (seen.has(ad.id)) continue;
    const description =
      (ad.externalId !== null ? byExternalId.get(ad.externalId) : undefined) ?? byDedupeKey.get(ad.dedupeKey);
    if (description === undefined) continue;
    seen.add(ad.id);
    fills.push({ adId: ad.id, description });
  }
  return fills;
}

// ── Enrichment (email ads linking to Greenhouse / Lever) ─────────────────────

/**
 * What `enrichAd` should do for one ad:
 *   - `full`: fetch + LLM fact extraction (Tier 1.5) + description — the
 *     original behaviour, for an ad never enriched.
 *   - `description_only`: fetch the posting and fill `ads.description` if
 *     null. No LLM call, no `ad_enrichments` write, no provenance change —
 *     the facts were already extracted (from the same text) before 0018
 *     existed, so paying Haiku again would buy nothing.
 *   - `skip`: nothing to learn.
 */
export type EnrichmentPlan = 'full' | 'description_only' | 'skip';

export interface EnrichmentState {
  /** Status of the existing ad_enrichments row, or null when there is none. */
  enrichmentStatus: 'fetched' | 'fetch_failed' | 'login_required' | 'tier_skip' | null;
  hasDescription: boolean;
}

export function planEnrichment(
  state: EnrichmentState,
  opts: { retryFailed?: boolean } = {},
): EnrichmentPlan {
  if (state.enrichmentStatus === null) return 'full';
  if (state.hasDescription) return 'skip';
  if (state.enrichmentStatus === 'fetched') return 'description_only';
  // A failed fetch usually means the posting closed; the regular path does
  // not retry it on every sighting. The one-off backfill may (cheaply —
  // description only, one request).
  if (state.enrichmentStatus === 'fetch_failed' && opts.retryFailed) return 'description_only';
  return 'skip';
}

/**
 * Whether a re-sighted email ad (ingest-email.ts, merge branch) should be
 * handed to enrichAd: only when it still lacks a description and links to a
 * posting we can fetch. `enrichAd` then applies `planEnrichment`.
 */
export function shouldEnrichExisting(prior: { description: string | null; externalUrl: string | null }): boolean {
  return prior.description === null && prior.externalUrl !== null && detectTier1(prior.externalUrl) !== null;
}

// ── Backfill planning (scripts/backfill-descriptions.ts) ─────────────────────

export type BoardProvider = 'Greenhouse' | 'Lever' | 'Ashby' | 'Personio';

/** One ad with a null description, joined to its source row when it has one. */
export interface BackfillRow {
  id: string;
  externalId: string | null;
  externalUrl: string | null;
  dedupeKey: string;
  /** `ads.source` — the platform enum (LinkedIn, Xing, Greenhouse, …). */
  platform: string;
  /** `sources.provider` / `external_slug` via `ads.source_id`, when set. */
  sourceProvider: BoardProvider | null;
  sourceSlug: string | null;
}

export interface BoardPlan {
  provider: BoardProvider;
  slug: string;
  ads: AdMissingDescription[];
}

export interface SinglePlan {
  adId: string;
  platform: string;
  match: Tier1Match;
}

export interface BackfillPlan {
  /** Keyed `${provider}:${slug}` — one board fetch covers all its ads. */
  boards: Map<string, BoardPlan>;
  /** Email ads linking to one Greenhouse/Lever posting — one request each. */
  singles: SinglePlan[];
  /** Ads no keyless API can describe (LinkedIn/Xing/… alert links), by platform. */
  unreachable: Map<string, number>;
}

export function boardKey(provider: BoardProvider, slug: string): string {
  return `${provider}:${slug}`;
}

/**
 * Decide how each null-description ad can be filled, cheapest first:
 *
 *   1. It came from an API source → that board's list call (already carries
 *      every open posting's description; one request per board, shared by
 *      every ad and every user on that board).
 *   2. Its URL is a single Greenhouse/Lever posting (enrichment's Tier 1) →
 *      one request for that posting. Covers email ads and API ads whose
 *      source row was deleted (`source_id` set null).
 *   3. Otherwise unreachable — counted, never fetched.
 *
 * Ads already filled are not in the input (the query selects
 * `description IS NULL`), which is what makes a re-run pick up only the gap.
 */
export function planDescriptionBackfill(rows: readonly BackfillRow[]): BackfillPlan {
  const boards = new Map<string, BoardPlan>();
  const singles: SinglePlan[] = [];
  const unreachable = new Map<string, number>();
  for (const row of rows) {
    if (row.sourceProvider && row.sourceSlug) {
      const key = boardKey(row.sourceProvider, row.sourceSlug);
      let plan = boards.get(key);
      if (!plan) {
        plan = { provider: row.sourceProvider, slug: row.sourceSlug, ads: [] };
        boards.set(key, plan);
      }
      plan.ads.push({ id: row.id, externalId: row.externalId, dedupeKey: row.dedupeKey });
      continue;
    }
    const match = row.externalUrl ? detectTier1(row.externalUrl) : null;
    if (match) {
      singles.push({ adId: row.id, platform: row.platform, match });
      continue;
    }
    unreachable.set(row.platform, (unreachable.get(row.platform) ?? 0) + 1);
  }
  return { boards, singles, unreachable };
}
