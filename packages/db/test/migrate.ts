/**
 * Brings a fresh test database to the schema production runs.
 *
 * drizzle's migrator only applies what `meta/_journal.json` lists (0000–0011
 * and 0015). Migrations 0012+ are hand-written and applied to Supabase
 * directly, so `migrate()` alone leaves the database behind `schema.ts` and
 * every drizzle insert into a table with a newer column fails. This applies
 * the journal first, then every numbered .sql file the journal does not
 * list, in filename order, split on drizzle's statement breakpoints —
 * the same statements, in the same order, that production received.
 */
import { readdirSync, readFileSync } from 'node:fs';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import type postgres from 'postgres';

const MIGRATIONS = new URL('../migrations/', import.meta.url);

export async function migrateToHead(db: PostgresJsDatabase<Record<string, unknown>>, client: postgres.Sql) {
  await migrate(db, { migrationsFolder: MIGRATIONS.pathname });

  const journal = JSON.parse(readFileSync(new URL('meta/_journal.json', MIGRATIONS), 'utf8')) as {
    entries: Array<{ tag: string }>;
  };
  const journaled = new Set(journal.entries.map((e) => `${e.tag}.sql`));
  const handWritten = readdirSync(MIGRATIONS)
    .filter((f) => /^\d{4}_.+\.sql$/.test(f) && !journaled.has(f))
    .sort();

  for (const file of handWritten) {
    const statements = readFileSync(new URL(file, MIGRATIONS), 'utf8')
      .split('--> statement-breakpoint')
      .map((s) => s.trim())
      .filter((s) => s.replace(/^--.*$/gm, '').trim().length > 0);
    for (const statement of statements) await client.unsafe(statement);
  }
}
