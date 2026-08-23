/**
 * Provider interface for keyless job-board APIs (ADR-002). Same role as
 * `Extractor` in `@job-digest/ingest/extract/types` — one implementation per
 * platform, one shared output type — but without the email-specific machinery:
 * API responses are already structured, so there are no FieldSpans or layout
 * hashes, and the I5 quote mechanism (offset into source HTML) becomes "the raw
 * API string" since the API is the source.
 */
import type { Facts, Wording } from '@job-digest/core';
import type { Platform } from '@job-digest/ingest';

/**
 * One job as returned by the provider, ready to hand to `upsertAd`. Mirrors
 * the columns the ingest pipeline writes to `ads`, minus the email-path fields
 * (`mailboxId`, `rawEmailId`, `parserVersion`).
 *
 * `facts` and `wording` are partial: an API rarely carries all five rule
 * signals. Null means "not available from this source" (I4), never a default.
 */
export interface NormalizedJob {
  externalId: string;
  externalUrl: string;
  title: string;
  company: string;
  locationRaw: string | null;
  /** Maps to `ads.source` — the platform enum value for this provider. */
  platform: Platform;
  facts: Facts;
  wording: Partial<Wording>;
  postedAt: Date | null;
}

export interface JobBoardProvider {
  readonly name: 'Greenhouse' | 'Lever' | 'Ashby' | 'Personio';

  /**
   * Parse the company slug from a URL the user pasted (I20 — validation on
   * add, not at fetch time). Returns null when the URL does not match this
   * provider's shape, so the caller can try the next one.
   */
  parseSlugFromUrl(url: string): string | null;

  /**
   * Confirm the slug resolves to a real company and return the display name.
   * Throws when the company is not found — this is the add-time gate (I20)
   * that keeps the sources list free of stale or mistyped slugs.
   */
  validateSlug(slug: string): Promise<string>;

  /**
   * Fetch all open positions for the given slug. Returns [] for a company with
   * no open roles (valid, honest); throws on network/API failures so the caller
   * can record the error on the source row.
   */
  fetchJobs(slug: string): Promise<NormalizedJob[]>;
}
