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
 * between tiers (Top / Read / Stretch / Explore) and dismissed (rule-blocked
 * / user-dismissed) reads far better than a CASE expression.
 *
 * Scoring (ADR-003): `fitScore` is computed here alongside verdicts (I22,
 * extending I6 from verdicts to ranking). Hard-blocked ads are dismissed
 * before scoring — score is only defined for eligible ads.
 */
import {
  DEFAULT_CALIBRATION,
  computeMatch,
  evaluate,
  explainMatch,
  scoreAd,
  selectTiers,
  type MatchExplanation,
  type ScoreBreakdown,
  type ScoredAd,
  type Verdict,
} from '@job-digest/core';
import { and, desc, eq, gte, inArray, lt, sql } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { accounts, adNarratives, adSightings, ads, adUserState, emailParses, rawEmails, runs } from '../schema';
import { getLatestApplicationStatuses } from './applications';
import { getPlatformCapabilities } from './capabilities';
import { listInterestedDirections } from './discovery';
import { getActiveRuleset } from './ruleset';
import { getTopPickHistory, recordTopPicks } from './top-pick-history';
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

// ── Direction matching ────────────────────────────────────────────────────────
//
// The match ladder itself (full-phrase / long-word tiers, synonyms,
// role-suffix blocklist) lives in `packages/core/src/matching.ts` under
// `computeMatch`. This file consumes it as a boolean gate — an ad either
// matches at least one direction (tier > 0) or it doesn't.
//
// A single pass over directions computes the boolean, the matched ids, and
// the matched labels together; the previous shape called the matcher three
// times per ad, which was pure waste at read time when a digest routinely
// covers hundreds of ads.

/**
 * Everything the digest read path needs to know about "how did this ad's
 * title fare against the user's directions?", computed in one pass:
 *
 *   - `any` — did at least one direction match? (Gates the pre-filter.)
 *   - `ids` / `labels` — which ones? (For the diversity cap + the card.)
 *   - `explanations` — full per-direction outcome (matched | excluded |
 *     no-signal) with evidence. Powers the "Why is this here?" chip in
 *     ExpandedPanel.
 *
 * Was three separate walks over the direction list; folded together
 * because at read-time this runs per-ad on hundreds of ads and every
 * duplicated tokenization is pure waste. `explainMatch` returns the same
 * per-direction shape and we derive the boolean/ids/labels from it,
 * rather than running `computeMatch` twice.
 *
 * Description is null: the read-time gate is title-only (see the note
 * on `directionFit` in scoring.ts).
 */
function classifyDirections(
  title: string,
  dirs: readonly DirectionRow[],
): { any: boolean; ids: string[]; labels: string[]; explanations: MatchExplanation[] } {
  const explanations = explainMatch(
    title,
    null,
    dirs.map((d) => ({
      label: d.label,
      distance: d.distance,
      searchTerms: d.searchTerms,
      excludeTerms: d.excludeTerms,
    })),
  );
  const ids: string[] = [];
  const labels: string[] = [];
  for (let i = 0; i < dirs.length; i++) {
    if (explanations[i]!.kind === 'matched') {
      ids.push(dirs[i]!.id);
      labels.push(dirs[i]!.label);
    }
  }
  return { any: ids.length > 0, ids, labels, explanations };
}

/**
 * True when this job title is relevant to at least one of the user's
 * interested directions. Used as the gate in Pass 3 — ads that fail this
 * gate go straight to explore without scoring.
 *
 * Exported so the worker can apply the same gate at ingest time (before
 * writing to the DB) when the user has directions configured.
 */
export function matchesAnyDirection(title: string, dirs: readonly DirectionRow[]): boolean {
  if (dirs.length === 0) return true;
  return classifyDirections(title, dirs).any;
}

// ── Ordering (explore bucket) ─────────────────────────────────────────────────

/** Rank for the explore-bucket fallback sort: cleaner rule outcomes first. */
const STATE_RANK = { pass: 0, unknown: 1, warn: 2, block: 3 } as const;

function outcomeRank(verdicts: Verdict[]): number {
  return verdicts.reduce((sum, v) => sum + STATE_RANK[v.state], 0);
}

/**
 * Fallback sort for the explore bucket (ads outside the Top 10). Score desc
 * first when present, then rule-outcome quality, then recency. The tiers
 * themselves are ordered by `selectTiers` — this only affects explore.
 */
function compareAds(a: DigestAd, b: DigestAd): number {
  const as = a.scoreBreakdown?.total ?? null;
  const bs = b.scoreBreakdown?.total ?? null;
  if (as !== null && bs !== null && as !== bs) return bs - as;
  if (as !== null && bs === null) return -1;
  if (as === null && bs !== null) return 1;
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
  const history = await getTopPickHistory(db, userId, now);
  const calibration = DEFAULT_CALIBRATION;

  // ── Pass 1: split into dismissed vs. eligible ──────────────────────────────

  // Eligible ads (not user-dismissed, not hard-blocked) plus their raw facts
  // — facts are needed for scoring and dropped from DigestAd to keep that
  // type light.
  const eligible: Array<{ ad: DigestAd; facts: typeof rows[number]['ad']['facts'] }> = [];
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
      scoreBreakdown: null, // filled in below for eligible ads
      matchedDirectionLabels: [],
      matchExplanations: [], // filled in below for eligible ads
      applicationStatus: appliedByAd.get(row.ad.id) ?? null,
      platformFields: capabilities[row.ad.source as Platform] ?? {},
      fieldProvenance: row.ad.fieldProvenance ?? null,
    };

    // I10: three distinct outcomes, checked in the order the UI presents them.
    if (row.state?.dismissedAt) {
      dismissedByUser++;
      dismissed.push({ ...base, reason: { kind: 'user' } });
      continue;
    }
    const blockers = verdicts.filter((v) => v.state === 'block');
    // An override puts a rule-blocked ad back; §7.5 counts that decision.
    if (blockers.length > 0 && !row.state?.overriddenAt) {
      filteredByRule++;
      dismissed.push({ ...base, reason: { kind: 'rule', blockers } });
      continue;
    }
    eligible.push({ ad: base, facts: row.ad.facts });
  }

  // User dismissals above rule dismissals (design, screen 1).
  dismissed.sort((a, b) => {
    if (a.reason.kind !== b.reason.kind) return a.reason.kind === 'user' ? -1 : 1;
    return compareAds(a, b);
  });

  // ── Pass 2: two pre-filters (location → direction) → explore ─────────────
  //
  // Only gates where we have a hard user preference — wrong city or wrong
  // direction. Signal completeness (Pay/Onsite unknown) is NOT a gate: it is
  // captured as a score component (signalCompleteness, 15%) so low-signal ads
  // rank below high-signal ones without being eliminated entirely. Most real
  // ads don't carry salary or remote policy in the alert email; treating that
  // as a disqualifier removes the majority of the corpus before scoring runs.
  //
  // A pass only activates when the user has given us signal to filter against.

  const explorePool: DigestAd[] = [];
  let candidates = eligible;

  if (userCity !== null) {
    const next: typeof eligible = [];
    for (const entry of candidates) {
      if (passesLocationFilter(entry.ad.location, userCity, remoteOk)) {
        next.push(entry);
      } else {
        explorePool.push(entry.ad);
      }
    }
    candidates = next;
  }

  if (interestedDirs.length > 0) {
    const next: typeof eligible = [];
    for (const entry of candidates) {
      if (matchesAnyDirection(entry.ad.title, interestedDirs)) {
        next.push(entry);
      } else {
        explorePool.push(entry.ad);
      }
    }
    candidates = next;
  }



  // ── Pass 3: score + select tiers ──────────────────────────────────────────

  const adById = new Map<string, DigestAd>();
  const scoredPool: ScoredAd[] = [];

  for (const { ad, facts } of candidates) {
    // One pass over directions gives us the ids (for the diversity cap),
    // the labels (for the AdCard row), AND the full per-direction
    // explanations (for the "Why is this here?" chip in ExpandedPanel).
    // Was three separate passes.
    const matched = interestedDirs.length > 0
      ? classifyDirections(ad.title, interestedDirs)
      : { any: true, ids: [], labels: [], explanations: [] };

    const breakdown: ScoreBreakdown = scoreAd({
      facts,
      verdicts: ad.verdicts,
      ruleset: rules,
      directions: interestedDirs,
      title: ad.title,
      source: ad.source,
      receivedAt: ad.receivedAt,
      now,
      calibration,
    });

    const withScore: DigestAd = {
      ...ad,
      score: breakdown.total,
      scoreBreakdown: breakdown,
      matchedDirectionLabels: matched.labels,
      matchExplanations: matched.explanations,
    };
    adById.set(ad.id, withScore);

    const scored: ScoredAd = {
      id: ad.id,
      score: breakdown,
      verdicts: ad.verdicts,
      company: ad.company,
      source: ad.source,
      matchedDirectionIds: matched.ids,
      hasPreferenceWarn: ad.verdicts.some(
        (v) => v.severity === 'preference' && v.state === 'warn',
      ),
      repeat: ad.repeat,
    };
    scoredPool.push(scored);
  }

  const tiered = selectTiers(scoredPool, history, calibration);

  // Reconstruct DigestAd[] from tier ids; ads not in adById are impossible
  // (selectTiers only returns ids we put in), so the non-null assertion is safe.
  const toDigestAds = (tier: readonly ScoredAd[]): DigestAd[] =>
    tier.map((s) => adById.get(s.id)!);

  const topPicks = toDigestAds(tiered.topPicks);
  const worthAReading = toDigestAds(tiered.worthAReading);
  const stretch = toDigestAds(tiered.stretch);
  const stillOpen = toDigestAds(tiered.stillOpen);
  // Explore = pre-filter misses + everything selectTiers left over (new ads
  // below threshold, and repeats that didn't fit under the stillOpen cap).
  const explore = [...explorePool, ...toDigestAds(tiered.explore)].sort(compareAds);

  // Record top picks for I25 (idempotent via unique index).
  await recordTopPicks(db, userId, topPicks.map((a) => a.id), now);

  const anyFilterActive = userCity !== null || interestedDirs.length > 0;
  const metrics: DigestMetrics = {
    adsReceived: rows.length,
    inDigest: topPicks.length + worthAReading.length + stretch.length,
    explore: anyFilterActive
      ? { total: explore.length, preFilterMisses: explorePool.length, belowThreshold: tiered.explore.length }
      : null,
    filteredByRule,
    dismissedByUser,
    alreadySeen,
  };

  return {
    window,
    metrics,
    topPicks,
    worthAReading,
    stretch,
    stillOpen,
    explore,
    dismissed,
    parse: await getParseSummary(db, userId, window),
    rulesetVersion,
    calibrationVersion: calibration.version,
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
