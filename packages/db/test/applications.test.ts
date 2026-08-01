/**
 * Application tracking against a real Postgres via Testcontainers.
 *
 * The claims worth pinning here are the two invariants the feature introduced,
 * because both are the kind a well-meaning refactor breaks:
 *
 * - **I16** — a record survives a rule change that would now block its ad, and
 *   survives the user dismissing it. The applications view is not a filtered
 *   view of the digest.
 * - **status is derived, never stored** — the table is append-only, so the
 *   latest event decides, and inserting an older event out of order must not
 *   change the answer.
 *
 * I15 (user-asserted, never inferred) is not testable as a behaviour here:
 * it is a statement about what the system does *not* do, and the assertion
 * that holds it up lives in the worker's I14 allowlist test.
 */
import { applyMode, DEFAULT_RULESET } from '@job-digest/core';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { eq } from 'drizzle-orm';
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getApplicationCounts, getApplications } from '../src/queries/applications';
import { getActiveRuleset } from '../src/queries/ruleset';
import type { ApplicationStatus } from '../src/queries/types';
import * as schema from '../src/schema';

let container: StartedPostgreSqlContainer;
let client: postgres.Sql;
let db: PostgresJsDatabase<typeof schema>;
let userId: string;
let adId: string;

const DAY = 24 * 60 * 60 * 1000;

/** Passes the default ruleset comfortably: 2900 €, permanent, B2, 2 home days. */
const PASSING_FACTS = {
  rotating: false,
  weekend: false,
  german: 'B2' as const,
  home: 2,
  pay: 2900,
  payMax: null,
  payFte: null,
  fteNote: null,
  permanent: true,
  commuteMin: null,
};

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:17-alpine').start();
  client = postgres(container.getConnectionUri(), { max: 1 });
  db = drizzle(client, { schema });
  await migrate(db, { migrationsFolder: new URL('../migrations', import.meta.url).pathname });

  const [account] = await db.insert(schema.accounts).values({ email: 'a@example.com' }).returning();
  userId = account!.id;

  await db.insert(schema.rulesets).values({
    userId,
    version: 1,
    rules: DEFAULT_RULESET,
    isActive: true,
  });

  const [ad] = await db
    .insert(schema.ads)
    .values({
      userId,
      dedupeKey: 'ad-1',
      title: 'Sachbearbeitung Kundenservice',
      company: 'Kontor Nord',
      source: 'LinkedIn',
      facts: PASSING_FACTS,
      wording: {} as never,
      firstSeenAt: new Date(),
      lastSeenAt: new Date(),
    })
    .returning({ id: schema.ads.id });
  adId = ad!.id;
}, 180_000);

afterAll(async () => {
  await client?.end();
  await container?.stop();
});

const addEvent = (status: ApplicationStatus, at: Date) =>
  db.insert(schema.applicationEvents).values({ userId, adId, status, at });

describe('status is derived from the latest event', () => {
  it('a single event decides the status', async () => {
    await addEvent('applied', new Date(Date.now() - 20 * DAY));
    const [app] = await getApplications(db, userId);
    expect(app?.status).toBe('applied');
    expect(app?.events).toHaveLength(1);
  });

  it('a later event wins, and the timeline keeps both', async () => {
    await addEvent('interviewing', new Date(Date.now() - 2 * DAY));
    const [app] = await getApplications(db, userId);
    expect(app?.status).toBe('interviewing');
    expect(app?.events.map((e) => e.status)).toEqual(['interviewing', 'applied']);
  });

  it('an event inserted out of order does not become the status', async () => {
    // Backdated between the two existing events: appended last, but not latest.
    await addEvent('applied', new Date(Date.now() - 10 * DAY));
    const [app] = await getApplications(db, userId);
    expect(app?.status).toBe('interviewing');
    expect(app?.events).toHaveLength(3);
  });

  it('the first applied event is what firstAppliedAt reports', async () => {
    const [app] = await getApplications(db, userId);
    const daysAgo = Math.round((Date.now() - app!.firstAppliedAt.getTime()) / DAY);
    expect(daysAgo).toBe(20);
  });
});

describe('the follow-up clock (I15 — elapsed time, never a claim about the employer)', () => {
  it('measures from the latest event, not from the application', async () => {
    const [app] = await getApplications(db, userId);
    expect(app?.daysSinceLastEvent).toBe(2);
    expect(app?.needsFollowUp).toBe(false);
  });

  it('fires once the silence is long enough', async () => {
    const now = new Date(Date.now() + 30 * DAY);
    const [app] = await getApplications(db, userId, { now });
    expect(app?.needsFollowUp).toBe(true);
  });

  it('a terminal status stops the clock rather than deleting anything', async () => {
    await addEvent('rejected', new Date());
    const now = new Date(Date.now() + 90 * DAY);
    const [app] = await getApplications(db, userId, { now });
    expect(app?.status).toBe('rejected');
    expect(app?.open).toBe(false);
    expect(app?.needsFollowUp).toBe(false);
    // Still fully present — the record is the point.
    expect(app?.events).toHaveLength(4);

    const counts = await getApplicationCounts(db, userId);
    expect(counts).toEqual({ total: 1, open: 0, needingFollowUp: 0 });
  });
});

describe('I16 — an application record is never filtered', () => {
  it('survives a ruleset that now blocks the ad outright', async () => {
    // Raise the pay floor far above the ad's 2900 €, as a hard rule: in the
    // digest this ad is now filtered out entirely.
    await db.update(schema.rulesets).set({ isActive: false });
    await db.insert(schema.rulesets).values({
      userId,
      version: 2,
      rules: {
        ...DEFAULT_RULESET,
        Pay: { key: 'Pay', severity: 'hard', condition: { minMonthly: 9000, basis: 'fte' } },
      },
      isActive: true,
    });

    const { rules } = await getActiveRuleset(db, userId);
    const apps = await getApplications(db, userId);
    expect(apps).toHaveLength(1);
    // The verdicts still say it fails — the record is not pretending otherwise,
    // it simply is not filtered by them.
    expect(apps[0]?.verdicts.find((v) => v.key === 'Pay')?.state).toBe('block');
    expect(rules.Pay.severity).toBe('hard');
  });

  it('survives the user dismissing the ad', async () => {
    await db.insert(schema.adUserState).values({ userId, adId, dismissedAt: new Date() });
    const apps = await getApplications(db, userId);
    expect(apps).toHaveLength(1);
  });
});

describe('search mode reaches every read path (design §7.7)', () => {
  it('urgent mode makes the blocking rule stop blocking, without moving the threshold', async () => {
    await db.update(schema.rulesets).set({ mode: 'urgent' }).where(eq(schema.rulesets.isActive, true));
    const { rules, savedRules, mode } = await getActiveRuleset(db, userId);

    expect(mode).toBe('urgent');
    expect(savedRules.Pay.severity).toBe('hard');
    expect(rules.Pay.severity).toBe('preference');
    // The number the user authored is untouched in both.
    expect(rules.Pay.condition).toEqual(savedRules.Pay.condition);
    expect(rules).toEqual(applyMode(savedRules, 'urgent'));

    const apps = await getApplications(db, userId);
    expect(apps[0]?.verdicts.find((v) => v.key === 'Pay')?.state).toBe('warn');
  });
});
