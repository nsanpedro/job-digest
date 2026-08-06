/**
 * Ingest one email: raw bytes → raw_emails → email_parses → ads + sightings
 * (design §6). One transaction per email, so a failure never leaves an email
 * recorded as parsed with no ads.
 *
 * Idempotent by construction (I1, I2): the raw email is keyed on
 * (user_id, message_id), the parse row on (raw_email_id, parser_version), and
 * ads on their content hash. Re-running a fetch, or re-parsing after a parser
 * fix, converges instead of duplicating.
 */
import { and, eq, sql } from 'drizzle-orm';
import {
  classify,
  dedupeKey as computeDedupeKey,
  declaredCount,
  externalId as computeExternalId,
  extractorFor,
  extractTitleFacts,
  layoutHash,
  normalizeAd,
  parseEml,
  type ExtractedAd,
  type Platform,
} from '@job-digest/ingest';
import { adSightings, ads, emailParses, rawEmails } from '@job-digest/db';
import { classifyOutcome, type CauseCode, type Outcome } from './outcome';
import { mergeFacts } from './merge-facts';
import type { Tx } from './tenant';

/**
 * Bumped whenever extraction behaviour changes; drives re-parse (I2).
 * v2: adds the StepStone extractor — a real behaviour change for every
 * StepStone email, stored or future.
 */
export const PARSER_VERSION = 2;

export interface IngestInput {
  userId: string;
  mailboxId: string;
  runId: string;
  raw: Buffer;
  /**
   * Alert name from the mailbox folder or filter, when known. No caller
   * passes this today (gmail.ts, forwarding.ts, actions.ts, seed-dev.ts all
   * omit it), and no platform's alert email exposes which saved search
   * triggered it — so in practice this always falls through to the email
   * subject below (I4's shape: absence, not invention). The parameter is
   * kept for a real source if one is ever found (e.g. a Gmail label the user
   * names after their search).
   */
  alertName?: string;
}

export interface IngestResult {
  rawEmailId: string;
  /** False when this email was already stored — the fetch was a re-run (I1). */
  storedNow: boolean;
  platform: Platform | null;
  layoutHash: string | null;
  outcome: Outcome;
  causeCode: CauseCode;
  declaredCount: number | null;
  extractedCount: number;
  adsCreated: number;
  adsEnriched: number;
  conflicts: number;
}

export async function ingestEmail(tx: Tx, input: IngestInput): Promise<IngestResult> {
  const email = await parseEml(input.raw);

  // ── raw_emails: immutable, insert-once (I1) ──
  const inserted = await tx
    .insert(rawEmails)
    .values({
      userId: input.userId,
      mailboxId: input.mailboxId,
      messageId: email.messageId,
      fromAddr: email.fromAddr,
      subject: email.subject,
      receivedAt: email.receivedAt,
      rawBytes: input.raw,
      bodyText: email.bodyText,
      bodyHtml: email.bodyHtml,
      mimeParts: email.mimeParts as unknown as Record<string, unknown>,
      layoutHash: email.bodyHtml ? layoutHash(email.bodyHtml) : null,
    })
    .onConflictDoNothing({ target: [rawEmails.userId, rawEmails.messageId] })
    .returning({ id: rawEmails.id });

  let rawEmailId = inserted[0]?.id;
  const storedNow = rawEmailId !== undefined;
  if (rawEmailId === undefined) {
    const existing = await tx
      .select({ id: rawEmails.id })
      .from(rawEmails)
      .where(and(eq(rawEmails.userId, input.userId), eq(rawEmails.messageId, email.messageId)));
    const found = existing[0];
    if (!found) throw new Error('raw email vanished between insert and select');
    rawEmailId = found.id;
  }

  // ── classify → declare → extract ──
  const platform = classify(email.fromAddr);
  if (platform === 'not_allowlisted') {
    // Reachable only if something bypassed the I14 allowlist upstream. It is
    // recorded rather than thrown: a surprise sender is data, not a crash.
    const result = await writeParse(tx, {
      userId: input.userId,
      rawEmailId,
      outcome: 'not_an_alert',
      causeCode: 'not_an_alert',
      declaredCount: null,
      declaredCountReason: 'sender is not on the allowlist',
      extractedCount: 0,
      fieldReport: null,
    });
    return {
      ...emptyResult(rawEmailId, storedNow),
      ...result,
      outcome: 'not_an_alert',
      causeCode: 'not_an_alert',
    };
  }

  const hash = email.bodyHtml ? layoutHash(email.bodyHtml) : null;
  const extractor = hash ? extractorFor(platform, hash) : null;
  const declaration = declaredCount(platform, email.subject);
  const extraction = extractor ? extractor.extract(email) : { ads: [], fieldReport: [] };

  const verdict = classifyOutcome({
    email,
    hasExtractor: extractor !== null,
    declaration,
    ads: extraction.ads,
  });

  await writeParse(tx, {
    userId: input.userId,
    rawEmailId,
    outcome: verdict.outcome,
    causeCode: verdict.causeCode,
    declaredCount: declaration.count,
    declaredCountReason: declaration.reason ?? null,
    extractedCount: extraction.ads.length,
    fieldReport: extraction.fieldReport.length > 0 ? extraction.fieldReport : null,
  });

  // ── ads + sightings ──
  let adsCreated = 0;
  let adsEnriched = 0;
  let conflicts = 0;
  for (const extracted of extraction.ads) {
    const outcome = await upsertAd(tx, {
      userId: input.userId,
      rawEmailId,
      platform,
      extracted,
      receivedAt: email.receivedAt,
      alertName: input.alertName ?? email.subject,
      incomplete: verdict.outcome === 'partial',
    });
    if (outcome.created) adsCreated++;
    if (outcome.enriched) adsEnriched++;
    conflicts += outcome.conflicts;
  }

  return {
    rawEmailId,
    storedNow,
    platform,
    layoutHash: hash,
    outcome: verdict.outcome,
    causeCode: verdict.causeCode,
    declaredCount: declaration.count,
    extractedCount: extraction.ads.length,
    adsCreated,
    adsEnriched,
    conflicts,
  };
}

function emptyResult(rawEmailId: string, storedNow: boolean) {
  return {
    rawEmailId,
    storedNow,
    platform: null,
    layoutHash: null,
    declaredCount: null,
    extractedCount: 0,
    adsCreated: 0,
    adsEnriched: 0,
    conflicts: 0,
  };
}

async function writeParse(
  tx: Tx,
  row: {
    userId: string;
    rawEmailId: string;
    outcome: Outcome;
    causeCode: CauseCode;
    declaredCount: number | null;
    declaredCountReason: string | null;
    extractedCount: number;
    fieldReport: Array<{ name: string; ok: boolean; value: string }> | null;
  },
): Promise<Record<string, never>> {
  // A re-parse at the same parser version is a no-op, not a duplicate (I2).
  await tx
    .insert(emailParses)
    .values({
      userId: row.userId,
      rawEmailId: row.rawEmailId,
      parserVersion: PARSER_VERSION,
      outcome: row.outcome,
      declaredCount: row.declaredCount,
      declaredCountReason: row.declaredCountReason,
      extractedCount: row.extractedCount,
      causeCode: row.causeCode,
      fieldReport: row.fieldReport,
    })
    .onConflictDoNothing({ target: [emailParses.rawEmailId, emailParses.parserVersion] });
  return {};
}

async function upsertAd(
  tx: Tx,
  input: {
    userId: string;
    rawEmailId: string;
    platform: Platform;
    extracted: ExtractedAd;
    receivedAt: Date;
    alertName: string;
    incomplete: boolean;
  },
): Promise<{ created: boolean; enriched: boolean; conflicts: number }> {
  const { facts, wording } = normalizeAd(input.extracted);
  const key = computeDedupeKey(input.extracted);
  const extId = computeExternalId(input.extracted.url?.value);

  // Match on the content hash, or on the platform id when one exists — the
  // latter catches a platform rewording a title between sends (§6.7).
  const existing = await tx
    .select()
    .from(ads)
    .where(
      and(
        eq(ads.userId, input.userId),
        extId === null
          ? eq(ads.dedupeKey, key)
          : sql`(${ads.dedupeKey} = ${key} OR ${ads.externalId} = ${extId})`,
      ),
    )
    .limit(1);

  const prior = existing[0];
  let adId: string;
  let created = false;
  let enriched = false;
  let conflicts: ReturnType<typeof mergeFacts>['conflicts'] = [];

  if (prior) {
    const merged = mergeFacts(
      { facts: prior.facts, wording: prior.wording },
      { facts, wording },
    );
    enriched = merged.enriched;
    conflicts = merged.conflicts;
    await tx
      .update(ads)
      .set({
        facts: merged.facts,
        wording: merged.wording,
        lastSeenAt: input.receivedAt > prior.lastSeenAt ? input.receivedAt : prior.lastSeenAt,
        // An ad stops being incomplete once a later email fills the gap.
        incomplete: prior.incomplete && input.incomplete,
        externalId: prior.externalId ?? extId,
      })
      .where(eq(ads.id, prior.id));
    adId = prior.id;
  } else {
    const title = input.extracted.title?.value ?? '(title not read)';
    const locationRaw = input.extracted.location?.value ?? null;
    const rows = await tx
      .insert(ads)
      .values({
        userId: input.userId,
        dedupeKey: key,
        externalId: extId,
        externalUrl: input.extracted.url?.value ?? null,
        title,
        company: input.extracted.company?.value ?? null,
        locationRaw,
        source: input.platform,
        facts,
        wording,
        // Computed once here, from the same title/location that are
        // themselves fixed at first sighting (they are never overwritten on
        // the merge branch above) — so this never goes stale independently
        // of the fields it is derived from.
        titleFacts: extractTitleFacts(title, locationRaw),
        incomplete: input.incomplete,
        firstSeenAt: input.receivedAt,
        lastSeenAt: input.receivedAt,
      })
      .returning({ id: ads.id });
    const row = rows[0];
    if (!row) throw new Error('ad insert returned no row');
    adId = row.id;
    created = true;
  }

  await tx.insert(adSightings).values({
    userId: input.userId,
    adId,
    rawEmailId: input.rawEmailId,
    alertName: input.alertName,
    receivedAt: input.receivedAt,
    conflicts: conflicts.length > 0 ? { fields: conflicts } : null,
  });

  return { created, enriched, conflicts: conflicts.length };
}
