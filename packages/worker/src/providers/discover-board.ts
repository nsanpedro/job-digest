/**
 * Auto-discovery: given a company name from a job alert email, probe all four
 * supported providers to find a matching public ATS board.
 *
 * No AI involved — pure HTTP probing with deterministic slug normalization.
 * The same validateSlug() used during manual add is reused here, so the
 * discovery contract is identical: a discovered slug is as valid as a manually
 * pasted one (I20).
 *
 * Why no AI: slug generation from a company name is ~80% accurate with simple
 * text normalization (companies use their brand name as the slug). The 20%
 * that fail silently — they have no board, or their slug differs from the
 * brand name — are not worth the token cost per probe. Manual add covers those.
 */
import { ashby } from './ashby';
import { greenhouse } from './greenhouse';
import { lever } from './lever';
import { personio } from './personio';
import type { JobBoardProvider } from './types';

const PROVIDERS: readonly JobBoardProvider[] = [greenhouse, lever, ashby, personio];

/**
 * Legal-entity suffixes to strip before generating slug candidates.
 * Covers the most common DACH + Iberian + English forms.
 * Uses (?=\W|$) instead of \b as the trailing anchor — \b fails after a
 * period (e.g. "S.L.") because "." is \W, so there's no word-boundary
 * transition after it.
 */
const LEGAL_SUFFIX_RE =
  /\b(GmbH & Co\. KG|GmbH|SE & Co\. KG|SE|AG|KG|KGaA|OHG|GbR|UG|eG|S\.L\.|S\.A\.|SRL|Srl|SAS|SARL|SpA|BV|NV|AB|ApS|Oy|A\/S|PLC|LLP|LLC|Inc\.|Ltd\.|Corp\.|Co\.|Inc|Ltd|Corp|SL|SA)(?=\W|$)/gi;

/** Characters that are never valid in an ATS slug. */
const NON_SLUG_RE = /[^a-z0-9\s-]/g;

/**
 * Generate 1-3 slug candidates from a company name. Deterministic, no network.
 *
 * Examples:
 *   "Typeform"                → ["typeform"]
 *   "Rocket Internet GmbH"   → ["rocket-internet", "rocketinternet"]
 *   "N26 Bank"               → ["n26-bank", "n26bank"]
 *   "Personio SE & Co. KG"   → ["personio"]
 */
export function normalizeToSlugs(company: string): string[] {
  const base = company
    .replace(LEGAL_SUFFIX_RE, '')
    .toLowerCase()
    .replace(NON_SLUG_RE, '')
    .replace(/\s+/g, ' ')
    .trim();

  if (base.length < 2) return [];

  const slugs = new Set<string>();
  slugs.add(base.replace(/\s+/g, '-'));
  if (base.includes(' ')) slugs.add(base.replace(/\s+/g, ''));

  return [...slugs].filter((s) => s.length >= 2 && s.length <= 60);
}

export interface DiscoveredBoard {
  providerName: string;
  slug: string;
  displayName: string;
}

/**
 * Probe all providers in parallel for the given company name.
 * Returns the first match, or null if no board is found on any provider.
 *
 * Parallel probing: 4 providers × up to 2 slug candidates = up to 8 requests
 * fired simultaneously. First resolve wins; the rest are abandoned.
 * validateSlug() is cheap (one HEAD/GET per probe, fast 404 on miss).
 */
export async function discoverBoard(companyName: string): Promise<DiscoveredBoard | null> {
  const slugCandidates = normalizeToSlugs(companyName);
  if (slugCandidates.length === 0) return null;

  const attempts = PROVIDERS.flatMap((provider) =>
    slugCandidates.map((slug) => ({ provider, slug })),
  );

  // Race all attempts — first settled fulfillment wins.
  return new Promise((resolve) => {
    let pending = attempts.length;
    let resolved = false;

    for (const { provider, slug } of attempts) {
      provider
        .validateSlug(slug)
        .then((displayName) => {
          if (!resolved) {
            resolved = true;
            resolve({ providerName: provider.name, slug, displayName });
          }
        })
        .catch(() => {
          pending--;
          if (pending === 0 && !resolved) resolve(null);
        });
    }

    if (attempts.length === 0) resolve(null);
  });
}
