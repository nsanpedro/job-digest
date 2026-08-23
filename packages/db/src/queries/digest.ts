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
import { evaluate, type Verdict } from '@job-digest/core';
import { and, desc, eq, gte, inArray, lt, lte, sql } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { accounts, adNarratives, adSightings, ads, adUserState, emailParses, rawEmails, runs } from '../schema';
import { getLatestApplicationStatuses } from './applications';
import { getPlatformCapabilities } from './capabilities';
import { listInterestedDirections } from './discovery';
import { getActiveRuleset } from './ruleset';
import type {
  Digest,
  DigestAd,
  DigestMetrics,
  DirectionRow,
  DismissedAd,
  ParseSummary,
  Platform,
  UnreadEmail,
} from './types';
import { weekWindow, type Window } from './window';

type Db = PostgresJsDatabase<Record<string, unknown>>;

// ── Location matching ─────────────────────────────────────────────────────────

const REMOTE_KEYWORDS = ['remote', 'home office', 'homeoffice', 'anywhere', 'distributed'];

// Country/region aliases for common cities — lets "Spain" match a Barcelona user.
const CITY_GEO: Record<string, string[]> = {
  barcelona:    ['spain', 'españa', ', es'],
  madrid:       ['spain', 'españa', ', es'],
  berlin:       ['germany', 'deutschland', ', de'],
  munich:       ['germany', 'deutschland', ', de'],
  münchen:      ['germany', 'deutschland', ', de'],
  hamburg:      ['germany', 'deutschland', ', de'],
  frankfurt:    ['germany', 'deutschland', ', de'],
  cologne:      ['germany', 'deutschland', ', de'],
  köln:         ['germany', 'deutschland', ', de'],
  zurich:       ['switzerland', 'schweiz', ', ch'],
  zürich:       ['switzerland', 'schweiz', ', ch'],
  vienna:       ['austria', 'österreich', ', at'],
  wien:         ['austria', 'österreich', ', at'],
  'buenos aires': ['argentina', ', ar'],
};

/**
 * True when the ad's raw location string is consistent with the user's city
 * preference. Missing location → passes (we don't filter what we don't know).
 * Remote jobs pass when the user has opted in to remote.
 */
function passesLocationFilter(locationRaw: string | null, city: string, remoteOk: boolean): boolean {
  if (!locationRaw) return true;
  const loc = locationRaw.toLowerCase();
  if (remoteOk && REMOTE_KEYWORDS.some((kw) => loc.includes(kw))) return true;
  if (loc.includes(city)) return true;
  return (CITY_GEO[city] ?? []).some((alias) => loc.includes(alias));
}

// Board sources (Greenhouse, Lever, Ashby, Personio) don't expose salary
// via their public APIs — that's by design, not a quality signal. Only
// penalise email-sourced ads (LinkedIn, Xing, etc.) for missing facts.
const EMAIL_PLATFORMS = new Set(['LinkedIn', 'Xing', 'StepStone', 'Indeed']);

/**
 * True when the ad has at least one concrete fact we can evaluate, or when
 * the ad came from a board source that legitimately doesn't expose salary.
 * Ads from email platforms (LinkedIn, Xing…) with neither pay nor home-days
 * info are low-signal and go to offTarget.
 */
function hasAnySignal(ad: DigestAd): boolean {
  if (!EMAIL_PLATFORMS.has(ad.source)) return true;
  const pay    = ad.verdicts.find((v) => v.key === 'Pay');
  const onsite = ad.verdicts.find((v) => v.key === 'Onsite');
  return !(pay?.state === 'unknown' && onsite?.state === 'unknown');
}

// ── Direction matching ────────────────────────────────────────────────────────

const STOP_WORDS = new Set(['and', 'the', 'for', 'with', 'from', 'von', 'und', 'für', 'mit', 'der', 'die', 'das', 'bei', 'zur', 'als']);

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[\s/,\-()+]+/)
    .filter((w) => w.length >= 3 && !STOP_WORDS.has(w));
}

/**
 * True when this job title is relevant to at least one of the user's
 * interested directions. Two tracks for precision + recall:
 *
 * Track 1 — phrase match: ALL words in a searchTerm must appear as substrings
 * in the title. "Engineering Manager" requires both → "Customer Success Manager"
 * fails. German terms (Entwickler, Architekt) naturally don't match English
 * titles, which is fine — track 2 covers the English vocabulary.
 *
 * Track 2 — long-word match: any individual word of 7+ chars from any
 * searchTerm appears as a substring in the title. At 7+ chars a word is
 * domain-specific enough to match alone ("frontend", "engineer", "typescript",
 * "fullstack") without producing false positives from short generic words
 * ("lead", "team", "senior"). Bridge skills are intentionally excluded here —
 * they are full sentences whose tokenized words ("performance", "partnering")
 * are too generic to match alone.
 */
function matchesAnyDirection(title: string, dirs: readonly DirectionRow[]): boolean {
  if (dirs.length === 0) return true;
  const t = title.toLowerCase();

  return dirs.some((dir) => {
    // Track 1: all words of a searchTerm as substrings in title
    if (dir.searchTerms.some((term) => {
      const words = tokenize(term);
      return words.length > 0 && words.every((w) => t.includes(w));
    })) return true;

    // Track 2: any single 8+ char word from any searchTerm as a substring.
    // 8+ filters out short generic words ("manager"=7, "senior"=6, "lead"=4)
    // that produce false positives when matched alone without phrase context.
    return dir.searchTerms.flatMap(tokenize).some((w) => w.length >= 8 && t.includes(w));
  });
}

// ── Ordering ──────────────────────────────────────────────────────────────────

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

  // User's location preferences — used for location and signal pre-filters.
  const acct = await db
    .select({ city: accounts.city, remoteOk: accounts.remoteOk })
    .from(accounts)
    .where(eq(accounts.id, userId))
    .limit(1);
  const userCity = acct[0]?.city?.toLowerCase() ?? null;
  const remoteOk = acct[0]?.remoteOk ?? false;

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
  const appliedByAd = await getLatestApplicationStatuses(db, userId);
  const capabilities = await getPlatformCapabilities(db);

  const interestedDirs = await listInterestedDirections(db, userId);

  const allVisible: DigestAd[] = [];
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
      titleFacts: row.ad.titleFacts,
      fit: narrative?.fit ?? null,
      gap: narrative?.gap ?? null,
      applicationStatus: appliedByAd.get(row.ad.id) ?? null,
      platformFields: capabilities[row.ad.source as Platform] ?? {},
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
    allVisible.push(base);
  }

  allVisible.sort(compareAds);
  // User dismissals sit above rule dismissals (design, screen 1).
  dismissed.sort((a, b) => {
    if (a.reason.kind !== b.reason.kind) return a.reason.kind === 'user' ? -1 : 1;
    return compareAds(a, b);
  });

  // Three-pass de-clutter: location → signal → direction. Each pass moves
  // ads that don't meet the bar to offTarget instead of hiding them.
  // A pass only activates when the user has given us the signal to filter
  // against (city set, directions set); without any signal, nothing is moved.
  const offTarget: DigestAd[] = [];
  let candidates = allVisible;

  // Pass 1 — location: ads not in the user's city (and not remote when remoteOk)
  // go to offTarget. Ads with no location info stay in candidates.
  if (userCity !== null) {
    const next: DigestAd[] = [];
    for (const ad of candidates) {
      if (passesLocationFilter(ad.location, userCity, remoteOk)) {
        next.push(ad);
      } else {
        offTarget.push(ad);
      }
    }
    candidates = next;
  }

  // Pass 2 — signal: ads with neither pay nor home-days fact are low-signal
  // and go to offTarget to keep the main list actionable.
  {
    const next: DigestAd[] = [];
    for (const ad of candidates) {
      if (hasAnySignal(ad)) {
        next.push(ad);
      } else {
        offTarget.push(ad);
      }
    }
    candidates = next;
  }

  // Pass 3 — direction: ads outside the user's role directions (I10).
  // Only activates when at least one direction is set.
  let visible = candidates;
  if (interestedDirs.length > 0) {
    visible = [];
    for (const ad of candidates) {
      if (matchesAnyDirection(ad.title, interestedDirs)) {
        visible.push(ad);
      } else {
        offTarget.push(ad);
      }
    }
  }

  const anyFilterActive = userCity !== null || interestedDirs.length > 0;
  const metrics: DigestMetrics = {
    adsReceived: rows.length,
    offTarget: anyFilterActive ? offTarget.length : null,
    passing: visible.length,
    filteredByRule,
    dismissedByUser,
    alreadySeen,
  };

  return {
    window,
    metrics,
    visible,
    offTarget,
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
