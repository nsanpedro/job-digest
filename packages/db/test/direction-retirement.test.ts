/**
 * Re-derivation retires the previous directions (ADR-003 §8.13), against a
 * real Postgres with the roles production uses: the web role (`app_user`)
 * completes a derivation and saves excludes, the worker role reads
 * directions for the ingest gate — both under RLS, not as the table owner.
 *
 * I26: only the active profile version's directions are read.
 * I27: a completed derivation leaves no exclude that is applied but not
 *      visible — each one moved onto the new directions, or held (inert,
 *      listed as not applied) on its retired one.
 */
import type { Direction } from '@job-digest/core';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { sql } from 'drizzle-orm';
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  completeDerivation,
  failDerivation,
  listDirections,
  listInterestedDirections,
  setDirectionState,
  startDerivation,
} from '../src/queries/discovery';
import {
  addExcludeFromDismissal,
  carryOverExcludes,
  listFeedbackEffects,
  removeEffectsFromAd,
  removeExcludeTerm,
} from '../src/queries/feedback';
import * as schema from '../src/schema';
import { migrateToHead } from './migrate';

type Tx = PostgresJsDatabase<Record<string, unknown>>;

let container: StartedPostgreSqlContainer;
let client: postgres.Sql;
let db: PostgresJsDatabase<typeof schema>;

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:17-alpine').start();
  // onnotice: the migrations' DROP POLICY IF EXISTS notices are noise here.
  client = postgres(container.getConnectionUri(), { max: 1, onnotice: () => {} });
  db = drizzle(client, { schema });
  await migrateToHead(db, client);
}, 180_000);

afterAll(async () => {
  await client?.end();
  await container?.stop();
});

/** Same shape as the app's and the worker's `withTenant`: one transaction, role and tenant set locally. */
function as<T>(role: 'app_user' | 'worker', userId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(sql.raw(`SET LOCAL ROLE ${role}`));
    await tx.execute(sql`SELECT set_config('app.user_id', ${userId}, true)`);
    return fn(tx as unknown as Tx);
  });
}

const direction = (label: string, searchTerms: string[]): Direction => ({
  label,
  rationale: `${label} rationale`,
  bridge: [],
  searchTerms,
  distance: 'adjacent',
  seenTitles: [],
});

async function derive(userId: string, dirs: Direction[]): Promise<number> {
  return as('app_user', userId, async (tx) => {
    const { profileId, version } = await startDerivation(tx, userId);
    await completeDerivation(tx, userId, profileId, version, {
      skills: [],
      directions: dirs,
      dropped: [],
      promptVersion: 2,
      model: 'test',
    });
    return version;
  });
}

async function seedUser(email: string): Promise<{ userId: string; adIds: string[] }> {
  const [account] = await db.insert(schema.accounts).values({ email }).returning();
  const userId = account!.id;
  const adIds: string[] = [];
  for (const title of ['Frontend Engineer Sales Enablement', 'Frontend Entwickler SAP Commerce']) {
    const [ad] = await db
      .insert(schema.ads)
      .values({
        userId,
        dedupeKey: `${email}-${title}`,
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
      })
      .returning({ id: schema.ads.id });
    adIds.push(ad!.id);
  }
  return { userId, adIds };
}

const labels = (rows: ReadonlyArray<{ label: string }>) => rows.map((r) => r.label).sort();

describe('re-derivation retires the previous directions (I26)', () => {
  it('reads only the active version, for the web role and the worker alike', async () => {
    const { userId } = await seedUser('i26@example.com');
    await derive(userId, [direction('Frontend Entwickler', ['Frontend Entwickler'])]);
    const v2 = await derive(userId, [
      direction('Frontend Engineer', ['Frontend Engineer', 'Frontend Developer']),
      direction('Engineering Manager', ['Engineering Manager']),
    ]);

    expect(labels(await as('app_user', userId, (tx) => listInterestedDirections(tx, userId)))).toEqual([
      'Engineering Manager',
      'Frontend Engineer',
    ]);
    // The ingest gate runs as the worker (fetch-apis.ts).
    expect(labels(await as('worker', userId, (tx) => listInterestedDirections(tx, userId)))).toEqual([
      'Engineering Manager',
      'Frontend Engineer',
    ]);
    // …which is exactly what Profile lists.
    expect(labels(await as('app_user', userId, (tx) => listDirections(tx, userId, v2)))).toEqual([
      'Engineering Manager',
      'Frontend Engineer',
    ]);
  });

  it('a failed re-derivation leaves the previous directions in force', async () => {
    const { userId } = await seedUser('failed@example.com');
    await derive(userId, [direction('Frontend Engineer', ['Frontend Engineer'])]);
    await as('app_user', userId, async (tx) => {
      const { profileId } = await startDerivation(tx, userId);
      await failDerivation(tx, userId, profileId, 'internal', 'boom');
    });
    expect(labels(await as('app_user', userId, (tx) => listInterestedDirections(tx, userId)))).toEqual([
      'Frontend Engineer',
    ]);
  });

  it('a user-dismissed direction of the active version stays out', async () => {
    const { userId } = await seedUser('dismissed@example.com');
    const v1 = await derive(userId, [direction('A', ['a']), direction('B', ['b'])]);
    const [a] = (await as('app_user', userId, (tx) => listDirections(tx, userId, v1))).filter((d) => d.label === 'A');
    await as('app_user', userId, (tx) => setDirectionState(tx, userId, a!.id, 'dismissed'));
    expect(labels(await as('app_user', userId, (tx) => listInterestedDirections(tx, userId)))).toEqual(['B']);
  });

  it('no CV yet → no directions', async () => {
    const { userId } = await seedUser('nocv@example.com');
    expect(await as('worker', userId, (tx) => listInterestedDirections(tx, userId))).toEqual([]);
  });
});

describe('excludes follow the active version (I27)', () => {
  it('moves each word to every new direction, keeping its dismissal and date; Undo and Remove still work', async () => {
    const { userId, adIds } = await seedUser('carry@example.com');
    const [salesAd, sapAd] = adIds as [string, string];
    const v1 = await derive(userId, [
      direction('Frontend Entwickler', ['Frontend Entwickler']),
      direction('Webentwickler', ['Webentwickler']),
    ]);
    const old = await as('app_user', userId, (tx) => listDirections(tx, userId, v1));
    await as('app_user', userId, async (tx) => {
      await addExcludeFromDismissal(tx, userId, { adId: salesAd, directionIds: old.map((d) => d.id), term: 'Sales' });
      await addExcludeFromDismissal(tx, userId, { adId: sapAd, directionIds: [old[0]!.id], term: 'SAP' });
    });
    const before = await as('app_user', userId, (tx) => listFeedbackEffects(tx, userId));
    const salesSince = before.find((e) => e.valueKey === 'sales')!.createdAt;

    const v2 = await derive(userId, [
      direction('Frontend Engineer', ['Frontend Engineer']),
      direction('Engineering Manager', ['Engineering Manager']),
    ]);

    // The matcher's input: both new directions carry both words.
    const effective = await as('worker', userId, (tx) => listInterestedDirections(tx, userId));
    expect(effective.every((d) => d.profileVersion === v2)).toBe(true);
    for (const d of effective) expect([...d.excludeTerms].sort()).toEqual(['SAP', 'Sales']);

    // Their provenance: one row per word per new direction, same ad, same date; the old rows are gone.
    const after = await as('app_user', userId, (tx) => listFeedbackEffects(tx, userId));
    expect(after).toHaveLength(4);
    expect(after.every((e) => e.applied && effective.some((d) => d.id === e.directionId))).toBe(true);
    expect(after.filter((e) => e.valueKey === 'sales').map((e) => [e.adId, e.createdAt.getTime()])).toEqual([
      [salesAd, salesSince.getTime()],
      [salesAd, salesSince.getTime()],
    ]);

    // Undo on the "Sales" dismissal takes the word off every new direction.
    await as('app_user', userId, (tx) => removeEffectsFromAd(tx, userId, salesAd));
    let now = await as('app_user', userId, (tx) => listInterestedDirections(tx, userId));
    for (const d of now) expect(d.excludeTerms).not.toContain('Sales');

    // Remove in Profile takes a word off every direction at once.
    await as('app_user', userId, (tx) => removeExcludeTerm(tx, userId, 'sap'));
    now = await as('app_user', userId, (tx) => listInterestedDirections(tx, userId));
    for (const d of now) expect(d.excludeTerms).toEqual([]);
    expect(await as('app_user', userId, (tx) => listFeedbackEffects(tx, userId))).toEqual([]);
  });

  it('holds a word a new direction searches for, lists it as not applied, and carries it once that direction is gone', async () => {
    const { userId, adIds } = await seedUser('held@example.com');
    const v1 = await derive(userId, [direction('Frontend Entwickler', ['Frontend Entwickler'])]);
    const [old] = await as('app_user', userId, (tx) => listDirections(tx, userId, v1));
    await as('app_user', userId, (tx) =>
      addExcludeFromDismissal(tx, userId, { adId: adIds[0]!, directionIds: [old!.id], term: 'sales' }),
    );

    await derive(userId, [
      direction('Frontend Engineer', ['Frontend Engineer']),
      direction('Sales Engineer', ['Sales Engineer']),
    ]);
    const effective = await as('app_user', userId, (tx) => listInterestedDirections(tx, userId));
    for (const d of effective) expect(d.excludeTerms).toEqual([]);
    const held = await as('app_user', userId, (tx) => listFeedbackEffects(tx, userId));
    expect(held.map((e) => [e.valueKey, e.directionId, e.applied])).toEqual([['sales', old!.id, false]]);

    const v3 = await derive(userId, [direction('Frontend Engineer', ['Frontend Engineer'])]);
    const [fe] = await as('app_user', userId, (tx) => listInterestedDirections(tx, userId));
    expect(fe!.profileVersion).toBe(v3);
    expect(fe!.excludeTerms).toEqual(['sales']);
    const carried = await as('app_user', userId, (tx) => listFeedbackEffects(tx, userId));
    expect(carried.map((e) => [e.directionId, e.applied, e.adId])).toEqual([[fe!.id, true, adIds[0]]]);
  });

  it('a derivation with no directions holds every word', async () => {
    const { userId, adIds } = await seedUser('empty@example.com');
    const v1 = await derive(userId, [direction('Frontend Entwickler', ['Frontend Entwickler'])]);
    const [old] = await as('app_user', userId, (tx) => listDirections(tx, userId, v1));
    await as('app_user', userId, (tx) =>
      addExcludeFromDismissal(tx, userId, { adId: adIds[0]!, directionIds: [old!.id], term: 'sales' }),
    );
    await derive(userId, []);
    expect(await as('app_user', userId, (tx) => listInterestedDirections(tx, userId))).toEqual([]);
    const fx = await as('app_user', userId, (tx) => listFeedbackEffects(tx, userId));
    expect(fx.map((e) => [e.valueKey, e.applied])).toEqual([['sales', false]]);
  });

  it('is idempotent: running the carry-over again changes nothing', async () => {
    const { userId, adIds } = await seedUser('idem@example.com');
    const v1 = await derive(userId, [direction('A', ['Alpha'])]);
    const [old] = await as('app_user', userId, (tx) => listDirections(tx, userId, v1));
    await as('app_user', userId, (tx) =>
      addExcludeFromDismissal(tx, userId, { adId: adIds[0]!, directionIds: [old!.id], term: 'sales' }),
    );
    const v2 = await derive(userId, [direction('B', ['Beta'])]);
    const once = await as('app_user', userId, (tx) => listFeedbackEffects(tx, userId));
    const again = await as('app_user', userId, (tx) => carryOverExcludes(tx, userId, v2));
    expect(again).toEqual({ carry: [], held: [] });
    expect(await as('app_user', userId, (tx) => listFeedbackEffects(tx, userId))).toEqual(once);
    const [b] = await as('app_user', userId, (tx) => listInterestedDirections(tx, userId));
    expect(b!.excludeTerms).toEqual(['sales']);
  });

  it('repairs excludes saved on an older version while it was still read (before this change)', async () => {
    const { userId, adIds } = await seedUser('legacy@example.com');
    const v1 = await derive(userId, [direction('Old', ['Old term'])]);
    const [old] = await as('app_user', userId, (tx) => listDirections(tx, userId, v1));
    const v2 = await derive(userId, [direction('New', ['New term'])]);
    // Before I26 the dismiss follow-up read every version, so a word could land on v1 after v2 existed.
    await as('app_user', userId, (tx) =>
      addExcludeFromDismissal(tx, userId, { adId: adIds[0]!, directionIds: [old!.id], term: 'sales' }),
    );
    expect((await as('app_user', userId, (tx) => listFeedbackEffects(tx, userId)))[0]!.applied).toBe(false);

    await as('app_user', userId, (tx) => carryOverExcludes(tx, userId, v2));
    const [dir] = await as('app_user', userId, (tx) => listInterestedDirections(tx, userId));
    expect(dir!.excludeTerms).toEqual(['sales']);
    expect((await as('app_user', userId, (tx) => listFeedbackEffects(tx, userId)))[0]!.applied).toBe(true);
  });
});
