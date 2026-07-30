/**
 * The digest read model (design, screen 1).
 *
 * Verdicts are computed here, not read (I6): the query fetches facts and the
 * active ruleset, and `evaluate()` runs over them in memory. That is what
 * makes a rule change take effect without re-reading the mailbox, and what
 * makes rule accountability (§7.4) a replay of this same function over a past
 * window under a past ruleset version.
 *
 * Assembly happens in JS rather than in one SQL statement. At the real scale
 * — a few hundred ads a week per user — the cost is nothing, and the split
 * between visible, rule-blocked and user-dismissed is I10's distinction,
 * which reads far better as three named branches than as a CASE expression.
 */
import { evaluate, type Ruleset, type Verdict } from '@job-digest/core';
import { and, desc, eq, gte, inArray, lt, lte, sql } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { adNarratives, adSightings, ads, adUserState, emailParses, rawEmails, rulesets, runs } from '../schema';
import type {
  Digest,
  DigestAd,
  DigestMetrics,
  DismissedAd,
  ParseSummary,
  Platform,
  UnreadEmail,
} from './types';
import { weekWindow, type Window } from './window';

type Db = PostgresJsDatabase<Record<string, unknown>>;

export class NoActiveRulesetError extends Error {
  constructor() {
    // A digest without rules is not an empty digest — it is an unconfigured
    // account, and the app should send the user to Profile rather than render
    // an empty list that looks like "nothing matched".
    super('no active ruleset for this account');
    this.name = 'NoActiveRulesetError';
  }
}

export async function getActiveRuleset(
  db: Db,
  userId: string,
): Promise<{ version: number; rules: Ruleset }> {
  const rows = await db
    .select({ version: rulesets.version, rules: rulesets.rules })
    .from(rulesets)
    .where(and(eq(rulesets.userId, userId), eq(rulesets.isActive, true)))
    .limit(1);
  const row = rows[0];
  if (!row) throw new NoActiveRulesetError();
  return row;
}

/** Rank for the fallback ordering: cleaner rule outcomes float up. */
const STATE_RANK = { pass: 0, unknown: 1, warn: 2, block: 3 } as const;

function outcomeRank(verdicts: Verdict[]): number {
  return verdicts.reduce((sum, v) => sum + STATE_RANK[v.state], 0);
}

/**
 * Ordering: score first when it exists, then rule-outcome quality, then
 * recency. The middle term matters because scoring weights are still an open
 * decision (§13.1) and `score` is null today — ordering by how cleanly an ad
 * clears the rules is derived from I6 and needs no new decision, so the list
 * is usefully sorted now and improves rather than changes once scores land.
 */
function compareAds(a: DigestAd, b: DigestAd): number {
  if (a.score !== null && b.score !== null && a.score !== b.score) return b.score - a.score;
  if (a.score !== null && b.score === null) return -1;
  if (a.score === null && b.score !== null) return 1;
  const rank = outcomeRank(a.verdicts) - outcomeRank(b.verdicts);
  if (rank !== 0) return rank;
  return b.receivedAt.getTime() - a.receivedAt.getTime();
}

export async function getDigest(
  db: Db,
  userId: string,
  options: { now?: Date; window?: Window } = {},
): Promise<Digest> {
  const now = options.now ?? new Date();
  const window = options.window ?? weekWindow(now);
  const { version: rulesetVersion, rules } = await getActiveRuleset(db, userId);

  // Ads with at least one sighting inside the window, plus the alert name and
  // arrival of the most recent such sighting.
  const rows = await db
    .selectDistinctOn([ads.id], {
      ad: ads,
      state: adUserState,
      alertName: adSightings.alertName,
      receivedAt: adSightings.receivedAt,
    })
    .from(ads)
    .innerJoin(adSightings, eq(adSightings.adId, ads.id))
    .leftJoin(adUserState, eq(adUserState.adId, ads.id))
    .where(
      and(
        eq(ads.userId, userId),
        gte(adSightings.receivedAt, window.start),
        lt(adSightings.receivedAt, window.end),
      ),
    )
    .orderBy(ads.id, desc(adSightings.receivedAt));

  const adIds = rows.map((r) => r.ad.id);
  const narratives = adIds.length
    ? await db
        .select({ adId: adNarratives.adId, fit: adNarratives.fit, gap: adNarratives.gap })
        .from(adNarratives)
        .where(inArray(adNarratives.adId, adIds))
    : [];
  const narrativeByAd = new Map(narratives.map((n) => [n.adId, n]));

  const visible: DigestAd[] = [];
  const dismissed: DismissedAd[] = [];
  let filteredByRule = 0;
  let dismissedByUser = 0;
  let alreadySeen = 0;

  for (const row of rows) {
    const verdicts = evaluate(row.ad.facts, rules);
    const narrative = narrativeByAd.get(row.ad.id);
    const repeat = row.ad.firstSeenAt < window.start;
    if (repeat) alreadySeen++;

    const base: DigestAd = {
      id: row.ad.id,
      title: row.ad.title,
      company: row.ad.company,
      location: row.ad.locationRaw,
      source: row.ad.source as Platform,
      externalUrl: row.ad.externalUrl,
      score: row.ad.score,
      seen: row.state?.seen ?? false,
      saved: row.state?.saved ?? false,
      incomplete: row.ad.incomplete,
      incompleteNote: row.ad.incompleteNote,
      alert: row.alertName,
      receivedAt: row.receivedAt,
      firstSeenAt: row.ad.firstSeenAt,
      repeat,
      verdicts,
      wording: row.ad.wording,
      fit: narrative?.fit ?? null,
      gap: narrative?.gap ?? null,
    };

    // I10: three distinct outcomes, checked in the order the UI presents them.
    if (row.state?.dismissedAt) {
      dismissedByUser++;
      dismissed.push({ ...base, reason: { kind: 'user' } });
      continue;
    }
    const blockers = verdicts.filter((v) => v.state === 'block');
    // An override puts a rule-blocked ad back in the main list; the user
    // decided, and §7.5 counts that decision against the rule.
    if (blockers.length > 0 && !row.state?.overriddenAt) {
      filteredByRule++;
      dismissed.push({ ...base, reason: { kind: 'rule', blockers } });
      continue;
    }
    visible.push(base);
  }

  visible.sort(compareAds);
  // User dismissals sit above rule dismissals (design, screen 1).
  dismissed.sort((a, b) => {
    if (a.reason.kind !== b.reason.kind) return a.reason.kind === 'user' ? -1 : 1;
    return compareAds(a, b);
  });

  const metrics: DigestMetrics = {
    adsReceived: rows.length,
    offTarget: null,
    passing: visible.length,
    filteredByRule,
    dismissedByUser,
    alreadySeen,
  };

  return {
    window,
    metrics,
    visible,
    dismissed,
    parse: await getParseSummary(db, userId, window),
    rulesetVersion,
  };
}

export async function getParseSummary(
  db: Db,
  userId: string,
  window: Window,
): Promise<ParseSummary> {
  const parses = await db
    .select({
      outcome: emailParses.outcome,
      declaredCount: emailParses.declaredCount,
      extractedCount: emailParses.extractedCount,
      fromAddr: rawEmails.fromAddr,
    })
    .from(emailParses)
    .innerJoin(rawEmails, eq(rawEmails.id, emailParses.rawEmailId))
    .where(
      and(
        eq(emailParses.userId, userId),
        gte(rawEmails.receivedAt, window.start),
        lt(rawEmails.receivedAt, window.end),
      ),
    );

  let notFullyRead = 0;
  let unaccounted = 0;
  let hasUnknownLayout = false;
  const platforms = new Set<Platform>();

  for (const p of parses) {
    // not_an_alert is a successful outcome, not a failure (§6.2) — counting
    // it here would make the failure number dishonest.
    if (p.outcome === 'partial' || p.outcome === 'none' || p.outcome === 'unknown_layout') {
      notFullyRead++;
    }
    if (p.outcome === 'unknown_layout') hasUnknownLayout = true;
    if (p.declaredCount !== null && p.declaredCount > p.extractedCount) {
      unaccounted += p.declaredCount - p.extractedCount;
    }
    const domain = p.fromAddr.split('@')[1] ?? '';
    if (domain.includes('linkedin')) platforms.add('LinkedIn');
    else if (domain.includes('xing')) platforms.add('Xing');
    else if (domain.includes('indeed')) platforms.add('Indeed');
    else if (domain.includes('stepstone')) platforms.add('StepStone');
  }

  const lastRun = await db
    .select({ startedAt: runs.startedAt, status: runs.status, finishedAt: runs.finishedAt })
    .from(runs)
    .where(eq(runs.userId, userId))
    .orderBy(desc(runs.startedAt))
    .limit(1);

  return {
    emailsRead: parses.length,
    emailsNotFullyRead: notFullyRead,
    adsUnaccountedFor: unaccounted,
    hasUnknownLayout,
    platforms: [...platforms],
    lastRunAt: lastRun[0]?.finishedAt ?? lastRun[0]?.startedAt ?? null,
    lastRunFailed: lastRun[0]?.status === 'error',
  };
}

/**
 * "Emails we couldn't read" (design, screen 2). Reads the latest parse per
 * email so a re-parse after a parser fix shows the current truth, while the
 * older rows stay in the table as history (I2).
 */
export async function getUnreadEmails(
  db: Db,
  userId: string,
  window: Window,
): Promise<UnreadEmail[]> {
  const rows = await db
    .selectDistinctOn([emailParses.rawEmailId], {
      parse: emailParses,
      email: rawEmails,
    })
    .from(emailParses)
    .innerJoin(rawEmails, eq(rawEmails.id, emailParses.rawEmailId))
    .where(
      and(
        eq(emailParses.userId, userId),
        gte(rawEmails.receivedAt, window.start),
        lt(rawEmails.receivedAt, window.end),
      ),
    )
    .orderBy(emailParses.rawEmailId, desc(emailParses.parserVersion));

  const interesting = rows.filter((r) => r.parse.outcome !== 'ok');
  if (interesting.length === 0) return [];

  // Which of these emails actually put an ad into the digest.
  const emailIds = interesting.map((r) => r.email.id);
  const contributed = await db
    .selectDistinct({ rawEmailId: adSightings.rawEmailId })
    .from(adSightings)
    .where(and(eq(adSightings.userId, userId), inArray(adSightings.rawEmailId, emailIds)));
  const inDigest = new Set(contributed.map((c) => c.rawEmailId));

  return interesting.map(({ parse, email }) => ({
    id: parse.id,
    rawEmailId: email.id,
    source: platformOf(email.fromAddr),
    subject: email.subject,
    receivedAt: email.receivedAt,
    outcome: parse.outcome as UnreadEmail['outcome'],
    causeCode: parse.causeCode,
    declaredCount: parse.declaredCount,
    extractedCount: parse.extractedCount,
    status: statusLine(parse.outcome, parse.declaredCount, parse.extractedCount),
    fields: parse.fieldReport ?? [],
    inDigest: inDigest.has(email.id),
  }));
}

function platformOf(fromAddr: string): Platform | null {
  const domain = fromAddr.split('@')[1] ?? '';
  if (domain.includes('linkedin')) return 'LinkedIn';
  if (domain.includes('xing')) return 'Xing';
  if (domain.includes('indeed')) return 'Indeed';
  if (domain.includes('stepstone')) return 'StepStone';
  return null;
}

/**
 * The status pill, assembled from counts rather than stored as prose — the
 * numbers are the claim, so they cannot drift from the row they describe.
 */
function statusLine(outcome: string, declared: number | null, extracted: number): string {
  if (outcome === 'not_an_alert') return 'No vacancies in this email — not an error';
  if (outcome === 'unknown_layout') return 'This layout is new — nothing read yet';
  if (outcome === 'none') {
    return declared === null
      ? 'Nothing read from this email'
      : `Nothing read — ${declared} ad${declared === 1 ? '' : 's'} unaccounted for`;
  }
  if (declared === null) return `${extracted} ad${extracted === 1 ? '' : 's'} read`;
  return `${extracted} of ${declared} ads read`;
}
