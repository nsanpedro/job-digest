/**
 * Stand-in for real auth. There is no login/session system yet — the design
 * doc's login screen (mailbox OAuth/IMAP connect) is a different concern from
 * "who is the signed-in user," and neither is built. This resolves the one
 * seeded dev account by email so every page has a userId to scope RLS with.
 *
 * Replace when real sessions exist; every call site already takes userId as
 * a parameter, so nothing downstream changes.
 */
import { eq } from 'drizzle-orm';
import { accounts } from '@job-digest/db';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { withTenant } from './db';

const DEV_USER_EMAIL = process.env.DEV_USER_EMAIL ?? 'nico@example.com';

// Deliberately not cached across requests. A module-level cache survived a
// dev database reset once already — after `docker rm` + re-seed, the
// long-running Next.js process kept resolving to an account id from the
// dropped database, which reads as a mysterious "no rules configured"
// instead of the actual cause. The query is one indexed lookup; correctness
// during dev iteration matters more than saving it.
export async function currentUserId(): Promise<string> {
  // Looking up "who am I" cannot itself be tenant-scoped (RLS needs the
  // answer first), so this one query runs as the pool owner, read-only,
  // against a single indexed column.
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is not set');
  const client = postgres(url, { max: 1 });
  const db = drizzle(client);
  const rows = await db.select({ id: accounts.id }).from(accounts).where(eq(accounts.email, DEV_USER_EMAIL));
  await client.end();

  const row = rows[0];
  if (!row) {
    throw new Error(
      `no seeded account for ${DEV_USER_EMAIL} — run: npx tsx packages/worker/scripts/seed-dev.ts`,
    );
  }
  return row.id;
}

export { withTenant };
