/**
 * `getDirectionCoverage` — the count a user sees once a direction is
 * 'alert_configured' (docs/adr-001-role-discovery.md §3's "loop"). Against a
 * real Postgres: the matching itself is a literal, case-insensitive
 * substring check (I18 — a count, never a fuzzy score), worth pinning since
 * a "smarter" future matcher is exactly the kind of change that would drift
 * this back toward the invented percentage the feature was designed to
 * avoid.
 */
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getDirectionCoverage } from '../src/queries/discovery';
import * as schema from '../src/schema';

let container: StartedPostgreSqlContainer;
let client: postgres.Sql;
let db: PostgresJsDatabase<typeof schema>;
let userId: string;

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:17-alpine').start();
  client = postgres(container.getConnectionUri(), { max: 1 });
  db = drizzle(client, { schema });
  await migrate(db, { migrationsFolder: new URL('../migrations', import.meta.url).pathname });

  const [account] = await db.insert(schema.accounts).values({ email: 'coverage@example.com' }).returning();
  if (!account) throw new Error('seed failed');
  userId = account.id;

  const titles = [
    'Qualitätsbeauftragte (m/w/d) Gesundheitswesen',
    'Qualitätsmanager Klinik',
    'Frontend Developer',
    'Hygienefachkraft (m/w/d)',
  ];
  for (const title of titles) {
    await db.insert(schema.ads).values({
      userId,
      dedupeKey: `ad-${title}`,
      title,
      source: 'LinkedIn',
      facts: {
        rotating: null,
        weekend: null,
        german: null,
        home: null,
        pay: null,
        payMax: null,
        payFte: null,
        fteNote: null,
        permanent: null,
        commuteMin: null,
      },
      wording: {} as never,
      firstSeenAt: new Date(),
      lastSeenAt: new Date(),
    });
  }
}, 180_000);

afterAll(async () => {
  await client?.end();
  await container?.stop();
});

describe('getDirectionCoverage', () => {
  it('counts ads whose title contains a search term, case-insensitively', async () => {
    const coverage = await db.transaction(async (tx) =>
      getDirectionCoverage(tx, userId, [
        { id: 'd1', label: 'Qualitätsmanagement', searchTerms: ['qualitätsmanager', 'qualitätsbeauftragte'] },
      ]),
    );
    expect(coverage.get('d1')).toBe(2);
  });

  it('also matches on the direction label alone, not only searchTerms', async () => {
    const coverage = await db.transaction(async (tx) =>
      getDirectionCoverage(tx, userId, [{ id: 'd2', label: 'Hygienefachkraft', searchTerms: ['nothing matches this'] }]),
    );
    expect(coverage.get('d2')).toBe(1);
  });

  it('is zero, not undefined-crashing, when nothing matches', async () => {
    const coverage = await db.transaction(async (tx) =>
      getDirectionCoverage(tx, userId, [{ id: 'd3', label: 'Underwater Basket Weaving', searchTerms: ['no match here'] }]),
    );
    expect(coverage.get('d3')).toBe(0);
  });

  it('computes coverage for multiple directions in one pass', async () => {
    const coverage = await db.transaction(async (tx) =>
      getDirectionCoverage(tx, userId, [
        { id: 'd1', label: 'Qualitätsmanagement', searchTerms: ['qualitätsmanager'] },
        { id: 'd4', label: 'Frontend Developer', searchTerms: [] },
      ]),
    );
    expect(coverage.get('d1')).toBe(1);
    expect(coverage.get('d4')).toBe(1);
  });

  it('returns an empty map for an empty direction list, without querying', async () => {
    const coverage = await db.transaction(async (tx) => getDirectionCoverage(tx, userId, []));
    expect(coverage.size).toBe(0);
  });
});
