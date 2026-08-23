/**
 * Curated company list for the onboarding preview (Camino A).
 *
 * Slugs are best-effort guesses — the cache refresh validates each one via
 * provider.validateSlug() and skips silently on 404. Fix a wrong slug here;
 * don't paper over it in the refresh logic.
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
  { name: 'Typeform', provider: 'Greenhouse', slug: 'typeform', markets: ['ES'] },
  { name: 'Glovo', provider: 'Greenhouse', slug: 'glovoapp', markets: ['ES'] },
  { name: 'Factorial', provider: 'Lever', slug: 'factorial', markets: ['ES'] },
  { name: 'Cabify', provider: 'Greenhouse', slug: 'cabify', markets: ['ES'] },
  { name: 'TravelPerk', provider: 'Greenhouse', slug: 'travelperk', markets: ['ES'] },
  { name: 'Wallbox', provider: 'Greenhouse', slug: 'wallbox', markets: ['ES'] },
  { name: 'Adevinta', provider: 'Greenhouse', slug: 'adevinta', markets: ['ES'] },
  { name: 'Jobandtalent', provider: 'Greenhouse', slug: 'jobandtalent', markets: ['ES'] },
  { name: 'Spotahome', provider: 'Greenhouse', slug: 'spotahome', markets: ['ES'] },
  { name: 'Idealista', provider: 'Personio', slug: 'idealista', markets: ['ES'] },
  // ── DACH ────────────────────────────────────────────────────────────────────
  { name: 'N26', provider: 'Greenhouse', slug: 'n26', markets: ['DACH'] },
  { name: 'HelloFresh', provider: 'Greenhouse', slug: 'hellofresh', markets: ['DACH'] },
  { name: 'Delivery Hero', provider: 'Greenhouse', slug: 'deliveryhero', markets: ['DACH'] },
  { name: 'Zalando', provider: 'Greenhouse', slug: 'zalando', markets: ['DACH'] },
  { name: 'Personio', provider: 'Personio', slug: 'personio', markets: ['DACH'] },
  { name: 'Celonis', provider: 'Greenhouse', slug: 'celonis', markets: ['DACH'] },
  { name: 'GetYourGuide', provider: 'Greenhouse', slug: 'getyourguide', markets: ['DACH'] },
  { name: 'About You', provider: 'Personio', slug: 'aboutyou', markets: ['DACH'] },
  { name: 'Omio', provider: 'Greenhouse', slug: 'omio', markets: ['DACH'] },
  { name: 'FlixMobility', provider: 'Greenhouse', slug: 'flixmobility', markets: ['DACH'] },
  // ── Argentina ───────────────────────────────────────────────────────────────
  { name: 'MercadoLibre', provider: 'Greenhouse', slug: 'mercadolibre', markets: ['AR'] },
  { name: 'Globant', provider: 'Greenhouse', slug: 'globant', markets: ['AR'] },
  { name: 'Ualá', provider: 'Greenhouse', slug: 'uala', markets: ['AR'] },
  { name: 'dLocal', provider: 'Greenhouse', slug: 'dlocal', markets: ['AR'] },
  { name: 'Despegar', provider: 'Greenhouse', slug: 'despegar', markets: ['AR'] },
  { name: 'Nuvei', provider: 'Greenhouse', slug: 'nuvei', markets: ['AR'] },
  { name: 'Auth0', provider: 'Greenhouse', slug: 'auth0', markets: ['AR'] },
  { name: 'OLX', provider: 'Greenhouse', slug: 'olx', markets: ['AR'] },
];
