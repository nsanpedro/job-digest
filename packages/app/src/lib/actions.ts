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
import {
  generateInboundAddress,
  GmailAuthError,
  ingestEmail,
  ingestFromGmail,
  PARSER_VERSION,
  withTenant as workerWithTenant,
} from '@job-digest/worker';
import { currentUserId, rawPool, withTenant } from './session';

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
 * "Update now" (design, the four-state refresh button).
 *
 * A real Google mailbox fetches for real: Gmail's API, the stored (and only
 * now spent) OAuth refresh token, allowlist-scoped search, one transaction
 * per email through the same ingestEmail() every acquisition path uses. Any
 * other mailbox (the dev seed account's fake app_password one) falls back to
 * re-ingesting the local fixture corpus — there's nothing real to fetch for
 * that account, and the fallback is what makes local development possible
 * without a live Google connection.
 *
 * Reading mailboxes.credentials_enc requires the `worker` DB role (I13) —
 * app_user has no grant on that column at all. That read runs through
 * @job-digest/worker's withTenant (aliased workerWithTenant here to avoid
 * colliding with this file's own app_user-scoped withTenant), on the same
 * connection pool app_user uses elsewhere (SET LOCAL ROLE is
 * transaction-scoped, so sharing the pool across both roles is safe).
 */
export async function refreshDigest(): Promise<{
  processed: number;
  created: number;
  found?: number;
  failed?: number;
}> {
  const userId = await currentUserId();

  // Explicit columns, not select(): app_user has no grant on
  // mailboxes.credentials_enc (I13), so a bare `SELECT *` is rejected by
  // Postgres, not just discouraged — this is the boundary actually holding.
  const mailbox = await withTenant(userId, (tx) =>
    tx
      .select({ id: mailboxes.id, authKind: mailboxes.authKind, provider: mailboxes.provider })
      .from(mailboxes)
      .where(eq(mailboxes.userId, userId))
      .limit(1),
  );
  const mb = mailbox[0];
  if (!mb) throw new Error('no mailbox for this account');
  const mailboxId = mb.id;

  const run = await withTenant(userId, (tx) =>
    tx.insert(runs).values({ userId, mailboxId, parserVersion: PARSER_VERSION }).returning({ id: runs.id }),
  );
  const runId = run[0]!.id;

  try {
    if (mb.authKind === 'oauth' && mb.provider === 'google') {
      const credRows = await workerWithTenant(rawPool(), userId, (tx) =>
        tx
          .select({ credentialsEnc: mailboxes.credentialsEnc })
          .from(mailboxes)
          .where(eq(mailboxes.id, mailboxId))
          .limit(1),
      );
      const credentialsEnc = credRows[0]?.credentialsEnc;
      if (!credentialsEnc) throw new Error('mailbox has no stored credential');

      const summary = await ingestFromGmail(rawPool(), { userId, mailboxId, runId, credentialsEnc });

      await withTenant(userId, (tx) =>
        tx
          .update(runs)
          .set({
            status: 'ok',
            emailsTotal: summary.found,
            emailsProcessed: summary.processed,
            finishedAt: new Date(),
          })
          .where(eq(runs.id, runId)),
      );
      revalidatePath('/digest');
      revalidatePath('/unread');
      return {
        processed: summary.processed,
        created: summary.created,
        found: summary.found,
        failed: summary.failed,
      };
    }

    // Dev fallback — see doc comment above.
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
  } catch (err) {
    const errorKind = err instanceof GmailAuthError ? 'auth' : 'internal';
    const message = err instanceof Error ? err.message : String(err);
    await withTenant(userId, (tx) =>
      tx
        .update(runs)
        .set({ status: 'error', errorKind, errorDetail: { message }, finishedAt: new Date() })
        .where(eq(runs.id, runId)),
    );
    if (errorKind === 'auth') {
      await withTenant(userId, (tx) =>
        tx.update(mailboxes).set({ status: 'auth_failed' }).where(eq(mailboxes.id, mailboxId)),
      );
    }
    throw err;
  }
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

/**
 * Adds a forwarding mailbox (design §4.5): a unique inbound address that
 * never grants us mailbox access at all — the structural-privacy path, and
 * the one that scales past Google's Testing-mode test-user list without a
 * CASA assessment. Real delivery needs a real domain with MX records
 * pointing at whichever inbound provider is configured
 * (INBOUND_EMAIL_DOMAIN) — that's infrastructure outside this codebase,
 * same category as the Google Cloud OAuth client setup Gmail already
 * needed. This action only generates the address and stores it; nothing
 * arrives until that infra exists and a real filter forwards mail to it.
 */
export async function connectForwarding(): Promise<{ address: string }> {
  const userId = await currentUserId();

  const address = await withTenant(userId, async (tx) => {
    // Safe to press repeatedly (same pattern as refreshDigest/saveRuleset):
    // reuse the existing forwarding address rather than minting a new one
    // every click.
    const existing = await tx
      .select({ inboundAddress: mailboxes.inboundAddress })
      .from(mailboxes)
      .where(and(eq(mailboxes.userId, userId), eq(mailboxes.authKind, 'forwarding')))
      .limit(1);
    if (existing[0]?.inboundAddress) return existing[0].inboundAddress;

    const domain = process.env.INBOUND_EMAIL_DOMAIN ?? 'in.example.com';
    const generated = generateInboundAddress(domain);
    await tx.insert(mailboxes).values({
      userId,
      provider: 'forwarding',
      authKind: 'forwarding',
      emailAddress: generated,
      inboundAddress: generated,
      status: 'active',
    });
    return generated;
  });

  revalidatePath('/profile');
  return { address };
}
