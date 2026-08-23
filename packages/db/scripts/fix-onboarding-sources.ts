/**
 * One-time cleanup: remove bad curated sources seeded by the old onboarding
 * (slugs that were guesses and returned 404 from their provider).
 *
 * Run with:
 *   DATABASE_URL=... node --experimental-strip-types packages/db/scripts/fix-onboarding-sources.ts
 */
import postgres from 'postgres';

const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL is not set');

const sql = postgres(url, { max: 1 });

// Slugs that were in the old CURATED_COMPANIES list but are invalid.
const BAD_SLUGS = [
  'glovoapp', 'factorial', 'travelperk', 'wallbox', 'adevinta', 'spotahome', // ES
  'deliveryhero', 'zalando', 'omio', 'flixmobility', 'aboutyou',             // DACH
  'mercadolibre', 'globant', 'uala', 'dlocal', 'despegar', 'nuvei',
  'auth0', 'olx',                                                            // AR (old slugs — some fixed to new provider)
];

// Also remove sources where last_error contains '404' or 'not found'
const statusCheck = await sql`
  SELECT external_slug as slug, provider, status, left(last_error::text, 100) as err
  FROM sources
  WHERE external_slug = ANY(${BAD_SLUGS})
  ORDER BY added_at DESC
`;

console.log(`\nSources to clean (${statusCheck.length}):`);
statusCheck.forEach(r =>
  console.log(`  [${r.status}] ${r.provider}/${r.slug}  ${r.err ?? ''}`.slice(0, 100))
);

if (statusCheck.length === 0) {
  console.log('Nothing to clean.');
  await sql.end();
  process.exit(0);
}

const del = await sql`
  DELETE FROM sources
  WHERE external_slug = ANY(${BAD_SLUGS})
  RETURNING external_slug as slug, provider
`;

console.log(`\nDeleted ${del.length} source(s):`);
del.forEach(r => console.log(`  - ${r.provider}/${r.slug}`));

await sql.end();
