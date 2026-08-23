/**
 * Curated company list for the onboarding preview (Camino A).
 *
 * Every entry here has been verified against the provider's live API — the
 * slug resolves to a real board with open positions (or a board that exists
 * and posts intermittently). Verify slugs with the script in
 * scripts/verify-curated.ts before adding new entries.
 *
 * When enough users have run auto-discovery (Camino B), this list can be
 * replaced by the corpus of discovered company→slug mappings.
 */

export type Market = 'ES' | 'DACH' | 'AR';

export interface CuratedCompany {
  name: string;
  /** Must match the source_provider DB enum. */
  provider: 'Greenhouse' | 'Lever' | 'Ashby' | 'Personio';
  slug: string;
  markets: Market[];
}

export const CURATED_COMPANIES: CuratedCompany[] = [
  // ── España ──────────────────────────────────────────────────────────────────
  { name: 'Typeform',    provider: 'Greenhouse', slug: 'typeform',   markets: ['ES'] },
  { name: 'Cabify',      provider: 'Greenhouse', slug: 'cabify',     markets: ['ES'] },
  { name: 'Ebury',       provider: 'Greenhouse', slug: 'ebury',      markets: ['ES'] },
  { name: 'Skyscanner',  provider: 'Greenhouse', slug: 'skyscanner', markets: ['ES'] },
  { name: 'Clarity AI',  provider: 'Greenhouse', slug: 'clarityai',  markets: ['ES'] },
  { name: 'Jobandtalent',provider: 'Lever',      slug: 'jobandtalent', markets: ['ES'] },
  { name: 'Amenitiz',    provider: 'Ashby',      slug: 'amenitiz',   markets: ['ES'] },
  { name: 'Voicemod',    provider: 'Ashby',      slug: 'voicemod',   markets: ['ES'] },
  { name: 'Idealista',   provider: 'Personio',   slug: 'idealista',  markets: ['ES'] },
  // ── DACH ────────────────────────────────────────────────────────────────────
  { name: 'SumUp',         provider: 'Greenhouse', slug: 'sumup',        markets: ['DACH'] },
  { name: 'HelloFresh',    provider: 'Greenhouse', slug: 'hellofresh',   markets: ['DACH'] },
  { name: 'Celonis',       provider: 'Greenhouse', slug: 'celonis',      markets: ['DACH'] },
  { name: 'N26',           provider: 'Greenhouse', slug: 'n26',          markets: ['DACH'] },
  { name: 'FlixMobility',  provider: 'Greenhouse', slug: 'flix',         markets: ['DACH'] },
  { name: 'GetYourGuide',  provider: 'Greenhouse', slug: 'getyourguide', markets: ['DACH'] },
  { name: 'Grover',        provider: 'Greenhouse', slug: 'grover',       markets: ['DACH'] },
  { name: 'Contentful',    provider: 'Greenhouse', slug: 'contentful',   markets: ['DACH'] },
  { name: 'Forto',         provider: 'Ashby',      slug: 'forto',        markets: ['DACH'] },
  { name: 'Personio',      provider: 'Personio',   slug: 'personio',     markets: ['DACH'] },
  // ── Argentina ───────────────────────────────────────────────────────────────
  // Mix of AR-founded companies and global firms that hire AR engineers at scale.
  { name: 'dLocal',    provider: 'Lever',      slug: 'dlocal',    markets: ['AR'] },
  { name: 'Despegar',  provider: 'Lever',      slug: 'despegar',  markets: ['AR'] },
  { name: 'Jampp',     provider: 'Greenhouse', slug: 'jampp',     markets: ['AR'] },
  { name: 'Cloudbeds', provider: 'Greenhouse', slug: 'cloudbeds', markets: ['AR'] },
  { name: 'Okta',      provider: 'Greenhouse', slug: 'okta',      markets: ['AR'] },
  { name: 'Stripe',    provider: 'Greenhouse', slug: 'stripe',    markets: ['AR'] },
  { name: 'Brex',      provider: 'Greenhouse', slug: 'brex',      markets: ['AR'] },
  { name: 'BioCatch',  provider: 'Lever',      slug: 'biocatch',  markets: ['AR'] },
];
