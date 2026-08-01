/**
 * The digest read model over the real corpus: ingest actual .eml fixtures,
 * then read the dashboard's view of them out of Postgres (design, screens 1
 * and 2). Lives in the worker package because it needs the ingestor to build
 * the corpus first.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import type { Ruleset } from '@job-digest/core';
import * as schema from '@job-digest/db';
import {
  getDigest,
  getUnreadEmails,
  NoActiveRulesetError,
  weekWindow,
} from '@job-digest/db';
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

/** The fixtures were received Tue 28 Jul 2026; this is that Mon–Sun week. */
const NOW = new Date('2026-07-30T09:00:00Z');

const fixtures = new URL('../../ingest/test/fixtures', import.meta.url).pathname;
const raw = (platform: string, prefix: string): Buffer => {
  const dir = join(fixtures, platform);
  const file = readdirSync(dir).find((f) => f.startsWith(prefix) && f.endsWith('.eml'));
  if (!file) throw new Error(`fixture ${platform}/${prefix}* not found`);
  return readFileSync(join(dir, file));
};

const RULES: Ruleset = {
  Shift: { key: 'Shift', severity: 'hard', condition: { noRotating: true, noWeekend: true } },
  German: { key: 'German', severity: 'preference', condition: { maxDemanded: 'B2' } },
  Onsite: { key: 'Onsite', severity: 'preference', condition: { minHomeDays: 2 } },
  Pay: { key: 'Pay', severity: 'hard', condition: { minMonthly: 4500, basis: 'fte' } },
  Contract: { key: 'Contract', severity: 'hard', condition: { permanentOnly: true } },
};

beforeAll(async () => {
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
      provider: 'gmail',
      authKind: 'app_password',
      emailAddress: 'nico@example.com',
      status: 'active',
    })
    .returning();
  mailboxId = mailbox!.id;
  const [run] = await db
    .insert(schema.runs)
    .values({
      userId,
      mailboxId,
      parserVersion: PARSER_VERSION,
      status: 'ok',
      emailsTotal: 3,
      emailsProcessed: 3,
      finishedAt: NOW,
    })
    .returning();
  runId = run!.id;

  for (const [platform, prefix] of [
    ['xing', 'SOMI'],
    ['xing', 'Tchibo'],
    ['linkedin', 'Senior Frontend Engineer en Joppy'],
  ] as const) {
    await withTenant(db, userId, (tx) =>
      ingestEmail(tx, { userId, mailboxId, runId, raw: raw(platform, prefix) }),
    );
  }
}, 240_000);

afterAll(async () => {
  await client?.end();
  await container?.stop();
});

describe('getDigest', () => {
  it('refuses to render an unconfigured account as an empty digest', async () => {
    await expect(getDigest(db, userId, { now: NOW })).rejects.toBeInstanceOf(NoActiveRulesetError);
  });

  it('splits the corpus into visible and rule-filtered under an active ruleset', async () => {
    await db.insert(schema.rulesets).values({ userId, version: 1, rules: RULES, isActive: true });
    const digest = await getDigest(db, userId, { now: NOW });

    expect(digest.rulesetVersion).toBe(1);
    expect(digest.metrics.adsReceived).toBeGreaterThan(20);
    expect(digest.visible.length).toBeGreaterThan(0);
    expect(digest.metrics.filteredByRule).toBeGreaterThan(0);
    expect(digest.visible.length + digest.dismissed.length).toBe(digest.metrics.adsReceived);
    expect(digest.metrics.passing).toBe(digest.visible.length);
  });

  it('every filtered ad names the rule that fired, and no ad is filtered on an unread field (I4)', async () => {
    const digest = await getDigest(db, userId, { now: NOW });
    const byRule = digest.dismissed.filter((d) => d.reason.kind === 'rule');
    expect(byRule.length).toBeGreaterThan(0);
    for (const ad of byRule) {
      if (ad.reason.kind !== 'rule') continue;
      expect(ad.reason.blockers.length).toBeGreaterThan(0);
      for (const blocker of ad.reason.blockers) {
        expect(blocker.state).toBe('block');
        // A block is always a proven failure, never a missing fact.
        expect(blocker.because.some((s) => s.kind === 'unread')).toBe(false);
      }
    }
  });

  it('carries the ad wording so the UI can quote the German next to each verdict', async () => {
    const digest = await getDigest(db, userId, { now: NOW });
    const withPay = [...digest.visible, ...digest.dismissed].find((a) => a.wording.Pay);
    expect(withPay?.wording.Pay?.quote).toMatch(/€/);
    expect(withPay?.verdicts).toHaveLength(5);
  });

  it('carries platform_capabilities so the UI can tell "not sent" from "not read" (design §9, migration 0007)', async () => {
    const digest = await getDigest(db, userId, { now: NOW });
    const all = [...digest.visible, ...digest.dismissed];
    // Real, seeded claims: LinkedIn never sends salary, Xing does.
    expect(all.find((a) => a.source === 'LinkedIn')?.platformFields['pay']).toBe(false);
    expect(all.find((a) => a.source === 'Xing')?.platformFields['pay']).toBe(true);
    // Shift is deliberately unseeded (no evidence either way) — absent, not false.
    expect(all[0]?.platformFields['shift']).toBeUndefined();
  });

  it('a rule change re-splits the same stored ads without re-reading any email (I6)', async () => {
    const strict = await getDigest(db, userId, { now: NOW });

    await db
      .update(schema.rulesets)
      .set({ isActive: false })
      .where(and(eq(schema.rulesets.userId, userId), eq(schema.rulesets.version, 1)));
    await db.insert(schema.rulesets).values({
      userId,
      version: 2,
      rules: { ...RULES, Pay: { ...RULES.Pay, condition: { minMonthly: 2000, basis: 'fte' } } },
      isActive: true,
    });

    const loose = await getDigest(db, userId, { now: NOW });
    expect(loose.rulesetVersion).toBe(2);
    expect(loose.visible.length).toBeGreaterThan(strict.visible.length);
    expect(loose.metrics.adsReceived).toBe(strict.metrics.adsReceived);
  });

  it('a user dismissal outranks the rule outcome and sorts to the top (I10)', async () => {
    const before = await getDigest(db, userId, { now: NOW });
    const target = before.visible[0]!;

    await db.insert(schema.adUserState).values({
      adId: target.id,
      userId,
      dismissedAt: NOW,
    });

    const after = await getDigest(db, userId, { now: NOW });
    expect(after.visible.find((a) => a.id === target.id)).toBeUndefined();
    expect(after.metrics.dismissedByUser).toBe(1);
    expect(after.dismissed[0]?.id).toBe(target.id);
    expect(after.dismissed[0]?.reason.kind).toBe('user');
  });

  it('an override puts a rule-blocked ad back in the list', async () => {
    // Back to a strict floor: the previous test loosened Pay until nothing
    // blocked, which is the correct outcome there and no setup for this one.
    await db
      .update(schema.rulesets)
      .set({ isActive: false })
      .where(and(eq(schema.rulesets.userId, userId), eq(schema.rulesets.version, 2)));
    await db
      .insert(schema.rulesets)
      .values({ userId, version: 3, rules: RULES, isActive: true });

    const before = await getDigest(db, userId, { now: NOW });
    const blocked = before.dismissed.find((d) => d.reason.kind === 'rule')!;
    expect(blocked).toBeTruthy();

    await db
      .insert(schema.adUserState)
      .values({ adId: blocked.id, userId, overriddenAt: NOW, overrideRulesetVersion: 3 })
      .onConflictDoUpdate({
        target: schema.adUserState.adId,
        set: { overriddenAt: NOW, overrideRulesetVersion: 3 },
      });

    const after = await getDigest(db, userId, { now: NOW });
    expect(after.visible.find((a) => a.id === blocked.id)).toBeTruthy();
    expect(after.metrics.filteredByRule).toBe(before.metrics.filteredByRule - 1);
  });

  it('reports off-target as null rather than inventing the number (§13)', async () => {
    const digest = await getDigest(db, userId, { now: NOW });
    expect(digest.metrics.offTarget).toBeNull();
  });

  it('an empty window returns an empty digest, not an error', async () => {
    const digest = await getDigest(db, userId, { now: new Date('2020-01-08T09:00:00Z') });
    expect(digest.metrics.adsReceived).toBe(0);
    expect(digest.visible).toHaveLength(0);
  });
});

describe('parse summary', () => {
  it('counts what was read and does not count newsletters as failures (§6.2)', async () => {
    const digest = await getDigest(db, userId, { now: NOW });
    // Three emails were ingested, but the Tchibo digest arrived in June 2025:
    // the window counts what this week actually read, not the whole corpus.
    expect(digest.parse.emailsRead).toBe(2);
    expect(digest.parse.emailsNotFullyRead).toBe(0);
    expect(digest.parse.platforms.sort()).toEqual(['LinkedIn', 'Xing']);
    expect(digest.parse.lastRunFailed).toBe(false);
    expect(digest.parse.lastRunAt).not.toBeNull();
  });

  it('surfaces an unknown layout and the ads it cost', async () => {
    const unknownLayout = Buffer.from(
      [
        'From: jobs@mail.xing.com',
        'To: nico@example.com',
        'Subject: Ihr Job-Alarm: 4 neue Stellen in Hamburg',
        'Message-ID: <redesign@test>',
        'Date: Wed, 29 Jul 2026 08:14:00 +0000',
        'Content-Type: text/html; charset=utf-8',
        '',
        '<html><body><main><article><p>Alles im Bild</p></article></main></body></html>',
      ].join('\r\n'),
      'utf8',
    );
    await withTenant(db, userId, (tx) =>
      ingestEmail(tx, { userId, mailboxId, runId, raw: unknownLayout }),
    );

    const digest = await getDigest(db, userId, { now: NOW });
    expect(digest.parse.emailsNotFullyRead).toBe(1);
    expect(digest.parse.hasUnknownLayout).toBe(true);
    // StepStone's subject grammar declared 4; none were read (I3).
    expect(digest.parse.adsUnaccountedFor).toBe(0);
  });
});

describe('getUnreadEmails — screen 2', () => {
  it('lists only emails that were not fully read, with an assembled status line', async () => {
    const unread = await getUnreadEmails(db, userId, weekWindow(NOW));
    expect(unread).toHaveLength(1);
    const card = unread[0]!;
    expect(card.source).toBe('Xing');
    expect(card.outcome).toBe('unknown_layout');
    expect(card.causeCode).toBe('unknown_layout');
    expect(card.status).toBe('This layout is new — nothing read yet');
    expect(card.inDigest).toBe(false);
  });

  it('an email whose ads reached the digest is marked as such', async () => {
    // A real LinkedIn email with two headers rewritten in place: the subject
    // declares 10 while the body carries 6, and a fresh Message-ID makes it a
    // new email. Rewriting headers rather than re-assembling MIME keeps the
    // transfer encoding and the body bytes exactly as LinkedIn sent them —
    // rebuilding the envelope by hand corrupts the layout and the email
    // arrives as an unknown layout instead of the partial read under test.
    const partial = Buffer.from(
      raw('linkedin', 'Senior Frontend Engineer - ZEOS')
        .toString('utf8')
        .replace(/^Subject:.*$/m, 'Subject: 10 neue Jobs fuer Bueromanagement')
        .replace(/^Message-ID:.*$/m, 'Message-ID: <partial-declared-10@test>'),
      'utf8',
    );
    await withTenant(db, userId, (tx) =>
      ingestEmail(tx, { userId, mailboxId, runId, raw: partial }),
    );

    const unread = await getUnreadEmails(db, userId, weekWindow(NOW));
    const linkedInCard = unread.find((u) => u.source === 'LinkedIn');
    expect(linkedInCard).toBeTruthy();
    // Declared 10, the email carries 6 — a visible, quantified shortfall (I3).
    expect(linkedInCard?.outcome).toBe('partial');
    expect(linkedInCard?.declaredCount).toBe(10);
    expect(linkedInCard?.status).toBe('6 of 10 ads read');
    expect(linkedInCard?.inDigest).toBe(true);
  });
});
