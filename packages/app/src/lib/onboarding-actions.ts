'use server';

/**
 * Server actions for the onboarding flow.
 *
 * completeOnboarding is the single write path — it atomically sets
 * onboarded_at, creates the initial ruleset (if none exists), and seeds the
 * curated sources for the user's inferred market.
 *
 * connectGmailForOnboarding persists preferences first, then redirects to
 * Google OAuth — if the OAuth flow completes, the user lands on /digest
 * already onboarded.
 */

import { revalidatePath } from 'next/cache';
import { after } from 'next/server';
import { accounts, onboardingCache, rulesets, sources } from '@job-digest/db';
import { DEFAULT_RULESET, rulesetForCategory, type OnboardingCategory } from '@job-digest/core';
import { CURATED_COMPANIES, refreshOnboardingCache } from '@job-digest/worker';
import { signIn } from '@/auth';
import { and, eq, ilike, isNull, or, sql, desc } from 'drizzle-orm';
import { inferMarket } from './market';
import { currentUserId, rawPool, withTenant } from './session';

export type { OnboardingCategory };

// ── Check onboarding state ────────────────────────────────────────────────────

export async function getIsOnboarded(): Promise<boolean> {
  const userId = await currentUserId();
  const rows = await withTenant(userId, (tx) =>
    tx.select({ onboardedAt: accounts.onboardedAt }).from(accounts).limit(1),
  );
  return rows[0]?.onboardedAt != null;
}

// ── Preview ───────────────────────────────────────────────────────────────────

const CATEGORY_KEYWORDS: Record<string, string[]> = {
  Product: ['Product Manager', 'Product Owner', 'Head of Product', 'CPO', ' PM'],
  Design: ['Designer', 'UX', 'UI ', 'Visual', 'Brand', 'Graphic', 'Art Director', 'Creative'],
  Engineering: ['Engineer', 'Developer', 'Fullstack', 'Backend', 'Frontend', 'Staff', 'Principal'],
  Marketing: ['Marketing', 'Growth', 'SEO', 'Content', 'CRM', 'Performance'],
  Data: ['Data', 'Analytics', 'Analyst', 'Scientist', ' ML ', 'Machine Learning'],
  Operations: ['Operations', 'Program Manager', 'Project Manager', 'COO'],
  Sales: ['Sales', 'Account', 'Business Development', 'BDR', 'SDR'],
};

export interface PreviewJob {
  displayName: string;
  title: string;
  locationRaw: string | null;
  externalUrl: string;
}

export async function fetchOnboardingPreview(
  category: string,
  city: string | null,
  remoteOk: boolean,
): Promise<PreviewJob[]> {
  const userId = await currentUserId();
  const keywords = CATEGORY_KEYWORDS[category] ?? [];

  const titleConds = keywords.map((kw) => ilike(onboardingCache.title, `%${kw}%`));
  const titleCond = titleConds.length > 0 ? or(...titleConds) : sql`true`;

  const locationParts = [];
  if (city) locationParts.push(ilike(onboardingCache.locationRaw, `%${city}%`));
  if (remoteOk) {
    locationParts.push(ilike(onboardingCache.locationRaw, '%remote%'));
    if (city) locationParts.push(isNull(onboardingCache.locationRaw));
  }
  const locationCond = locationParts.length > 0 ? or(...locationParts) : sql`true`;

  return withTenant(userId, (tx) =>
    tx
      .select({
        displayName: onboardingCache.displayName,
        title: onboardingCache.title,
        locationRaw: onboardingCache.locationRaw,
        externalUrl: onboardingCache.externalUrl,
      })
      .from(onboardingCache)
      .where(and(titleCond, locationCond))
      .orderBy(desc(onboardingCache.postedAt))
      .limit(12),
  );
}

// ── Core write ────────────────────────────────────────────────────────────────

async function persistOnboarding(params: {
  userId: string;
  category: OnboardingCategory | null;
  city: string | null;
  remoteOk: boolean;
}): Promise<void> {
  const { userId, category, city, remoteOk } = params;
  const market = inferMarket(city);

  await withTenant(userId, async (tx) => {
    await tx
      .update(accounts)
      .set({ onboardedAt: new Date(), category, city, remoteOk })
      .where(eq(accounts.id, userId));

    const existing = await tx
      .select({ id: rulesets.id })
      .from(rulesets)
      .where(and(eq(rulesets.userId, userId), eq(rulesets.isActive, true)))
      .limit(1);

    if (!existing[0]) {
      const rules =
        category != null
          ? rulesetForCategory(category, market === 'DACH' ? 'DACH' : 'other')
          : DEFAULT_RULESET;
      await tx.insert(rulesets).values({ userId, version: 1, rules, isActive: true });
    }

    if (category != null) {
      const companies =
        market === 'ALL'
          ? CURATED_COMPANIES
          : CURATED_COMPANIES.filter((c) => c.markets.includes(market as 'ES' | 'DACH' | 'AR'));

      if (companies.length > 0) {
        await tx
          .insert(sources)
          .values(
            companies.map((c) => ({
              userId,
              provider: c.provider,
              externalSlug: c.slug,
              displayName: c.name,
              status: 'active' as const,
            })),
          )
          .onConflictDoNothing();
      }
    }
  });
}

export async function completeOnboarding(params: {
  category: OnboardingCategory;
  city: string | null;
  remoteOk: boolean;
}): Promise<void> {
  const userId = await currentUserId();
  await persistOnboarding({ userId, ...params });
  revalidatePath('/', 'layout');
}

export async function skipOnboarding(): Promise<void> {
  const userId = await currentUserId();
  await persistOnboarding({ userId, category: null, city: null, remoteOk: false });
  revalidatePath('/', 'layout');
}

export async function connectGmailForOnboarding(params: {
  category: OnboardingCategory;
  city: string | null;
  remoteOk: boolean;
}): Promise<void> {
  const userId = await currentUserId();
  await persistOnboarding({ userId, ...params });
  await signIn('google-gmail', { redirectTo: '/digest' });
}

// ── Admin: rebuild the preview cache ─────────────────────────────────────────

export async function triggerCacheRefresh(): Promise<void> {
  const db = rawPool();
  after(() => refreshOnboardingCache(db));
}
