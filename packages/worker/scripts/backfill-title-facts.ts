// One-off: compute `ads.title_facts` for ads that predate migration 0009
// (design note, "chips = hechos, no veredictos", 3 Aug 2026). Needs no raw
// email and no re-fetch — the computation reads only `title` and
// `location_raw`, both already stored — so this is a pure backfill, not a
// re-parse (I2 doesn't apply; there is nothing to re-extract from the body).
//
// Idempotent: only touches rows where `title_facts IS NULL`, so re-running it
// (e.g. after a fresh ingest inserted more null rows some other way) picks up
// exactly the gap and nothing already computed.
//
// Per-user, wrapped in withTenant like every other write to `ads` — a script
// is not an exemption from RLS just because it runs outside a request.
import { eq, isNull, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
// Reached directly by relative path with an explicit extension, not through
// a package barrel — matching packages/db/scripts/migrate-dev.ts, the one
// script already documented as run via plain `node --experimental-strip-types`.
// Every `@job-digest/*` barrel in this repo (core/db/ingest/worker `index.ts`)
// re-exports via extensionless relative paths, which Node's native ESM
// resolver cannot follow without a bundler (webpack/vitest/esbuild all
// paper over this; raw node does not) — seed-dev.ts has the same latent gap.
// This works because every workspace reference these three files make is
// `import type`, erased entirely by type-stripping before resolution matters.
import { ads } from '../../db/src/schema.ts';
import { extractTitleFacts } from '../../ingest/src/normalize/title-facts.ts';
import { withTenant } from '../src/tenant.ts';

const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL is not set');

const client = postgres(url, { max: 1 });
const db = drizzle(client);

async function main() {
  const userRows = await db
    .selectDistinct({ userId: ads.userId })
    .from(ads)
    .where(isNull(ads.titleFacts));
  console.log(`${userRows.length} account(s) have ads with no title_facts yet`);

  let updated = 0;
  for (const { userId } of userRows) {
    await withTenant(db, userId, async (tx) => {
      const rows = await tx
        .select({ id: ads.id, title: ads.title, locationRaw: ads.locationRaw })
        .from(ads)
        .where(sql`${ads.userId} = ${userId} AND ${ads.titleFacts} IS NULL`);
      for (const row of rows) {
        await tx
          .update(ads)
          .set({ titleFacts: extractTitleFacts(row.title, row.locationRaw) })
          .where(eq(ads.id, row.id));
        updated++;
      }
      console.log(`  ${userId}: ${rows.length} ads backfilled`);
    });
  }
  console.log(`done — ${updated} ads updated`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await client.end();
  });
