/**
 * Web-process database access (design §2). Every read runs inside
 * withTenant(), which drops to the `app_user` role and sets the RLS scope —
 * the app never queries as the pool owner, so a bug here cannot leak across
 * tenants no matter what the query says.
 *
 * This mirrors @job-digest/worker's withTenant but scopes to `app_user`
 * instead of `worker`: the two roles differ in exactly one privilege (I13 —
 * app_user cannot SELECT mailboxes.credentials_enc), so they cannot share one
 * helper without threading the role through every call site.
 */
import { sql } from 'drizzle-orm';
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';

const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL is not set');

// A small pool is enough for the read path (design §11) — a handful of page
// loads a week per user, not a request-per-tenant fan-out.
const client = postgres(url, { max: 5 });
const pool = drizzle(client);

export type Db = PostgresJsDatabase<Record<string, unknown>>;
type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

export async function withTenant<T>(userId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return pool.transaction(async (tx) => {
    await tx.execute(sql`SET LOCAL ROLE app_user`);
    await tx.execute(sql`SELECT set_config('app.user_id', ${userId}, true)`);
    return fn(tx);
  });
}

/**
 * The raw pool, for the one legitimate reason to bypass this file's own
 * app_user scoping: handing it to @job-digest/worker's withTenant (the
 * `worker` role) when a flow needs to read mailboxes.credentials_enc, which
 * app_user cannot even SELECT (I13). SET LOCAL ROLE is transaction-scoped,
 * so reusing this pool for both roles is safe — no session-level leakage
 * between an app_user transaction and a worker transaction.
 */
export function rawPool(): Db {
  return pool;
}
