/**
 * Tenant scoping for the worker (design §2).
 *
 * The worker processes many tenants in one process, so it scopes itself per
 * unit of work rather than per connection. Both statements are
 * transaction-local: `SET LOCAL ROLE` drops owner privileges for the
 * transaction so RLS actually applies (a table owner bypasses policies), and
 * set_config(..., true) sets the tenant the policies compare against.
 *
 * Running the body inside one transaction is what makes an ingested email
 * all-or-nothing: a failure halfway through never leaves an email recorded
 * as parsed with no ads.
 */
import { sql } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';

export type Db = PostgresJsDatabase<Record<string, unknown>>;
export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

export async function withTenant<T>(
  db: Db,
  userId: string,
  fn: (tx: Tx) => Promise<T>,
): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`SET LOCAL ROLE worker`);
    await tx.execute(sql`SELECT set_config('app.user_id', ${userId}, true)`);
    return fn(tx);
  });
}
