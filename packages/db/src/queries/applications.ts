/**
 * The applications view (design §9, I15/I16) — a standing list, like Saved and
 * Dismissed, never window-scoped: a search runs for months and its record is
 * the point.
 *
 * Current status is derived from the latest event rather than stored, which is
 * why `application_events` is append-only. Reading the whole event history per
 * user is deliberate: per-user corpora are tiny (design §1, a few hundred ads a
 * week), and assembling in JS keeps the timeline, the status and the follow-up
 * clock consistent by construction instead of by three agreeing queries.
 *
 * **I16 is enforced here by omission.** Nothing in this file filters on
 * verdicts or on dismissal. Verdicts are still computed, because the card
 * renders them as context, but they never decide what appears — a rule
 * tightened after the fact must not erase the user's own record.
 */
import { evaluate, type Ruleset } from '@job-digest/core';
import { desc, eq, inArray } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { adSightings, ads, adUserState, applicationEvents } from '../schema';
import { getPlatformCapabilities } from './capabilities';
import { getActiveRuleset } from './ruleset';
import type {
  ApplicationCounts,
  ApplicationEvent,
  ApplicationStatus,
  Platform,
  TrackedApplication,
} from './types';

type Db = PostgresJsDatabase<Record<string, unknown>>;

/**
 * A status the user is still waiting on. `offer` counts as settled for the
 * nudge's purposes: the waiting it exists to break is over.
 */
const OPEN_STATUSES: ReadonlySet<ApplicationStatus> = new Set(['applied', 'interviewing']);

/**
 * How long silence has to run before the nudge appears. A convention, not a
 * finding — ten days is roughly two working weeks of not hearing back. It is
 * a constant rather than a setting because a setting would imply the number
 * matters more than it does.
 */
export const FOLLOW_UP_AFTER_DAYS = 10;

const DAY_MS = 24 * 60 * 60 * 1000;

function daysBetween(from: Date, to: Date): number {
  return Math.floor((to.getTime() - from.getTime()) / DAY_MS);
}

/**
 * Latest recorded status per ad, for the lists that render an ad card without
 * being the applications view (digest, saved, dismissed). One query for the
 * whole account: the table holds one row per state change per application, so
 * for a real search it stays in the hundreds.
 */
export async function getLatestApplicationStatuses(
  db: Db,
  userId: string,
): Promise<Map<string, ApplicationStatus>> {
  const rows = await db
    .select({ adId: applicationEvents.adId, status: applicationEvents.status })
    .from(applicationEvents)
    .where(eq(applicationEvents.userId, userId))
    .orderBy(desc(applicationEvents.at));

  const latest = new Map<string, ApplicationStatus>();
  for (const row of rows) {
    if (!latest.has(row.adId)) latest.set(row.adId, row.status);
  }
  return latest;
}

/** Counts for the nav badge, without assembling the full evaluated list. */
export async function getApplicationCounts(db: Db, userId: string): Promise<ApplicationCounts> {
  const rows = await db
    .select({ adId: applicationEvents.adId, status: applicationEvents.status, at: applicationEvents.at })
    .from(applicationEvents)
    .where(eq(applicationEvents.userId, userId))
    .orderBy(desc(applicationEvents.at));

  const latest = new Map<string, { status: ApplicationStatus; at: Date }>();
  for (const row of rows) {
    // Rows arrive newest first, so the first sighting of an ad is its current
    // status.
    if (!latest.has(row.adId)) latest.set(row.adId, { status: row.status, at: row.at });
  }

  const now = new Date();
  let open = 0;
  let needingFollowUp = 0;
  for (const entry of latest.values()) {
    if (!OPEN_STATUSES.has(entry.status)) continue;
    open++;
    if (daysBetween(entry.at, now) >= FOLLOW_UP_AFTER_DAYS) needingFollowUp++;
  }

  return { total: latest.size, open, needingFollowUp };
}

export async function getApplications(
  db: Db,
  userId: string,
  options: { now?: Date } = {},
): Promise<TrackedApplication[]> {
  const now = options.now ?? new Date();
  const { rules } = await getActiveRuleset(db, userId);

  const eventRows = await db
    .select()
    .from(applicationEvents)
    .where(eq(applicationEvents.userId, userId))
    .orderBy(desc(applicationEvents.at));

  if (eventRows.length === 0) return [];

  const byAd = new Map<string, ApplicationEvent[]>();
  for (const row of eventRows) {
    const list = byAd.get(row.adId) ?? [];
    list.push({ id: row.id, status: row.status, at: row.at, note: row.note });
    byAd.set(row.adId, list);
  }

  const adIds = [...byAd.keys()];
  const [adRows, sightingRows, capabilities] = await Promise.all([
    db.select({ ad: ads, state: adUserState }).from(ads).leftJoin(adUserState, eq(adUserState.adId, ads.id)).where(inArray(ads.id, adIds)),
    db
      .selectDistinctOn([adSightings.adId], {
        adId: adSightings.adId,
        alertName: adSightings.alertName,
        receivedAt: adSightings.receivedAt,
      })
      .from(adSightings)
      .where(inArray(adSightings.adId, adIds))
      .orderBy(adSightings.adId, desc(adSightings.receivedAt)),
    getPlatformCapabilities(db),
  ]);
  const adById = new Map(adRows.map((r) => [r.ad.id, r]));
  const sightingByAd = new Map(sightingRows.map((r) => [r.adId, r]));

  const out: TrackedApplication[] = [];
  for (const [adId, events] of byAd) {
    const row = adById.get(adId);
    // The ad is gone only if the account was deleted, which takes this row
    // with it — but skipping rather than throwing keeps one impossible state
    // from emptying the whole page (I9's spirit).
    if (!row) continue;

    out.push(
      toTrackedApplication({
        ad: row.ad,
        state: row.state,
        sighting: sightingByAd.get(adId),
        events,
        rules,
        now,
        platformFields: capabilities[row.ad.source as Platform] ?? {},
      }),
    );
  }

  // Whatever is waiting longest, first: the list is a worklist, and the thing
  // most likely to need action is the thing that has been silent longest.
  return out.sort((a, b) => {
    if (a.open !== b.open) return a.open ? -1 : 1;
    return b.daysSinceLastEvent - a.daysSinceLastEvent;
  });
}

function toTrackedApplication(input: {
  ad: typeof ads.$inferSelect;
  state: typeof adUserState.$inferSelect | null;
  sighting: { alertName: string | null; receivedAt: Date } | undefined;
  events: ApplicationEvent[];
  rules: Ruleset;
  now: Date;
  platformFields: Record<string, boolean>;
}): TrackedApplication {
  const { ad, state, sighting, events, rules, now, platformFields } = input;

  const current = events[0]!;
  const applied = events.filter((e) => e.status === 'applied').at(-1) ?? events.at(-1)!;
  const open = OPEN_STATUSES.has(current.status);
  const daysSinceLastEvent = daysBetween(current.at, now);

  return {
    id: ad.id,
    title: ad.title,
    company: ad.company,
    location: ad.locationRaw,
    source: ad.source as Platform,
    externalUrl: ad.externalUrl,
    score: ad.score,
    seen: state?.seen ?? false,
    saved: state?.saved ?? false,
    incomplete: ad.incomplete,
    incompleteNote: ad.incompleteNote,
    alert: sighting?.alertName ?? null,
    receivedAt: sighting?.receivedAt ?? ad.lastSeenAt,
    firstSeenAt: ad.firstSeenAt,
    repeat: false,
    verdicts: evaluate(ad.facts, rules),
    wording: ad.wording,
    titleFacts: ad.titleFacts,
    fit: null,
    gap: null,
    applicationStatus: current.status,
    platformFields,
    fieldProvenance: ad.fieldProvenance ?? null,
    status: current.status,
    events,
    firstAppliedAt: applied.at,
    lastEventAt: current.at,
    daysSinceLastEvent,
    open,
    needsFollowUp: open && daysSinceLastEvent >= FOLLOW_UP_AFTER_DAYS,
    scoreBreakdown: null,
    matchedDirectionLabels: [],
  };
}
