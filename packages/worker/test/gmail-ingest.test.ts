/**
 * ingestFromGmail against real Postgres via Testcontainers, with `fetch`
 * mocked for the three real Gmail endpoints (token refresh, message list,
 * message get) — the same boundary gmail.test.ts already draws, extended
 * here because these assertions need the DB side effects (runs progress,
 * the sync watermark) that the pure unit tests can't see.
 *
 * What's pinned:
 * - `runs.emails_total`/`emails_processed` update during the run, not only
 *   at the end — the mechanism the "4 of 12" progress UI polls.
 * - `mailboxes.last_synced_at` is set after a successful run, and the next
 *   run's message-list query is bounded by it (`after:`, not `newer_than:`).
 * - A per-message failure still lets the watermark advance — the run as a
 *   whole succeeded even though one message didn't (same tolerance the
 *   sequential loop always had).
 */
import { readFileSync } from 'node:fs';
import { encryptSecret } from '@job-digest/core/credentials';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import * as schema from '@job-digest/db';
import { eq } from 'drizzle-orm';
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { credentialKey, ingestFromGmail, PARSER_VERSION } from '../src/index';

let container: StartedPostgreSqlContainer;
let client: postgres.Sql;
let db: PostgresJsDatabase<Record<string, unknown>>;
let userId: string;
let mailboxId: string;

const KEY_B64 = Buffer.alloc(32, 7).toString('base64');
const fixtureBytes = readFileSync(
  new URL(
    "../../ingest/test/fixtures/linkedin/Full Stack Engineer en Arrows.eml",
    import.meta.url,
  ),
);

beforeAll(async () => {
  process.env.MAILBOX_CREDENTIAL_KEY = KEY_B64;
  process.env.AUTH_GOOGLE_ID = 'client-id';
  process.env.AUTH_GOOGLE_SECRET = 'client-secret';

  container = await new PostgreSqlContainer('postgres:17-alpine').start();
  client = postgres(container.getConnectionUri(), { max: 1 });
  db = drizzle(client);
  await migrate(db, { migrationsFolder: new URL('../../db/migrations', import.meta.url).pathname });

  const [account] = await db.insert(schema.accounts).values({ email: 'nico@example.com' }).returning();
  userId = account!.id;
  const [mailbox] = await db
    .insert(schema.mailboxes)
    .values({
      userId,
      provider: 'google',
      authKind: 'oauth',
      emailAddress: 'nico@example.com',
      credentialsEnc: encryptSecret('refresh-token', credentialKey()),
      keyVersion: 1,
      status: 'active',
    })
    .returning();
  mailboxId = mailbox!.id;
}, 240_000);

afterAll(async () => {
  await client?.end();
  await container?.stop();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

async function newRun(): Promise<string> {
  const [run] = await db.insert(schema.runs).values({ userId, mailboxId, parserVersion: PARSER_VERSION }).returning();
  return run!.id;
}

/** Stubs the three Gmail endpoints ingestFromGmail actually calls. */
function stubGmail(messageIds: string[], opts: { failIds?: Set<string>; captureQuery?: (q: string) => void } = {}) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string | URL) => {
      const s = String(url);
      if (s.includes('oauth2.googleapis.com/token')) {
        return new Response(JSON.stringify({ access_token: 'access-token' }), { status: 200 });
      }
      if (s.includes('/messages?') || (s.includes('/messages') && !s.match(/\/messages\/[^/?]+/))) {
        opts.captureQuery?.(decodeURIComponent(new URL(s).searchParams.get('q') ?? ''));
        return new Response(JSON.stringify({ messages: messageIds.map((id) => ({ id })) }), { status: 200 });
      }
      const idMatch = s.match(/\/messages\/([^/?]+)/);
      const id = idMatch![1]!;
      if (opts.failIds?.has(id)) return new Response('boom', { status: 500 });
      return new Response(JSON.stringify({ raw: fixtureBytes.toString('base64url') }), { status: 200 });
    }),
  );
}

// Order matters within this file: every test shares one mailbox row, and a
// successful run always sets last_synced_at — so "unset before the first
// run" has to be the first run this file ever makes against it.
describe('the sync watermark', () => {
  it('is unset before the first run, and set after one succeeds', async () => {
    const before = await db.select({ w: schema.mailboxes.lastSyncedAt }).from(schema.mailboxes).where(eq(schema.mailboxes.id, mailboxId));
    expect(before[0]?.w).toBeNull();

    const runId = await newRun();
    let usedQuery = '';
    stubGmail(['m1'], { captureQuery: (q) => (usedQuery = q) });
    const cred = (await db.select({ c: schema.mailboxes.credentialsEnc }).from(schema.mailboxes).where(eq(schema.mailboxes.id, mailboxId)))[0]!.c!;
    await ingestFromGmail(db, { userId, mailboxId, runId, credentialsEnc: cred });

    expect(usedQuery).toMatch(/newer_than:\d+d/);
    const after = await db.select({ w: schema.mailboxes.lastSyncedAt }).from(schema.mailboxes).where(eq(schema.mailboxes.id, mailboxId));
    expect(after[0]?.w).not.toBeNull();
  });

  it('bounds the next run\'s query by the watermark instead of re-scanning the fixed window', async () => {
    const row = (await db.select({ w: schema.mailboxes.lastSyncedAt }).from(schema.mailboxes).where(eq(schema.mailboxes.id, mailboxId)))[0]!;
    const since = row.w!;

    const runId = await newRun();
    let usedQuery = '';
    stubGmail(['m2'], { captureQuery: (q) => (usedQuery = q) });
    const cred = (await db.select({ c: schema.mailboxes.credentialsEnc }).from(schema.mailboxes).where(eq(schema.mailboxes.id, mailboxId)))[0]!.c!;
    await ingestFromGmail(db, { userId, mailboxId, runId, credentialsEnc: cred, since });

    expect(usedQuery).toContain(`after:${Math.floor(since.getTime() / 1000)}`);
    expect(usedQuery).not.toContain('newer_than');
  });

  it('still advances even when some messages in the run failed', async () => {
    const before = (await db.select({ w: schema.mailboxes.lastSyncedAt }).from(schema.mailboxes).where(eq(schema.mailboxes.id, mailboxId)))[0]!.w!;
    const runId = await newRun();
    stubGmail(['ok', 'bad'], { failIds: new Set(['bad']) });
    const cred = (await db.select({ c: schema.mailboxes.credentialsEnc }).from(schema.mailboxes).where(eq(schema.mailboxes.id, mailboxId)))[0]!.c!;
    await ingestFromGmail(db, { userId, mailboxId, runId, credentialsEnc: cred, since: before });

    const after = (await db.select({ w: schema.mailboxes.lastSyncedAt }).from(schema.mailboxes).where(eq(schema.mailboxes.id, mailboxId)))[0]!.w!;
    expect(after.getTime()).toBeGreaterThan(before.getTime());
  });

  it('does not advance when the run fails before fetching anything (auth error)', async () => {
    const before = (await db.select({ w: schema.mailboxes.lastSyncedAt }).from(schema.mailboxes).where(eq(schema.mailboxes.id, mailboxId)))[0]!.w!;
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400 })));
    const runId = await newRun();
    const cred = (await db.select({ c: schema.mailboxes.credentialsEnc }).from(schema.mailboxes).where(eq(schema.mailboxes.id, mailboxId)))[0]!.c!;

    await expect(ingestFromGmail(db, { userId, mailboxId, runId, credentialsEnc: cred, since: before })).rejects.toThrow();

    const after = (await db.select({ w: schema.mailboxes.lastSyncedAt }).from(schema.mailboxes).where(eq(schema.mailboxes.id, mailboxId)))[0]!.w!;
    expect(after.getTime()).toBe(before.getTime());
  });
});

describe('progress is visible during the run, not only after', () => {
  it('sets emails_total up front and increments emails_processed per message', async () => {
    const runId = await newRun();
    stubGmail(['m1', 'm2', 'm3']);
    const cred = (await db.select({ c: schema.mailboxes.credentialsEnc }).from(schema.mailboxes).where(eq(schema.mailboxes.id, mailboxId)))[0]!.c!;

    const summary = await ingestFromGmail(db, { userId, mailboxId, runId, credentialsEnc: cred });

    expect(summary).toEqual({ found: 3, processed: 3, created: expect.any(Number), failed: 0 });
    const [run] = await db.select().from(schema.runs).where(eq(schema.runs.id, runId));
    expect(run?.emailsTotal).toBe(3);
    expect(run?.emailsProcessed).toBe(3);
  });

  it('a message that fails to fetch is counted as failed, and the run still finishes', async () => {
    const runId = await newRun();
    stubGmail(['ok-1', 'bad-1', 'ok-2'], { failIds: new Set(['bad-1']) });
    const cred = (await db.select({ c: schema.mailboxes.credentialsEnc }).from(schema.mailboxes).where(eq(schema.mailboxes.id, mailboxId)))[0]!.c!;

    const summary = await ingestFromGmail(db, { userId, mailboxId, runId, credentialsEnc: cred });

    expect(summary.failed).toBe(1);
    expect(summary.processed).toBe(2);
    const [run] = await db.select().from(schema.runs).where(eq(schema.runs.id, runId));
    // emails_processed counts attempts, success or failure — it is what the
    // progress UI's "N of total" reads, and a failed message still finished.
    expect(run?.emailsProcessed).toBe(3);
  });
});
