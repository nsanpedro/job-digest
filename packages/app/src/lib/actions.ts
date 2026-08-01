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
import { after } from 'next/server';
import { DEFAULT_RULESET, type Mode, type Ruleset } from '@job-digest/core';
import { applicationEvents, adUserState, mailboxes, rulesets, runs, type ApplicationStatus } from '@job-digest/db';
import { and, desc, eq, sql } from 'drizzle-orm';
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
 * Split into two actions rather than one blocking call. The original single
 * `refreshDigest()` awaited the entire Gmail fetch before returning anything
 * to the client — found live to be the reason the button just sat on
 * "Reading the inbox…" with no number attached, sometimes for tens of
 * seconds: every click re-scanned the last 90 days sequentially (fixed
 * separately, in ingestFromGmail), and there was nowhere for progress to go
 * even once that was faster.
 *
 * `startRefresh` creates the run row and returns its id immediately; the
 * actual ingestion is handed to `after()` (Next's wrapper around Vercel's
 * `waitUntil`) so it keeps running past the point the client's request
 * finishes. The client polls `getRunProgress(runId)` on an interval and
 * reads `runs.emails_total`/`emails_processed`, which `runIngestion` updates
 * as it goes rather than only at the end — this is what turns "Reading the
 * inbox…" into "Reading the inbox… 4 of 12".
 *
 * A caveat worth stating rather than discovering: `after()` work still has
 * to finish inside the invoking function's execution budget (Vercel's
 * `maxDuration` for the route, set in digest/page.tsx) — it runs longer than
 * the client's request, not indefinitely.
 */
export async function startRefresh(): Promise<{ runId: string }> {
  const userId = await currentUserId();

  // Explicit columns, not select(): app_user has no grant on
  // mailboxes.credentials_enc (I13), so a bare `SELECT *` is rejected by
  // Postgres, not just discouraged — this is the boundary actually holding.
  const mailbox = await withTenant(userId, (tx) =>
    tx
      .select({
        id: mailboxes.id,
        authKind: mailboxes.authKind,
        provider: mailboxes.provider,
        lastSyncedAt: mailboxes.lastSyncedAt,
      })
      .from(mailboxes)
      .where(eq(mailboxes.userId, userId))
      .limit(1),
  );
  const mb = mailbox[0];
  if (!mb) throw new Error('no mailbox for this account');

  const run = await withTenant(userId, (tx) =>
    tx.insert(runs).values({ userId, mailboxId: mb.id, parserVersion: PARSER_VERSION }).returning({ id: runs.id }),
  );
  const runId = run[0]!.id;

  after(() =>
    runIngestion({
      userId,
      mailboxId: mb.id,
      runId,
      authKind: mb.authKind,
      provider: mb.provider,
      lastSyncedAt: mb.lastSyncedAt,
    }),
  );

  return { runId };
}

/**
 * The work formerly done inline in refreshDigest, now running detached from
 * the client's request (see startRefresh). Nothing here can throw back to a
 * caller that's already gone — every failure path ends by recording status
 * on the `runs` row, which is the only channel left to the client, via
 * getRunProgress's polling.
 */
async function runIngestion(params: {
  userId: string;
  mailboxId: string;
  runId: string;
  authKind: string;
  provider: string;
  lastSyncedAt: Date | null;
}): Promise<void> {
  const { userId, mailboxId, runId } = params;
  try {
    if (params.authKind === 'oauth' && params.provider === 'google') {
      const credRows = await workerWithTenant(rawPool(), userId, (tx) =>
        tx
          .select({ credentialsEnc: mailboxes.credentialsEnc })
          .from(mailboxes)
          .where(eq(mailboxes.id, mailboxId))
          .limit(1),
      );
      const credentialsEnc = credRows[0]?.credentialsEnc;
      if (!credentialsEnc) throw new Error('mailbox has no stored credential');

      // ingestFromGmail updates runs.emails_total/emails_processed itself as
      // it goes (that's the whole point) and advances mailboxes.last_synced_at
      // on success — this call is the only one in the app that passes `since`.
      await ingestFromGmail(rawPool(), {
        userId,
        mailboxId,
        runId,
        credentialsEnc,
        since: params.lastSyncedAt,
      });

      await withTenant(userId, (tx) =>
        tx.update(runs).set({ status: 'ok', finishedAt: new Date() }).where(eq(runs.id, runId)),
      );
    } else {
      // Dev fallback — nothing real to fetch for the seed account's fake
      // app_password mailbox, so re-ingest the local fixture corpus instead.
      // Bumps emails_processed the same incremental way the Gmail path does,
      // so the progress UI behaves identically regardless of which path ran.
      const fixturesRoot = join(process.cwd(), '../ingest/test/fixtures');
      const files: Array<{ dir: string; file: string }> = [];
      for (const platform of ['linkedin', 'xing']) {
        const dir = join(fixturesRoot, platform);
        for (const file of readdirSync(dir).filter((f) => f.endsWith('.eml'))) files.push({ dir, file });
      }
      await withTenant(userId, (tx) => tx.update(runs).set({ emailsTotal: files.length }).where(eq(runs.id, runId)));

      for (const { dir, file } of files) {
        const buf = readFileSync(join(dir, file));
        await withTenant(userId, (tx) => ingestEmail(tx, { userId, mailboxId, runId, raw: buf }));
        await withTenant(userId, (tx) =>
          tx
            .update(runs)
            .set({ emailsProcessed: sql`${runs.emailsProcessed} + 1` })
            .where(eq(runs.id, runId)),
        );
      }

      await withTenant(userId, (tx) =>
        tx.update(runs).set({ status: 'ok', finishedAt: new Date() }).where(eq(runs.id, runId)),
      );
    }
    revalidatePath('/digest');
    revalidatePath('/unread');
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
  }
}

/** Polled by RefreshButton while a run is in flight — see startRefresh. */
export async function getRunProgress(runId: string): Promise<{
  status: 'running' | 'ok' | 'error';
  emailsTotal: number | null;
  emailsProcessed: number;
  errorMessage: string | null;
} | null> {
  const userId = await currentUserId();
  const rows = await withTenant(userId, (tx) =>
    tx
      .select({
        status: runs.status,
        emailsTotal: runs.emailsTotal,
        emailsProcessed: runs.emailsProcessed,
        errorDetail: runs.errorDetail,
      })
      .from(runs)
      .where(eq(runs.id, runId))
      .limit(1),
  );
  const row = rows[0];
  if (!row) return null;
  return {
    status: row.status,
    emailsTotal: row.emailsTotal,
    emailsProcessed: row.emailsProcessed,
    errorMessage: (row.errorDetail as { message?: string } | null)?.message ?? null,
  };
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
      .select({ version: rulesets.version, mode: rulesets.mode })
      .from(rulesets)
      .where(eq(rulesets.userId, userId))
      .orderBy(desc(rulesets.version))
      .limit(1);
    const nextVersion = (current[0]?.version ?? 0) + 1;

    await tx.update(rulesets).set({ isActive: false }).where(eq(rulesets.userId, userId));
    await tx.insert(rulesets).values({
      userId,
      version: nextVersion,
      rules,
      // Carried forward explicitly: `mode` defaults to 'steady' at the column
      // level, so omitting it here would quietly drop a user out of urgent
      // mode every time they edited a threshold.
      mode: current[0]?.mode ?? 'steady',
      isActive: true,
    });
  });
  revalidatePath('/digest');
  revalidatePath('/profile');
  revalidatePath('/saved');
  revalidatePath('/dismissed');
}

/**
 * Records one step of the user's own search (design §9, I15).
 *
 * Appends — never updates. The current status of an application is its latest
 * event, derived on read, so there is no column here that could disagree with
 * the timeline.
 *
 * Every row is the user's assertion. The system has no way to observe that an
 * application was sent or answered: I14 confines fetching to alert senders, so
 * the mail that would reveal either is never requested. That is a promise on
 * the login screen, not an implementation gap.
 *
 * Re-recording the status an application already has is a no-op, the same
 * press-it-twice tolerance the other actions have — a double click should not
 * put two identical rows in a timeline the user reads.
 */
export async function recordApplicationEvent(
  adId: string,
  status: ApplicationStatus,
  note?: string,
): Promise<void> {
  const userId = await currentUserId();
  await withTenant(userId, async (tx) => {
    const latest = await tx
      .select({ status: applicationEvents.status })
      .from(applicationEvents)
      .where(eq(applicationEvents.adId, adId))
      .orderBy(desc(applicationEvents.at))
      .limit(1);
    if (latest[0]?.status === status) return;

    await tx.insert(applicationEvents).values({
      userId,
      adId,
      status,
      note: note?.trim() ? note.trim() : null,
    });
  });
  revalidatePath('/applications');
  revalidatePath('/digest');
}

/**
 * Undo, for an event recorded by mistake.
 *
 * The append-only rule this table is built on is about the *system*: nothing
 * derives, expires or rewrites a status behind the user's back, and no rule
 * change can erase a record (I16). It was never meant to trap someone in a
 * mis-click on their own history, which is theirs to correct.
 */
export async function removeApplicationEvent(eventId: string): Promise<void> {
  const userId = await currentUserId();
  await withTenant(userId, (tx) =>
    tx.delete(applicationEvents).where(eq(applicationEvents.id, eventId)),
  );
  revalidatePath('/applications');
  revalidatePath('/digest');
}

/**
 * Switches search mode (design §7.7).
 *
 * A mode change is a ruleset change, so it goes through the same versioning
 * path as any rule edit: a new row, the old one deactivated. That keeps "a
 * version fully determines evaluation" true, which is the property §7.4's
 * replay depends on — recording mode anywhere else would make a replay under
 * version V ambiguous.
 *
 * Selecting the mode already in force is a no-op rather than a new version:
 * versions are cheap, but a row per click on a toggle is noise in a history
 * meant to be readable.
 */
export async function setMode(mode: Mode): Promise<void> {
  const userId = await currentUserId();
  await withTenant(userId, async (tx) => {
    const current = await tx
      .select({ version: rulesets.version, rules: rulesets.rules, mode: rulesets.mode, isActive: rulesets.isActive })
      .from(rulesets)
      .where(eq(rulesets.userId, userId))
      .orderBy(desc(rulesets.version))
      .limit(1);
    const active = current[0];
    if (active?.isActive && active.mode === mode) return;

    const nextVersion = (active?.version ?? 0) + 1;
    await tx.update(rulesets).set({ isActive: false }).where(eq(rulesets.userId, userId));
    await tx.insert(rulesets).values({
      userId,
      version: nextVersion,
      // Carries the authored rules forward untouched — the mode is applied on
      // read (applyMode), never baked into the stored ruleset.
      rules: active?.rules ?? DEFAULT_RULESET,
      mode,
      isActive: true,
    });
  });
  revalidatePath('/digest');
  revalidatePath('/profile');
  revalidatePath('/saved');
  revalidatePath('/dismissed');
  revalidatePath('/applications');
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
