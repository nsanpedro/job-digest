/**
 * End-to-end ingestion against real Postgres via Testcontainers: real .eml
 * bytes → raw_emails → email_parses → ads + sightings, all under the worker
 * role with RLS active (design §2, §14) — no mocks anywhere in the path.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { evaluate, isBlocked, type Ruleset } from '@job-digest/core';
import * as schema from '@job-digest/db';
import { and, eq } from 'drizzle-orm';
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ingestEmail, withTenant, PARSER_VERSION } from '../src/index';

let container: StartedPostgreSqlContainer;
let client: postgres.Sql;
let db: PostgresJsDatabase<Record<string, unknown>>;
let userId: string;
let mailboxId: string;
let runId: string;

const fixtures = new URL('../../ingest/test/fixtures', import.meta.url).pathname;
const emlPath = (platform: string, prefix: string): string => {
  const dir = join(fixtures, platform);
  const file = readdirSync(dir).find((f) => f.startsWith(prefix) && f.endsWith('.eml'));
  if (!file) throw new Error(`fixture ${platform}/${prefix}* not found`);
  return join(dir, file);
};
const raw = (platform: string, prefix: string): Buffer => readFileSync(emlPath(platform, prefix));

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:17-alpine').start();
  client = postgres(container.getConnectionUri(), { max: 1 });
  db = drizzle(client);
  await migrate(db, {
    migrationsFolder: new URL('../../db/migrations', import.meta.url).pathname,
  });

  const [account] = await db
    .insert(schema.accounts)
    .values({ email: 'nico@example.com' })
    .returning();
  userId = account!.id;
  const [mailbox] = await db
    .insert(schema.mailboxes)
    .values({
      userId,
      provider: 'gmail',
      authKind: 'app_password',
      emailAddress: 'nico@example.com',
      status: 'active',
    })
    .returning();
  mailboxId = mailbox!.id;
  const [run] = await db
    .insert(schema.runs)
    .values({ userId, mailboxId, parserVersion: PARSER_VERSION })
    .returning();
  runId = run!.id;
}, 240_000);

afterAll(async () => {
  await client?.end();
  await container?.stop();
});

const ingest = (buf: Buffer, alertName?: string) =>
  withTenant(db, userId, (tx) =>
    ingestEmail(tx, {
      userId,
      mailboxId,
      runId,
      raw: buf,
      ...(alertName === undefined ? {} : { alertName }),
    }),
  );

describe('ingesting a real LinkedIn alert', () => {
  it('stores the email, records the parse, and creates ads', async () => {
    const result = await ingest(raw('linkedin', 'Senior Frontend Engineer en Joppy'));

    expect(result.storedNow).toBe(true);
    expect(result.platform).toBe('LinkedIn');
    expect(result.outcome).toBe('ok');
    expect(result.causeCode).toBeNull();
    // Subject declares one headline job; the email is a six-job digest.
    expect(result.declaredCount).toBe(1);
    expect(result.extractedCount).toBe(6);
    expect(result.adsCreated).toBe(6);

    const stored = await withTenant(db, userId, (tx) =>
      tx.select().from(schema.ads).where(eq(schema.ads.source, 'LinkedIn')),
    );
    expect(stored).toHaveLength(6);
    // LinkedIn exposes a real ad id; it is kept for provenance.
    expect(stored.every((a) => a.externalId?.startsWith('linkedin:'))).toBe(true);
  });

  it('re-ingesting the same bytes is a no-op — raw, parse and ads all converge (I1, I2)', async () => {
    const before = await withTenant(db, userId, (tx) => tx.select().from(schema.ads));
    const result = await ingest(raw('linkedin', 'Senior Frontend Engineer en Joppy'));

    expect(result.storedNow).toBe(false);
    expect(result.adsCreated).toBe(0);

    const after = await withTenant(db, userId, (tx) => tx.select().from(schema.ads));
    expect(after).toHaveLength(before.length);

    const parses = await withTenant(db, userId, (tx) =>
      tx
        .select()
        .from(schema.emailParses)
        .where(eq(schema.emailParses.rawEmailId, result.rawEmailId)),
    );
    expect(parses).toHaveLength(1);
  });

  it('a second sighting of the same ad adds a sighting, not an ad', async () => {
    const sightings = await withTenant(db, userId, (tx) => tx.select().from(schema.adSightings));
    // Six ads, each seen twice (original ingest + the re-ingest above).
    expect(sightings.length).toBe(12);
  });
});

describe('ingesting real Xing digests', () => {
  it('extracts 20 ads and stores the salary band as monthly facts', async () => {
    const result = await ingest(raw('xing', 'SOMI'), 'Fullstack · Hamburg');

    expect(result.platform).toBe('Xing');
    expect(result.extractedCount).toBe(20);
    expect(result.adsCreated).toBe(20);
    // Xing declares no count in the subject — recorded as unverifiable (I3).
    expect(result.declaredCount).toBeNull();
    expect(result.outcome).toBe('ok');

    const [ad] = await withTenant(db, userId, (tx) =>
      tx
        .select()
        .from(schema.ads)
        .where(
          and(eq(schema.ads.source, 'Xing'), eq(schema.ads.company, 'Seaside Collection GmbH & Co. KG')),
        ),
    );
    expect(ad?.facts.pay).toBe(3917);
    expect(ad?.wording.Pay?.quote).toBe('47.000 € - 69.500 €');
    // Xing links are per-send tracking tokens, never ad ids (§6.7).
    expect(ad?.externalId).toBeNull();
  });

  it('the ad repeated in a second Xing email dedupes across emails', async () => {
    const beforeRows = await withTenant(db, userId, (tx) =>
      tx
        .select()
        .from(schema.ads)
        .where(and(eq(schema.ads.source, 'Xing'), eq(schema.ads.company, 'ADVERGY GmbH'))),
    );
    const advergyBefore = beforeRows.length;
    expect(advergyBefore).toBeGreaterThan(0);

    const result = await ingest(raw('xing', 'Tchibo'), 'Fullstack · Hamburg');
    expect(result.adsCreated).toBeLessThan(result.extractedCount);

    const afterRows = await withTenant(db, userId, (tx) =>
      tx
        .select()
        .from(schema.ads)
        .where(and(eq(schema.ads.source, 'Xing'), eq(schema.ads.company, 'ADVERGY GmbH'))),
    );
    // "Fullstack-Spezialist (m/w/d) | Hamburg" appears in both emails under
    // different tracking tokens — one ad, two sightings.
    const repeated = afterRows.find((a) => a.title.startsWith('Fullstack-Spezialist'));
    expect(repeated).toBeTruthy();
    const sightings = await withTenant(db, userId, (tx) =>
      tx.select().from(schema.adSightings).where(eq(schema.adSightings.adId, repeated!.id)),
    );
    expect(sightings).toHaveLength(2);
  });
});

describe('the stored corpus feeds the rule engine', () => {
  const ruleset: Ruleset = {
    Shift: { key: 'Shift', severity: 'hard', condition: { noRotating: true, noWeekend: true } },
    German: { key: 'German', severity: 'preference', condition: { maxDemanded: 'B2' } },
    Onsite: { key: 'Onsite', severity: 'preference', condition: { minHomeDays: 2 } },
    Pay: { key: 'Pay', severity: 'hard', condition: { minMonthly: 4000, basis: 'fte' } },
    Contract: { key: 'Contract', severity: 'hard', condition: { permanentOnly: true } },
  };

  it('facts read out of Postgres evaluate without ever touching the emails again (I6)', async () => {
    const stored = await withTenant(db, userId, (tx) => tx.select().from(schema.ads));
    expect(stored.length).toBeGreaterThan(20);

    const verdicts = stored.map((ad) => ({ ad, v: evaluate(ad.facts, ruleset) }));
    const blocked = verdicts.filter(({ v }) => isBlocked(v));
    const passing = verdicts.filter(({ v }) => !isBlocked(v));

    // A hard 4.000 € floor blocks the low bands and passes the high ones.
    expect(blocked.length).toBeGreaterThan(0);
    expect(passing.length).toBeGreaterThan(0);

    // I4 holds at scale: no ad is blocked by a field we never read.
    for (const { ad, v } of blocked) {
      for (const verdict of v.filter((x) => x.state === 'block')) {
        if (verdict.key === 'Pay') expect(ad.facts.pay).not.toBeNull();
        if (verdict.key === 'Contract') expect(ad.facts.permanent).not.toBeNull();
      }
    }
  });
});

describe('failure surfaces', () => {
  it('an unknown layout is recorded as such, never as a confident zero (§5.3)', async () => {
    const synthetic = Buffer.from(
      [
        'From: jobs@mail.xing.com',
        'To: nico@example.com',
        'Subject: Neue Jobs fuer dich',
        'Message-ID: <unknown-layout@test>',
        'Date: Tue, 28 Jul 2026 08:14:00 +0000',
        'Content-Type: text/html; charset=utf-8',
        '',
        '<html><body><main><section><p>Alles im Header-Bild</p></section></main></body></html>',
      ].join('\r\n'),
      'utf8',
    );
    const result = await ingest(synthetic);
    expect(result.outcome).toBe('unknown_layout');
    expect(result.causeCode).toBe('unknown_layout');
    expect(result.adsCreated).toBe(0);

    const [parse] = await withTenant(db, userId, (tx) =>
      tx
        .select()
        .from(schema.emailParses)
        .where(eq(schema.emailParses.rawEmailId, result.rawEmailId)),
    );
    expect(parse?.outcome).toBe('unknown_layout');
  });

  it('an email with no text part at all is a no_text_part failure, not a silent zero', async () => {
    const imageOnly = Buffer.from(
      [
        'From: jobs@mail.xing.com',
        'To: nico@example.com',
        'Subject: Ihr Job-Alarm',
        'Message-ID: <image-only@test>',
        'Date: Tue, 28 Jul 2026 08:14:00 +0000',
        'Content-Type: image/png; name="alert.png"',
        'Content-Transfer-Encoding: base64',
        'Content-Disposition: attachment; filename="alert.png"',
        '',
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
      ].join('\r\n'),
      'utf8',
    );
    const result = await ingest(imageOnly);
    expect(result.outcome).toBe('none');
    expect(result.causeCode).toBe('no_text_part');
  });
});
