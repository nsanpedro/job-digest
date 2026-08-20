/**
 * Tenancy and I13 assertions from design §14, against a real Postgres via
 * Testcontainers — no mocks in the critical path:
 *
 * - A query under user A's scope returns zero rows of user B's data, with RLS
 *   doing the work rather than a WHERE clause.
 * - Without a tenant scope set, app roles see nothing at all.
 * - WITH CHECK rejects writes into another tenant's rows.
 * - The web role (app_user) cannot SELECT credential ciphertext — I13
 *   enforced by the database, asserted, not assumed.
 */
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { sql } from 'drizzle-orm';
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as schema from '../src/schema';

let container: StartedPostgreSqlContainer;
let client: postgres.Sql;
let db: PostgresJsDatabase<typeof schema>;
let userA: string;
let userB: string;

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:17-alpine').start();
  // Single connection so SET ROLE / set_config stick to the session under test.
  client = postgres(container.getConnectionUri(), { max: 1 });
  db = drizzle(client, { schema });
  await migrate(db, { migrationsFolder: new URL('../migrations', import.meta.url).pathname });

  // Seed as the table owner (bypasses RLS — that is what seeding is).
  const [a] = await db.insert(schema.accounts).values({ email: 'a@example.com' }).returning();
  const [b] = await db.insert(schema.accounts).values({ email: 'b@example.com' }).returning();
  if (!a || !b) throw new Error('seed failed');
  userA = a.id;
  userB = b.id;

  for (const [userId, who] of [
    [userA, 'a'],
    [userB, 'b'],
  ] as const) {
    const [mailbox] = await db
      .insert(schema.mailboxes)
      .values({
        userId,
        provider: 'gmail',
        authKind: 'app_password',
        emailAddress: `${who}@example.com`,
        credentialsEnc: Buffer.from(`sealed-secret-${who}`),
        keyVersion: 1,
        status: 'active',
      })
      .returning({ id: schema.mailboxes.id });
    if (!mailbox) throw new Error('seed failed');
    await db.insert(schema.ads).values({
      userId,
      dedupeKey: `ad-${who}`,
      title: `Sachbearbeitung ${who}`,
      source: 'LinkedIn',
      facts: {
        rotating: false,
        weekend: false,
        german: 'B2',
        home: 2,
        pay: 2900,
        payMax: null,
        payFte: null,
        fteNote: null,
        permanent: true,
        commuteMin: null,
      },
      wording: {} as never,
      firstSeenAt: new Date(),
      lastSeenAt: new Date(),
    });

    // Role discovery (docs/adr-001-role-discovery.md §3): a completed
    // derivation and its one direction, per user — same seeding pattern as
    // the mailbox/ad pair above.
    await db.insert(schema.profiles).values({
      userId,
      version: 1,
      data: { skills: [] },
      isActive: true,
      status: 'ok',
    });
    await db.insert(schema.directions).values({
      userId,
      profileVersion: 1,
      label: `Direction ${who}`,
      rationale: 'test rationale',
      bridge: ['skill 1', 'skill 2'],
      searchTerms: ['search term'],
      distance: 'adjacent',
      seenTitles: [],
    });
  }
}, 180_000);

afterAll(async () => {
  await client?.end();
  await container?.stop();
});

const asTenant = async (role: 'app_user' | 'worker', userId: string | null) => {
  await client`RESET ROLE`;
  await client.unsafe(`SET ROLE ${role}`);
  // set_config(NULL) stores '' — the policy's NULLIF turns that into zero rows.
  await client`SELECT set_config('app.user_id', ${userId ?? ''}, false)`;
};

const asOwner = async () => {
  await client`RESET ROLE`;
};

describe('row-level security (design §2, §14)', () => {
  it("user A's scope sees only user A's ads — for both app roles", async () => {
    for (const role of ['app_user', 'worker'] as const) {
      await asTenant(role, userA);
      const rows = await client`SELECT dedupe_key FROM ads`;
      expect(rows.map((r) => r['dedupe_key'])).toEqual(['ad-a']);
    }
    await asOwner();
  });

  it('no tenant scope set → zero rows, not an error and not everything', async () => {
    await asTenant('app_user', null);
    expect(await client`SELECT * FROM ads`).toHaveLength(0);
    expect(await client`SELECT * FROM accounts`).toHaveLength(0);
    await asOwner();
  });

  it("WITH CHECK rejects an insert claiming another tenant's user_id", async () => {
    await asTenant('worker', userA);
    await expect(
      client`INSERT INTO runs (user_id, parser_version) VALUES (${userB}, 1)`,
    ).rejects.toThrow(/row-level security/);
    await asOwner();
  });

  it("an update cannot move a row into another tenant", async () => {
    await asTenant('app_user', userA);
    // UPDATE under RLS: B's rows are invisible, so this affects zero rows
    // rather than leaking — and moving A's row to B trips WITH CHECK.
    await expect(client`UPDATE ads SET user_id = ${userB} WHERE dedupe_key = 'ad-a'`).rejects.toThrow(
      /row-level security/,
    );
    await asOwner();
  });

  it('the table owner (migrations, seeding) is not silently subject to RLS', async () => {
    await asOwner();
    expect(await client`SELECT * FROM ads`).toHaveLength(2);
  });

  it("user A's scope sees only user A's directions — for both app roles (ADR-001)", async () => {
    for (const role of ['app_user', 'worker'] as const) {
      await asTenant(role, userA);
      const rows = await client`SELECT label FROM directions`;
      expect(rows.map((r) => r['label'])).toEqual(['Direction a']);
    }
    await asOwner();
  });

  it("user A's scope sees only user A's profile (ADR-001)", async () => {
    await asTenant('app_user', userA);
    const rows = await client`SELECT version FROM profiles`;
    expect(rows).toHaveLength(1);
    await asOwner();
  });
});

describe('I13 at the database level (design §14)', () => {
  it('app_user cannot SELECT credential ciphertext — permission denied, not empty', async () => {
    await asTenant('app_user', userA);
    await expect(client`SELECT credentials_enc FROM mailboxes`).rejects.toThrow(/permission denied/);
    await asOwner();
  });

  it('app_user can read every other mailbox column', async () => {
    await asTenant('app_user', userA);
    const rows = await client`
      SELECT id, provider, auth_kind, email_address, status, credential_expires_at
      FROM mailboxes`;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.['provider']).toBe('gmail');
    await asOwner();
  });

  it('app_user can still write credentials it cannot read back (connect flow)', async () => {
    await asTenant('app_user', userA);
    const updated = await client`
      UPDATE mailboxes SET credentials_enc = ${Buffer.from('resealed')}, key_version = 2
      WHERE email_address = 'a@example.com'
      RETURNING id`;
    expect(updated).toHaveLength(1);
    await asOwner();
  });

  it('the worker role reads ciphertext normally — decryption is its job', async () => {
    await asTenant('worker', userA);
    const rows = await client`SELECT credentials_enc FROM mailboxes`;
    expect(rows).toHaveLength(1);
    await asOwner();
  });
});

describe('schema invariant guards', () => {
  it('one active ruleset per user — the partial unique index holds', async () => {
    await asOwner();
    const insertRuleset = (version: number, active: boolean) =>
      client`INSERT INTO rulesets (user_id, version, rules, is_active)
             VALUES (${userA}, ${version}, '{}', ${active})`;
    await insertRuleset(1, true);
    await insertRuleset(2, false); // a second inactive version is fine
    await expect(insertRuleset(3, true)).rejects.toThrow(/rulesets_one_active_per_user/);
  });

  it('re-parsing the same email with the same parser version is unique (I2)', async () => {
    await asOwner();
    const [mailbox] = await client`SELECT id FROM mailboxes WHERE email_address = 'a@example.com'`;
    const [email] = await client`
      INSERT INTO raw_emails (user_id, mailbox_id, message_id, from_addr, subject, received_at, raw_bytes, mime_parts)
      VALUES (${userA}, ${mailbox!['id']}, '<m1@x>', 'jobs-noreply@linkedin.com', 's', now(), ${Buffer.from('raw')}, '{}')
      RETURNING id`;
    const insertParse = () =>
      client`
        INSERT INTO email_parses (user_id, raw_email_id, parser_version, outcome)
        VALUES (${userA}, ${email!['id']}, 1, 'ok')`;
    await insertParse();
    await expect(insertParse()).rejects.toThrow(/email_parses_email_version/);
  });

  it('one active profile per user — the partial unique index holds (ADR-001)', async () => {
    await asOwner();
    // userA already has version 1, active, from the seed block above.
    const insertProfile = (version: number, active: boolean) =>
      client`INSERT INTO profiles (user_id, version, data, is_active)
             VALUES (${userA}, ${version}, '{}', ${active})`;
    await insertProfile(2, false); // a second inactive version is fine
    await expect(insertProfile(3, true)).rejects.toThrow(/profiles_one_active_per_user/);
  });

  it('a direction is unique per (user, profile_version, label) — completeDerivation\'s onConflictDoNothing target (ADR-001)', async () => {
    await asOwner();
    // userA already has ('Direction a', version 1) from the seed block above.
    const insertDirection = (label: string) =>
      client`INSERT INTO directions (user_id, profile_version, label, rationale, bridge, search_terms, distance)
             VALUES (${userA}, 1, ${label}, 'r', ARRAY['s1','s2'], ARRAY['t'], 'adjacent')`;
    await insertDirection('A different direction, same version'); // fine — different label
    await expect(insertDirection('Direction a')).rejects.toThrow(/directions_user_version_label/);
  });
});
