import { and, desc, ilike, isNull, or, sql } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { accounts, onboardingCache } from '../schema';

type Db = PostgresJsDatabase<Record<string, unknown>>;

export interface OnboardingJob {
  provider: string;
  slug: string;
  displayName: string;
  title: string;
  locationRaw: string | null;
  externalUrl: string;
  postedAt: Date | null;
}

export const CATEGORY_KEYWORDS: Record<string, string[]> = {
  Product: ['Product Manager', 'Product Owner', 'Head of Product', 'CPO', ' PM'],
  Design: ['Designer', 'UX', 'UI ', 'Visual', 'Brand', 'Graphic', 'Art Director', 'Creative'],
  Engineering: ['Engineer', 'Developer', 'Fullstack', 'Backend', 'Frontend', 'Staff', 'Principal'],
  Marketing: ['Marketing', 'Growth', 'SEO', 'Content', 'CRM', 'Performance'],
  Data: ['Data', 'Analytics', 'Analyst', 'Scientist', ' ML ', 'Machine Learning'],
  Operations: ['Operations', 'Program Manager', 'Project Manager', 'COO'],
  Sales: ['Sales', 'Account', 'Business Development', 'BDR', 'SDR'],
};

export async function getOnboardingPreview(
  db: Db,
  category: string,
  city: string | null,
  remoteOk: boolean,
): Promise<OnboardingJob[]> {
  const keywords = CATEGORY_KEYWORDS[category] ?? [];

  const titleConditions = keywords.map((kw) => ilike(onboardingCache.title, `%${kw}%`));
  const titleCond = titleConditions.length > 0 ? or(...titleConditions) : sql`true`;

  const locationParts = [];
  if (city) locationParts.push(ilike(onboardingCache.locationRaw, `%${city}%`));
  if (remoteOk) {
    locationParts.push(ilike(onboardingCache.locationRaw, '%remote%'));
    if (city) locationParts.push(isNull(onboardingCache.locationRaw));
  }
  const locationCond = locationParts.length > 0 ? or(...locationParts) : sql`true`;

  return db
    .select({
      provider: onboardingCache.provider,
      slug: onboardingCache.slug,
      displayName: onboardingCache.displayName,
      title: onboardingCache.title,
      locationRaw: onboardingCache.locationRaw,
      externalUrl: onboardingCache.externalUrl,
      postedAt: onboardingCache.postedAt,
    })
    .from(onboardingCache)
    .where(and(titleCond, locationCond))
    .orderBy(desc(onboardingCache.postedAt))
    .limit(12);
}

/** Reads a single column — runs inside withTenant() so RLS scopes to the caller. */
export async function getOnboardingStatus(db: Db): Promise<{ onboardedAt: Date | null }> {
  const rows = await db
    .select({ onboardedAt: accounts.onboardedAt })
    .from(accounts)
    .limit(1);
  return rows[0] ?? { onboardedAt: null };
}
