// Dev-only: run migrations against DATABASE_URL. CI/prod would drive this
// through a proper deploy step; this is the local iteration loop.
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';

const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL is not set');

const client = postgres(url, { max: 1 });
const db = drizzle(client);
await migrate(db, { migrationsFolder: new URL('../migrations', import.meta.url).pathname });
await client.end();
console.log('migrated');
