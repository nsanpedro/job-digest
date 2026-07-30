'use server';

/**
 * Ad state mutations (design, "Interactions & Behavior"). Save/seen/dismiss
 * are instantaneous and reversible per the design's explicit rule for
 * Dismiss — no confirmation step anywhere here.
 *
 * Each action upserts ad_user_state, which is the I10 table: it never
 * touches `ads` (worker-owned) or computes a verdict (I6 — that happens at
 * read time in getDigest). A dismiss or an override is a fact about the
 * user, not a fact about the ad.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { revalidatePath } from 'next/cache';
import type { Ruleset } from '@job-digest/core';
import { adUserState, mailboxes, rulesets, runs } from '@job-digest/db';
import { and, desc, eq } from 'drizzle-orm';
import { ingestEmail, PARSER_VERSION } from '@job-digest/worker';
import { currentUserId, withTenant } from './session';

async function upsertState(adId: string, patch: Partial<typeof adUserState.$inferInsert>) {
  const userId = await currentUserId();
  await withTenant(userId, async (tx) => {
    const existing = await tx.select().from(adUserState).where(eq(adUserState.adId, adId)).limit(1);
    if (existing[0]) {
      await tx.update(adUserState).set(patch).where(eq(adUserState.adId, adId));
    } else {
      await tx.insert(adUserState).values({ adId, userId, ...patch });
    }
  });
  revalidatePath('/digest');
}

export async function toggleSaved(adId: string, next: boolean): Promise<void> {
  await upsertState(adId, { saved: next });
}

export async function toggleSeen(adId: string, next: boolean): Promise<void> {
  await upsertState(adId, { seen: next });
}

export async function dismissAd(adId: string): Promise<void> {
  await upsertState(adId, { dismissedAt: new Date() });
}

export async function undoDismiss(adId: string): Promise<void> {
  await upsertState(adId, { dismissedAt: null });
}

/**
 * "Show anyway" on a rule-blocked ad (design §7.5 / open question 3):
 * restores it to the main list, tagged with the rule that blocked it and the
 * ruleset version in force — the signal that later drives a loosen-this-rule
 * proposal.
 */
export async function overrideRule(adId: string, ruleKey: string, rulesetVersion: number): Promise<void> {
  await upsertState(adId, {
    overriddenAt: new Date(),
    overrideRuleKey: ruleKey,
    overrideRulesetVersion: rulesetVersion,
  });
}

export async function undoOverride(adId: string): Promise<void> {
  await upsertState(adId, { overriddenAt: null, overrideRuleKey: null, overrideRulesetVersion: null });
}

/**
 * "Update now" (design, the four-state refresh button). There is no live
 * IMAP connection to poll yet — real ingestion is a scheduled worker job
 * (design §5.2) — so this stands in by re-running the ingestor over the same
 * fixture corpus the app was seeded with. It exercises the real pipeline
 * (fetch → classify → extract → normalize → persist) end to end, and it is
 * safe to press repeatedly: everything downstream is idempotent (I1, I2),
 * so a re-run converges rather than creating duplicate ads or runs.
 */
export async function refreshDigest(): Promise<{ processed: number; created: number }> {
  const userId = await currentUserId();

  // Explicit columns, not select(): app_user has no grant on
  // mailboxes.credentials_enc (I13), so a bare `SELECT *` is rejected by
  // Postgres, not just discouraged — this is the boundary actually holding.
  const mailbox = await withTenant(userId, (tx) =>
    tx.select({ id: mailboxes.id }).from(mailboxes).where(eq(mailboxes.userId, userId)).limit(1),
  );
  const mailboxId = mailbox[0]?.id;
  if (!mailboxId) throw new Error('no mailbox for this account');

  const run = await withTenant(userId, (tx) =>
    tx.insert(runs).values({ userId, mailboxId, parserVersion: PARSER_VERSION }).returning({ id: runs.id }),
  );
  const runId = run[0]!.id;

  // A plain path.join, not `new URL(..., import.meta.url)`: webpack treats
  // that pattern as a static asset reference and tries to bundle it, which
  // breaks inside a 'use server' action. process.cwd() is packages/app
  // (where `next dev` runs), so this walks to the sibling ingest package.
  const fixturesRoot = join(process.cwd(), '../ingest/test/fixtures');
  let processed = 0;
  let created = 0;
  for (const platform of ['linkedin', 'xing']) {
    const dir = join(fixturesRoot, platform);
    for (const file of readdirSync(dir).filter((f) => f.endsWith('.eml'))) {
      const buf = readFileSync(join(dir, file));
      const result = await withTenant(userId, (tx) => ingestEmail(tx, { userId, mailboxId, runId, raw: buf }));
      processed++;
      created += result.adsCreated;
    }
  }

  await withTenant(userId, (tx) =>
    tx
      .update(runs)
      .set({ status: 'ok', emailsTotal: processed, emailsProcessed: processed, finishedAt: new Date() })
      .where(eq(runs.id, runId)),
  );

  revalidatePath('/digest');
  revalidatePath('/unread');
  return { processed, created };
}

export async function lastRunAt(): Promise<Date | null> {
  const userId = await currentUserId();
  const rows = await withTenant(userId, (tx) =>
    tx
      .select({ finishedAt: runs.finishedAt, startedAt: runs.startedAt })
      .from(runs)
      .where(and(eq(runs.userId, userId), eq(runs.status, 'ok')))
      .orderBy(desc(runs.startedAt))
      .limit(1),
  );
  return rows[0]?.finishedAt ?? rows[0]?.startedAt ?? null;
}

/**
 * Saves a new ruleset version and activates it (design §7.2, §9 — rulesets
 * are versioned so Profile can diff draft against saved and §7.4's rule
 * accountability can replay history under a named version). Never mutates a
 * past version: an edit is a new row, with the old one deactivated in the
 * same transaction.
 *
 * No delta preview yet (design §5's gained/lost ads on save) — that needs
 * re-running getDigest against the draft without persisting it, which is a
 * reasonable next increment, cut from this pass to keep it shippable.
 */
export async function saveRuleset(rules: Ruleset): Promise<void> {
  const userId = await currentUserId();
  await withTenant(userId, async (tx) => {
    const current = await tx
      .select({ version: rulesets.version })
      .from(rulesets)
      .where(eq(rulesets.userId, userId))
      .orderBy(desc(rulesets.version))
      .limit(1);
    const nextVersion = (current[0]?.version ?? 0) + 1;

    await tx.update(rulesets).set({ isActive: false }).where(eq(rulesets.userId, userId));
    await tx.insert(rulesets).values({ userId, version: nextVersion, rules, isActive: true });
  });
  revalidatePath('/digest');
  revalidatePath('/profile');
  revalidatePath('/saved');
  revalidatePath('/dismissed');
}
