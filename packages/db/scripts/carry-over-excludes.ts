/**
 * One-time repair for ADR-003 §8.13: moves dismissal excludes saved on a
 * direction outside the user's active profile version onto the active
 * version's directions — the same `carryOverExcludes` that
 * `completeDerivation` runs, applied to the version that is already active.
 *
 * Why it exists: before §8.13 every profile version's directions were read,
 * so the dismiss follow-up could save a word on a direction a newer
 * derivation had already replaced. Once only the active version is read,
 * such a word stops applying until the user's next CV analysis carries it.
 * This carries it now. Idempotent — a second run moves nothing.
 *
 * Run with (tsx, not --experimental-strip-types: the query modules
 * value-import extensionless):
 *   DATABASE_URL=... npx tsx packages/db/scripts/carry-over-excludes.ts [--dry-run]
 *
 * Each user runs in their own transaction as `app_user` with the tenant set,
 * like the web app's `withTenant`. `--dry-run` prints the plan and rolls back.
 */
import { and, eq, ne, sql } from 'drizzle-orm';
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { carryOverExcludes } from '../src/queries/feedback';
import { directions, feedbackEffects, profiles } from '../src/schema';

const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL is not set');
const dryRun = process.argv.includes('--dry-run');

const client = postgres(url, { max: 1 });
const db = drizzle(client);

// Users with at least one exclude on a direction outside their active version.
const affected = await db
  .selectDistinct({ userId: feedbackEffects.userId, version: profiles.version })
  .from(feedbackEffects)
  .innerJoin(directions, eq(directions.id, feedbackEffects.directionId))
  .innerJoin(profiles, and(eq(profiles.userId, feedbackEffects.userId), eq(profiles.isActive, true)))
  .where(and(eq(feedbackEffects.kind, 'exclude_term'), ne(directions.profileVersion, profiles.version)));

console.log(`${affected.length} user(s) with excludes outside their active version${dryRun ? ' (dry run)' : ''}`);

class DryRun extends Error {}
for (const { userId, version } of affected) {
  try {
    await db.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL ROLE app_user`);
      await tx.execute(sql`SELECT set_config('app.user_id', ${userId}, true)`);
      const plan = await carryOverExcludes(tx as unknown as PostgresJsDatabase, userId, version);
      console.log(
        `  ${userId} → v${version}: carried [${plan.carry.map((c) => c.value).join(', ')}]` +
          ` held [${plan.held.map((h) => (h.coveredBy ? `${h.value} (covered by ${h.coveredBy})` : h.value)).join(', ')}]`,
      );
      if (dryRun) throw new DryRun();
    });
  } catch (err) {
    if (!(err instanceof DryRun)) throw err;
  }
}

await client.end();
