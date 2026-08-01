/**
 * Which fields each platform's alert emails ever contain (design §9) — global
 * reference data, not per-tenant, and small enough (one row per platform) to
 * read whole rather than filter.
 *
 * This is what lets the UI say "LinkedIn doesn't send salary" instead of a
 * uniform "not read" for a field that was never coming regardless of parser
 * quality. An unseeded platform, or an unseeded field on a seeded platform,
 * means exactly what it says: nobody has recorded evidence either way yet —
 * that stays "not read", the same honest default as everything else I4
 * governs. See migration 0007 for what evidence backs each seeded value.
 */
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { platformCapabilities } from '../schema';
import type { Platform } from './types';

type Db = PostgresJsDatabase<Record<string, unknown>>;

export type PlatformCapabilities = Partial<Record<Platform, Record<string, boolean>>>;

export async function getPlatformCapabilities(db: Db): Promise<PlatformCapabilities> {
  const rows = await db.select().from(platformCapabilities);
  const out: PlatformCapabilities = {};
  for (const row of rows) out[row.platform as Platform] = row.fields;
  return out;
}
