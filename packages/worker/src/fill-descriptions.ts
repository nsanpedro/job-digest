/**
 * DB side of the description fill (ADR-003 §8.15 "Description backfill"):
 * find a user's ads that still have `description IS NULL` among the postings
 * a fetch just returned, and write the fetched text into them. The matching
 * rules are pure and live in description-fill.ts; this file only reads and
 * writes. Used by fetch-apis.ts on every API fetch and by
 * scripts/backfill-descriptions.ts.
 *
 * Both queries run inside the caller's `withTenant` transaction (RLS applies).
 * The write is guarded by `description IS NULL` in SQL, so it can never
 * clobber a description written in between, and a re-run is a no-op.
 */
import { and, eq, inArray, isNull, or, sql, type SQL } from 'drizzle-orm';
import { ads } from '@job-digest/db';
import {
  matchDescriptionFills,
  type AdMissingDescription,
  type DescriptionFill,
  type DescriptionSource,
} from './description-fill';
import type { Tx } from './tenant';

/**
 * Keys per lookup / rows per UPDATE. Descriptions are capped at 4 000 chars,
 * so a 200-row UPDATE carries at most ~800 KB of parameters, and 2 × 1 000
 * lookup keys stay far under Postgres' 65 535 bind-parameter limit.
 */
const LOOKUP_CHUNK = 1000;
const WRITE_CHUNK = 200;

function chunks<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/**
 * The user's ads with a null description that one of `sources` could fill —
 * matched on externalId or dedupe key, like ingestJob. Only ids and keys go
 * to the database here, not the description text, so once a board has
 * converged this costs one small SELECT per source per fetch.
 */
export async function findAdsMissingDescription(
  tx: Tx,
  userId: string,
  sources: readonly DescriptionSource[],
): Promise<AdMissingDescription[]> {
  const out: AdMissingDescription[] = [];
  for (const chunk of chunks(sources, LOOKUP_CHUNK)) {
    const rows = await tx
      .select({ id: ads.id, externalId: ads.externalId, dedupeKey: ads.dedupeKey })
      .from(ads)
      .where(
        and(
          eq(ads.userId, userId),
          isNull(ads.description),
          or(
            inArray(ads.externalId, chunk.map((s) => s.externalId)),
            inArray(ads.dedupeKey, chunk.map((s) => s.dedupeKey)),
          ),
        ),
      );
    out.push(...rows);
  }
  return out;
}

/** Write fills; returns how many rows actually changed (still-null ones). */
export async function writeDescriptionFills(
  tx: Tx,
  userId: string,
  fills: readonly DescriptionFill[],
): Promise<number> {
  let changed = 0;
  for (const chunk of chunks(fills, WRITE_CHUNK)) {
    const values: SQL = sql.join(
      chunk.map((f) => sql`(${f.adId}::uuid, ${f.description}::text)`),
      sql`, `,
    );
    const res = await tx.execute(sql`
      UPDATE ${ads} SET description = v.description
      FROM (VALUES ${values}) AS v(id, description)
      WHERE ${ads.id} = v.id
        AND ${ads.userId} = ${userId}
        AND ${ads.description} IS NULL`);
    changed += res.count ?? 0;
  }
  return changed;
}

/** Find + match + write, for one batch of fetched postings. */
export async function fillMissingDescriptions(
  tx: Tx,
  userId: string,
  sources: readonly DescriptionSource[],
): Promise<number> {
  if (sources.length === 0) return 0;
  const missing = await findAdsMissingDescription(tx, userId, sources);
  const fills = matchDescriptionFills(missing, sources);
  if (fills.length === 0) return 0;
  return writeDescriptionFills(tx, userId, fills);
}
