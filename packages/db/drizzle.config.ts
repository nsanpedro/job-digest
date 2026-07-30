import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/schema.ts',
  out: './migrations',
  // Roles are part of the schema: RLS policies reference them (design §2).
  entities: { roles: true },
});
