/**
 * Curated company catalog. Two uses:
 *
 * 1. Onboarding: seeds `onboarding_cache` with recent ads from these
 *    companies so a brand-new user sees real jobs on step 2 (no empty state).
 * 2. Post-onboarding "browse curated" panel on the Profile page — the user
 *    toggles which ones they actually want in their watchlist. This replaces
 *    "paste a board URL" as the primary path (that stays as an escape hatch).
 *
 * Every entry here has been verified against the provider's live API — the
 * slug resolves to a real board with open positions (or a board that exists
 * and posts intermittently). Verify slugs with the script in
 * scripts/verify-curated.ts before adding new entries.
 *
 * `city`, `tags`, and `curatorNote` are enrichment for the picker UI: they let
 * the user filter by geography/industry and see a short defensible reason
 * why this company is in the catalog. Optional so old entries can be added
 * without a full pass — but new entries should include them.
 */

export type Market = 'ES' | 'DACH' | 'AR';

export interface CuratedCompany {
  name: string;
  /** Must match the source_provider DB enum. */
  provider: 'Greenhouse' | 'Lever' | 'Ashby' | 'Personio';
  slug: string;
  markets: Market[];
  /** Primary hiring city — used for filtering and the card subtitle. */
  city?: string;
  /** Free-form tags: industry, stage, work model. Rendered as chips. */
  tags?: string[];
  /** One short sentence: why is this company in the catalog? Shown as help text. */
  curatorNote?: string;
}

export const CURATED_COMPANIES: CuratedCompany[] = [
  // ── España ──────────────────────────────────────────────────────────────────
  {
    name: 'Typeform', provider: 'Greenhouse', slug: 'typeform', markets: ['ES'],
    city: 'Barcelona', tags: ['SaaS', 'Forms'],
    curatorNote: 'Barcelona-founded SaaS, remote-friendly hiring across Europe.',
  },
  {
    name: 'Cabify', provider: 'Greenhouse', slug: 'cabify', markets: ['ES'],
    city: 'Madrid', tags: ['Mobility', 'Marketplace'],
    curatorNote: 'Madrid-HQ ride-hailing; steady engineering hiring in Spain and LATAM.',
  },
  {
    name: 'Ebury', provider: 'Greenhouse', slug: 'ebury', markets: ['ES'],
    city: 'Madrid', tags: ['Fintech', 'FX'],
    curatorNote: 'Cross-border fintech acquired by Santander; large Madrid tech team.',
  },
  {
    name: 'Skyscanner', provider: 'Greenhouse', slug: 'skyscanner', markets: ['ES'],
    city: 'Barcelona', tags: ['Travel', 'Marketplace'],
    curatorNote: 'Global travel marketplace with a large Barcelona engineering office.',
  },
  {
    name: 'Clarity AI', provider: 'Greenhouse', slug: 'clarityai', markets: ['ES'],
    city: 'Madrid', tags: ['ClimateTech', 'SaaS'],
    curatorNote: 'Sustainability data platform, remote-first with Madrid HQ.',
  },
  {
    name: 'Jobandtalent', provider: 'Lever', slug: 'jobandtalent', markets: ['ES'],
    city: 'Madrid', tags: ['HR Tech', 'Staffing'],
    curatorNote: 'Digital staffing unicorn, Madrid HQ, Series E.',
  },
  {
    name: 'Amenitiz', provider: 'Ashby', slug: 'amenitiz', markets: ['ES'],
    city: 'Barcelona', tags: ['SaaS', 'HospitalityTech'],
    curatorNote: 'PMS for independent hotels, Barcelona-based, Series B.',
  },
  {
    name: 'Voicemod', provider: 'Ashby', slug: 'voicemod', markets: ['ES'],
    city: 'Valencia', tags: ['Consumer', 'Audio'],
    curatorNote: 'Voice-changing software for streamers, Valencia HQ.',
  },
  {
    name: 'Idealista', provider: 'Personio', slug: 'idealista', markets: ['ES'],
    city: 'Madrid', tags: ['Marketplace', 'Real Estate'],
    curatorNote: 'Leading real-estate marketplace in Spain; steady tech hiring.',
  },

  // ── DACH ────────────────────────────────────────────────────────────────────
  {
    name: 'SumUp', provider: 'Greenhouse', slug: 'sumup', markets: ['DACH'],
    city: 'Berlin', tags: ['Fintech', 'Payments'],
    curatorNote: 'Berlin-based payments unicorn; hundreds of open roles worldwide.',
  },
  {
    name: 'HelloFresh', provider: 'Greenhouse', slug: 'hellofresh', markets: ['DACH'],
    city: 'Berlin', tags: ['D2C', 'FoodTech'],
    curatorNote: 'Berlin-HQ meal-kit market leader, listed on the DAX.',
  },
  {
    name: 'Celonis', provider: 'Greenhouse', slug: 'celonis', markets: ['DACH'],
    city: 'Munich', tags: ['SaaS', 'Process Mining'],
    curatorNote: 'Munich-founded process-mining leader, one of Germany\'s biggest B2B SaaS.',
  },
  {
    name: 'N26', provider: 'Greenhouse', slug: 'n26', markets: ['DACH'],
    city: 'Berlin', tags: ['Fintech', 'Neobank'],
    curatorNote: 'Berlin-HQ challenger bank operating across Europe.',
  },
  {
    name: 'FlixMobility', provider: 'Greenhouse', slug: 'flix', markets: ['DACH'],
    city: 'Munich', tags: ['Mobility', 'Travel'],
    curatorNote: 'FlixBus + FlixTrain parent; Munich HQ with strong tech footprint.',
  },
  {
    name: 'GetYourGuide', provider: 'Greenhouse', slug: 'getyourguide', markets: ['DACH'],
    city: 'Berlin', tags: ['Travel', 'Marketplace'],
    curatorNote: 'Travel experiences marketplace, Berlin HQ, growing post-pandemic.',
  },
  {
    name: 'Grover', provider: 'Greenhouse', slug: 'grover', markets: ['DACH'],
    city: 'Berlin', tags: ['Consumer', 'Rental'],
    curatorNote: 'Berlin-based tech-rental service (phones, laptops, etc.).',
  },
  {
    name: 'Contentful', provider: 'Greenhouse', slug: 'contentful', markets: ['DACH'],
    city: 'Berlin', tags: ['SaaS', 'DevTools', 'CMS'],
    curatorNote: 'Headless CMS category leader, Berlin HQ, remote-friendly.',
  },
  {
    name: 'Forto', provider: 'Ashby', slug: 'forto', markets: ['DACH'],
    city: 'Berlin', tags: ['LogisticsTech', 'SaaS'],
    curatorNote: 'Digital freight forwarder, Berlin HQ, hiring across engineering.',
  },
  {
    name: 'Personio', provider: 'Personio', slug: 'personio', markets: ['DACH'],
    city: 'Munich', tags: ['SaaS', 'HR Tech'],
    curatorNote: 'Munich-founded HR platform for SMBs; one of DACH\'s largest SaaS employers.',
  },

  // ── Argentina ───────────────────────────────────────────────────────────────
  // Mix of AR-founded companies and global firms that hire AR engineers at scale.
  {
    name: 'dLocal', provider: 'Lever', slug: 'dlocal', markets: ['AR'],
    city: 'Remote LATAM', tags: ['Fintech', 'Payments'],
    curatorNote: 'Cross-border payments for emerging markets; hires heavily across LATAM.',
  },
  {
    name: 'Despegar', provider: 'Lever', slug: 'despegar', markets: ['AR'],
    city: 'Buenos Aires', tags: ['Travel', 'Marketplace'],
    curatorNote: 'LATAM\'s largest online travel agency, Buenos Aires HQ.',
  },
  {
    name: 'Jampp', provider: 'Greenhouse', slug: 'jampp', markets: ['AR'],
    city: 'Buenos Aires', tags: ['AdTech', 'Mobile'],
    curatorNote: 'Programmatic mobile ad-tech, Buenos Aires-founded, acquired by Affle.',
  },
  {
    name: 'Cloudbeds', provider: 'Greenhouse', slug: 'cloudbeds', markets: ['AR'],
    city: 'Remote', tags: ['SaaS', 'HospitalityTech'],
    curatorNote: 'Fully-remote hospitality SaaS with a strong LATAM engineering base.',
  },
  {
    name: 'Okta', provider: 'Greenhouse', slug: 'okta', markets: ['AR'],
    city: 'Remote LATAM', tags: ['SaaS', 'Security'],
    curatorNote: 'US public identity-management company; hires remote across LATAM.',
  },
  {
    name: 'Stripe', provider: 'Greenhouse', slug: 'stripe', markets: ['AR'],
    city: 'Remote', tags: ['Fintech', 'Payments'],
    curatorNote: 'US payments infra; Remote-in-LATAM engineering hires when open.',
  },
  {
    name: 'Brex', provider: 'Greenhouse', slug: 'brex', markets: ['AR'],
    city: 'Remote LATAM', tags: ['Fintech', 'Corporate Cards'],
    curatorNote: 'Corporate spend platform, remote hiring across LATAM incl. Argentina.',
  },
  {
    name: 'BioCatch', provider: 'Lever', slug: 'biocatch', markets: ['AR'],
    city: 'Buenos Aires', tags: ['Security', 'FraudTech'],
    curatorNote: 'Behavioral biometrics for fraud detection; has a Buenos Aires R&D center.',
  },
];
