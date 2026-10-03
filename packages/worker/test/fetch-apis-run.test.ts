/**
 * The public-sources run row must always be closed: RefreshButton polls it
 * and waits for it to leave 'running'. Until Oct 2026 fetchApiSources never
 * wrote a terminal status, so every API run stayed 'running' forever and
 * "Update now" hung after the last source. Real Postgres via Testcontainers,
 * worker role with RLS active, no mocks.
 */
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import * as schema from '@job-digest/db';
import { eq } from 'drizzle-orm';
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrateToHead } from '../../db/test/migrate';
import { fetchApiSources } from '../src/index';

let container: StartedPostgreSqlContainer;
let client: postgres.Sql;
let db: PostgresJsDatabase<Record<string, unknown>>;

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:17-alpine').start();
  client = postgres(container.getConnectionUri(), { max: 1 });
  db = drizzle(client);
  await migrateToHead(db, client);
}, 240_000);

afterAll(async () => {
  await client?.end();
  await container?.stop();
});

async function newUserWithRun(email: string): Promise<{ userId: string; runId: string }> {
  const [account] = await db.insert(schema.accounts).values({ email }).returning();
  const userId = account!.id;
  // An API run has no mailbox and parser version 0 — the shape startRefresh
  // and the add-source action create.
  const [run] = await db.insert(schema.runs).values({ userId, parserVersion: 0 }).returning();
  return { userId, runId: run!.id };
}

const runRow = async (runId: string) =>
  (await db.select().from(schema.runs).where(eq(schema.runs.id, runId)).limit(1))[0]!;

describe('fetchApiSources closes its run', () => {
  it('marks the run ok with a finish time when the user has no sources', async () => {
    const { userId, runId } = await newUserWithRun('no-sources@example.com');

    await fetchApiSources(db, { userId, runId });

    const run = await runRow(runId);
    expect(run.status).toBe('ok');
    expect(run.finishedAt).toBeInstanceOf(Date);
    expect(run.emailsTotal).toBe(0);
  });

  it('a failing source is recorded on the source, and the run still closes ok', async () => {
    const { userId, runId } = await newUserWithRun('failing-source@example.com');
    const [source] = await db
      .insert(schema.sources)
      .values({
        userId,
        provider: 'Greenhouse',
        // A board that does not exist (and, in a sandbox without egress, a
        // host that cannot be reached): either way the fetch fails.
        externalSlug: 'job-digest-test-board-that-does-not-exist',
        displayName: 'Nobody',
      })
      .returning();

    await fetchApiSources(db, { userId, runId });

    const run = await runRow(runId);
    expect(run.status).toBe('ok');
    expect(run.finishedAt).toBeInstanceOf(Date);
    expect(run.emailsTotal).toBe(1);
    expect(run.emailsProcessed).toBe(1);

    const [after] = await db.select().from(schema.sources).where(eq(schema.sources.id, source!.id));
    expect(after!.status).toBe('failing');
    expect(after!.lastError).not.toBeNull();
  });
});
