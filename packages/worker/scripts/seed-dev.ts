// Dev-only: build a realistic digest by ingesting the actual fixture corpus
// (design §14 — real emails, not invented ones) and activating a ruleset
// mirroring the prototype's DEFAULT_CFG. Idempotent: re-running against an
// already-seeded db converges rather than duplicating (I1, I2).
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Ruleset } from '@job-digest/core';
import { accounts, mailboxes, rulesets, runs } from '@job-digest/db';
import { and, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { ingestEmail, withTenant, PARSER_VERSION } from '../src/index';

const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL is not set');

const SEED_EMAIL = 'nico@example.com';

// Mirrors the prototype's DEFAULT_CFG (Job Digest.dc.html) exactly.
const DEFAULT_RULES: Ruleset = {
  Shift: { key: 'Shift', severity: 'hard', condition: { noRotating: true, noWeekend: true } },
  German: { key: 'German', severity: 'preference', condition: { maxDemanded: 'B2' } },
  Onsite: { key: 'Onsite', severity: 'preference', condition: { minHomeDays: 2 } },
  Pay: { key: 'Pay', severity: 'hard', condition: { minMonthly: 2600, basis: 'fte' } },
  Contract: { key: 'Contract', severity: 'preference', condition: { permanentOnly: true } },
};

const client = postgres(url, { max: 1 });
const db = drizzle(client);

async function main() {
  const [account] = await db
    .insert(accounts)
    .values({ email: SEED_EMAIL })
    .onConflictDoUpdate({ target: accounts.email, set: { email: SEED_EMAIL } })
    .returning();
  const userId = account!.id;
  console.log('account', userId);

  let mailbox = (
    await db.select().from(mailboxes).where(eq(mailboxes.userId, userId)).limit(1)
  )[0];
  if (!mailbox) {
    [mailbox] = await db
      .insert(mailboxes)
      .values({
        userId,
        provider: 'gmail',
        authKind: 'app_password',
        emailAddress: SEED_EMAIL,
        status: 'active',
      })
      .returning();
  }
  const mailboxId = mailbox!.id;

  const now = new Date();
  const [run] = await db
    .insert(runs)
    .values({
      userId,
      mailboxId,
      parserVersion: PARSER_VERSION,
      status: 'ok',
      finishedAt: now,
    })
    .returning();
  const runId = run!.id;

  const fixturesRoot = new URL('../../ingest/test/fixtures', import.meta.url).pathname;
  let emailsProcessed = 0;
  for (const platform of ['linkedin', 'xing']) {
    const dir = join(fixturesRoot, platform);
    for (const file of readdirSync(dir).filter((f) => f.endsWith('.eml'))) {
      const buf = readFileSync(join(dir, file));
      const result = await withTenant(db, userId, (tx) =>
        ingestEmail(tx, { userId, mailboxId, runId, raw: buf }),
      );
      emailsProcessed++;
      console.log(
        `  ${platform}/${file.slice(0, 40)} → ${result.outcome}, ${result.adsCreated} new / ${result.extractedCount} extracted`,
      );
    }
  }

  await db
    .update(runs)
    .set({ emailsTotal: emailsProcessed, emailsProcessed })
    .where(eq(runs.id, runId));

  const active = await db
    .select()
    .from(rulesets)
    .where(and(eq(rulesets.userId, userId), eq(rulesets.isActive, true)))
    .limit(1);
  if (active.length === 0) {
    await db.insert(rulesets).values({ userId, version: 1, rules: DEFAULT_RULES, isActive: true });
    console.log('activated default ruleset (v1)');
  } else {
    console.log('ruleset already active, left untouched');
  }

  console.log('\nseeded user:', userId);
}

await main();
await client.end();
