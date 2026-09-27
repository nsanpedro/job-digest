// Offline ranking eval: replay the last N digest weeks under each
// calibration variant and grade the order against the user's own actions —
// applied / saved = positive, dismissed = negative, the rest unlabelled
// (packages/core/src/ranking-eval.ts has the metric definitions and the
// bias they carry).
//
// Read-only. Replays the digest pipeline without its side effects: no
// top-pick history is written, and user-dismissed ads stay IN the ranking
// (getDigest moves them aside, which would hide every negative label).
//
// What is replayed, per week:
//   evaluate() → drop hard-blocked (unless overridden) → location + direction
//   pre-filters (the same exported functions getDigest uses) → scoreAd →
//   rank: gated ads by score desc, then pre-filter misses by score desc.
// The curated surface (Top / Read / Stretch via selectTiers) is reported
// separately — that is what the user actually sees first.
//
// The *current* ruleset, directions and CV are applied to every past week:
// the question is "which calibration ranks this user's weeks better now",
// not a reconstruction of what the digest showed at the time.
//
// Run with tsx, not raw node: this script goes through the workspace
// barrels, whose extensionless re-exports raw `--experimental-strip-types`
// cannot resolve (see backfill-title-facts.ts).
//
// Usage:
//   DATABASE_URL=... npx tsx packages/worker/scripts/eval-ranking.ts \
//     --userId <uuid> [--weeks 8] [--k 10] [--movers 10] [--no-location-gate]
//
// --no-location-gate replays every week without the city pre-filter — a
// what-if for "is the location gate hiding ads the user wants?".
//
// Exit codes: 0 — report printed; 2 — argument or connection error.
import {
  CALIBRATION_V2,
  DEFAULT_CALIBRATION,
  EMPTY_CANDIDATE,
  aggregateMetrics,
  deriveCandidateProfile,
  evaluate,
  labelFromState,
  rankingMetrics,
  scoreAd,
  selectTiers,
  type Calibration,
  type CandidateProfile,
  type Label,
  type RankingMetrics,
  type ScoreBreakdown,
  type ScoredAd,
} from '@job-digest/core';
import {
  accounts,
  adSightings,
  adUserState,
  ads,
  applicationEvents,
  getActiveProfile,
  getActiveRuleset,
  listInterestedDirections,
  matchesAnyDirection,
  passesLocationFilter,
  previousWeekWindow,
  type DirectionRow,
  type Window,
} from '@job-digest/db';
import { and, desc, eq, gte, lt } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { withTenant, type Tx } from '../src/tenant';

interface Args {
  userId: string;
  weeks: number;
  k: number;
  movers: number;
  locationGate: boolean;
}

function parseArgs(argv: readonly string[]): Args {
  const out: Args = { userId: '', weeks: 8, k: 10, movers: 10, locationGate: true };
  const int = (raw: string | undefined, fallback: number) => {
    const n = Number.parseInt(raw ?? '', 10);
    return Number.isFinite(n) && n > 0 ? n : fallback;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--userId') out.userId = argv[++i] ?? '';
    else if (a === '--weeks') out.weeks = int(argv[++i], out.weeks);
    else if (a === '--k') out.k = int(argv[++i], out.k);
    else if (a === '--movers') out.movers = int(argv[++i], out.movers);
    else if (a === '--no-location-gate') out.locationGate = false;
  }
  if (!out.userId) throw new Error('missing --userId <uuid>');
  return out;
}

interface Variant {
  name: string;
  calibration: Calibration;
  candidate: CandidateProfile;
}

interface WeekAd {
  id: string;
  title: string;
  company: string | null;
  source: string;
  label: Label | null;
  gated: boolean;
  repeat: boolean;
  facts: (typeof ads.$inferSelect)['facts'];
  verdicts: ReturnType<typeof evaluate>;
  receivedAt: Date;
}

interface VariantWeek {
  metrics: RankingMetrics;
  curatedPositives: number;
  curatedNegatives: number;
  curatedSize: number;
  /** id → 1-based rank, for the movers table. */
  rankOf: Map<string, number>;
  scoreOf: Map<string, ScoreBreakdown>;
}

const fmt = (n: number | null, digits = 3) => (n === null ? '   —' : n.toFixed(digits));

async function loadWeek(
  tx: Tx,
  userId: string,
  window: Window,
  ctx: {
    rules: Awaited<ReturnType<typeof getActiveRuleset>>['rules'];
    city: string | null;
    remoteOk: boolean;
    dirs: DirectionRow[];
    applied: ReadonlySet<string>;
  },
): Promise<{ ads: WeekAd[]; blocked: number }> {
  const rows = await tx
    .selectDistinctOn([ads.id], { ad: ads, state: adUserState, receivedAt: adSightings.receivedAt })
    .from(ads)
    .innerJoin(adSightings, eq(adSightings.adId, ads.id))
    .leftJoin(adUserState, eq(adUserState.adId, ads.id))
    .where(
      and(eq(ads.userId, userId), gte(adSightings.receivedAt, window.start), lt(adSightings.receivedAt, window.end)),
    )
    .orderBy(ads.id, desc(adSightings.receivedAt));

  const out: WeekAd[] = [];
  let blocked = 0;
  for (const row of rows) {
    const verdicts = evaluate(row.ad.facts, ctx.rules);
    if (verdicts.some((v) => v.state === 'block') && !row.state?.overriddenAt) {
      blocked++;
      continue;
    }
    const locationOk = ctx.city === null || passesLocationFilter(row.ad.locationRaw, ctx.city, ctx.remoteOk);
    const directionOk = ctx.dirs.length === 0 || matchesAnyDirection(row.ad.title, ctx.dirs);
    out.push({
      id: row.ad.id,
      title: row.ad.title,
      company: row.ad.company,
      source: row.ad.source,
      label: labelFromState({
        applied: ctx.applied.has(row.ad.id),
        saved: row.state?.saved ?? false,
        dismissed: row.state?.dismissedAt != null,
      }),
      gated: locationOk && directionOk,
      repeat: row.ad.firstSeenAt < window.start,
      facts: row.ad.facts,
      verdicts,
      receivedAt: row.receivedAt,
    });
  }
  return { ads: out, blocked };
}

function runVariant(
  week: readonly WeekAd[],
  window: Window,
  variant: Variant,
  ctx: { rules: Awaited<ReturnType<typeof getActiveRuleset>>['rules']; dirs: DirectionRow[] },
  k: number,
): VariantWeek {
  // `now` = end of the week: freshness as it stood when the week closed.
  const now = window.end;
  const scoreOf = new Map<string, ScoreBreakdown>();
  for (const ad of week) {
    scoreOf.set(
      ad.id,
      scoreAd({
        facts: ad.facts,
        verdicts: ad.verdicts,
        ruleset: ctx.rules,
        directions: ctx.dirs,
        candidate: variant.candidate,
        title: ad.title,
        source: ad.source,
        receivedAt: ad.receivedAt,
        now,
        calibration: variant.calibration,
      }),
    );
  }

  const byScore = (a: WeekAd, b: WeekAd) =>
    scoreOf.get(b.id)!.total - scoreOf.get(a.id)!.total || a.id.localeCompare(b.id);
  const ranked = [...week.filter((a) => a.gated).sort(byScore), ...week.filter((a) => !a.gated).sort(byScore)];
  const rankOf = new Map(ranked.map((a, i) => [a.id, i + 1]));

  const pool: ScoredAd[] = week
    .filter((a) => a.gated)
    .map((a) => ({
      id: a.id,
      score: scoreOf.get(a.id)!,
      verdicts: a.verdicts,
      company: a.company,
      source: a.source,
      // Direction ids only feed the per-direction diversity cap; the eval
      // leaves it off rather than re-deriving ids per ad.
      matchedDirectionIds: [],
      hasPreferenceWarn: a.verdicts.some((v) => v.severity === 'preference' && v.state === 'warn'),
      repeat: a.repeat,
    }));
  const tiers = selectTiers(pool, new Set(), variant.calibration);
  const curated = [...tiers.topPicks, ...tiers.worthAReading, ...tiers.stretch];
  const labelOf = new Map(week.map((a) => [a.id, a.label]));
  const curatedLabels = curated.map((c) => labelOf.get(c.id) ?? null);

  return {
    metrics: rankingMetrics(ranked.map((a) => ({ id: a.id, label: a.label })), k),
    curatedPositives: curatedLabels.filter((l) => l === 'applied' || l === 'saved').length,
    curatedNegatives: curatedLabels.filter((l) => l === 'dismissed').length,
    curatedSize: curated.length,
    rankOf,
    scoreOf,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is not set');
  const client = postgres(url, { max: 1 });
  const db = drizzle(client);

  try {
    const report = await withTenant(db, args.userId, async (tx) => {
      const { version: rulesetVersion, rules } = await getActiveRuleset(tx, args.userId);
      const acct = await tx
        .select({ city: accounts.city, remoteOk: accounts.remoteOk })
        .from(accounts)
        .where(eq(accounts.id, args.userId))
        .limit(1);
      const city = args.locationGate ? (acct[0]?.city?.toLowerCase() ?? null) : null;
      const remoteOk = acct[0]?.remoteOk ?? false;
      const dirs = await listInterestedDirections(tx, args.userId);
      const profile = await getActiveProfile(tx, args.userId);
      const candidate = deriveCandidateProfile({ skills: profile?.skills ?? [], directions: dirs });
      const appliedRows = await tx
        .selectDistinct({ adId: applicationEvents.adId })
        .from(applicationEvents)
        .where(eq(applicationEvents.userId, args.userId));
      const applied = new Set(appliedRows.map((r) => r.adId));

      const variants: Variant[] = [
        { name: `v${CALIBRATION_V2.version}`, calibration: CALIBRATION_V2, candidate: EMPTY_CANDIDATE },
        { name: `v${DEFAULT_CALIBRATION.version}`, calibration: DEFAULT_CALIBRATION, candidate },
      ];

      const weeks: Array<{ window: Window; ads: WeekAd[]; blocked: number; results: VariantWeek[] }> = [];
      const now = new Date();
      for (let w = 0; w < args.weeks; w++) {
        const window = previousWeekWindow(now, w);
        const { ads: weekAds, blocked } = await loadWeek(tx, args.userId, window, {
          rules,
          city,
          remoteOk,
          dirs,
          applied,
        });
        const results = variants.map((v) => runVariant(weekAds, window, v, { rules, dirs }, args.k));
        weeks.push({ window, ads: weekAds, blocked, results });
      }
      return { rulesetVersion, dirs, candidate, variants, weeks };
    });

    const { variants, weeks, candidate } = report;
    const day = (d: Date) => d.toISOString().slice(0, 10);

    console.log(`Ranking eval — user ${args.userId}, ${weeks.length} week(s), k=${args.k}`);
    console.log(
      `ruleset@v${report.rulesetVersion}, ${report.dirs.length} direction(s)` +
        (args.locationGate ? '' : ', location gate OFF (what-if)'),
    );
    console.log(
      `candidate: seniorities=[${candidate.seniorities.join(', ') || '—'}] stack=[${candidate.stack.join(', ') || '—'}]`,
    );
    const labelled = weeks.flatMap((w) => w.ads).filter((a) => a.label !== null);
    console.log(
      `labels: ${labelled.filter((a) => a.label === 'applied').length} applied, ` +
        `${labelled.filter((a) => a.label === 'saved').length} saved, ` +
        `${labelled.filter((a) => a.label === 'dismissed').length} dismissed ` +
        `(over ${weeks.reduce((n, w) => n + w.ads.length, 0)} rankable ads, ` +
        `${weeks.reduce((n, w) => n + w.blocked, 0)} hard-blocked left out)`,
    );
    console.log('');

    console.log('variant  pairwise  nDCG@k  recall@k  pos@k  neg@k  curated(+/−/size)');
    for (let v = 0; v < variants.length; v++) {
      const agg = aggregateMetrics(weeks.map((w) => w.results[v]!.metrics));
      const cp = weeks.reduce((n, w) => n + w.results[v]!.curatedPositives, 0);
      const cn = weeks.reduce((n, w) => n + w.results[v]!.curatedNegatives, 0);
      const cs = weeks.reduce((n, w) => n + w.results[v]!.curatedSize, 0);
      console.log(
        `${variants[v]!.name.padEnd(7)}  ${fmt(agg.pairwiseAccuracy)}     ${fmt(agg.ndcgAtK)}   ` +
          `${fmt(agg.recallAtK)}     ${String(agg.positivesAtK).padStart(3)}    ${String(agg.negativesAtK).padStart(3)}    ` +
          `${cp}/${cn}/${cs}`,
      );
    }
    console.log('');

    console.log('per week (pairwise accuracy per variant; empty weeks omitted):');
    for (const w of weeks.filter((wk) => wk.ads.length > 0)) {
      const m0 = w.results[0]!.metrics;
      console.log(
        `  ${day(w.window.start)}  ads=${String(w.ads.length).padStart(4)}  +${m0.positives}/−${m0.negatives}  ` +
          w.results.map((r, i) => `${variants[i]!.name}=${fmt(r.metrics.pairwiseAccuracy)}`).join('  '),
      );
    }

    if (variants.length >= 2 && args.movers > 0) {
      const [a, b] = [0, variants.length - 1];
      const movers = weeks
        .flatMap((w) =>
          w.ads
            .filter((ad) => ad.label !== null)
            .map((ad) => ({
              ad,
              from: w.results[a]!.rankOf.get(ad.id)!,
              to: w.results[b]!.rankOf.get(ad.id)!,
              score: w.results[b]!.scoreOf.get(ad.id)!,
              week: day(w.window.start),
            })),
        )
        .filter((m) => m.from !== m.to)
        .sort((x, y) => Math.abs(y.to - y.from) - Math.abs(x.to - x.from))
        .slice(0, args.movers);
      console.log('');
      console.log(`largest rank moves among labelled ads (${variants[a]!.name} → ${variants[b]!.name}):`);
      for (const m of movers) {
        const dir = m.to < m.from ? '↑' : '↓';
        console.log(
          `  ${dir} ${String(m.from).padStart(4)} → ${String(m.to).padEnd(4)} ${(m.ad.label ?? '').padEnd(9)} ` +
            `sen=${fmt(m.score.seniorityFit, 1)} stack=${fmt(m.score.stackFit, 1)}  ${m.week}  ${m.ad.title}`,
        );
      }
    }
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(2);
});
