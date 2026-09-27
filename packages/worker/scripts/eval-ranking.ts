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
// What is replayed, per week and per variant:
//   evaluate() → drop hard-blocked (unless overridden) → the variant's
//   pre-filters (direction, via the same matchesAnyDirection getDigest uses,
//   title + stored description;
//   plus the pre-v4 city gate for the variants that had it, and the level
//   gate for the variant that has it) → scoreAd →
//   rank: gated ads by score desc, then pre-filter misses by score desc.
// Each variant is the pipeline as it shipped: v2 and v3 behind the city
// gate, v4 with location scored instead (ADR-003 §8.6), and v4+level —
// v4 plus the level gate that sends entry-level titles to Explore when the
// user targets only senior-or-above rungs (ADR-003 §8.7), via the same
// isBelowTargetLevel getDigest uses. v4 stays in the report without it so
// the gate's effect reads as its own row. v5+level is the shipped pipeline:
// v4's scores unchanged, Top pick asking only for the hard Pay / Onsite
// facts (ADR-003 §8.9) — so it differs from v4+level in the Top pick block
// and the curated column, never in the ranking metrics.
// v5+level+fb adds the dismiss-reason feedback (ADR-003 §8.11): companies
// the user muted go to Explore, and exclude terms confirmed from a
// dismissal apply to their direction — each only from its `created_at`
// onward, i.e. only effects saved strictly before the replayed week's
// start (`effectsBefore`). Every other variant runs with those exclude
// terms taken back out of the stored directions (`withoutExcludeEffects`),
// so the feature's effect reads as its own row and never leaks into the
// baseline.
//
// Labels and the temporal split: a dismissal is a label for the weeks the
// ad was seen up to the one it was dismissed in. An ad already dismissed
// before a week started is left unlabelled in that week, for every variant
// — the product had already moved it aside, and with feedback on, the
// dismissal that created a mute would otherwise grade that same mute in
// every later week.
// The curated surface (Top / Read / Stretch via selectTiers) is reported
// separately — that is what the user actually sees first — and the Top pick
// tier on its own: weeks it came up empty, its size, and the labels in it.
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
//     --userId <uuid> [--weeks 8] [--k 10] [--movers 10]
//
// Exit codes: 0 — report printed; 2 — argument or connection error.
import {
  CALIBRATION_V2,
  CALIBRATION_V3,
  CALIBRATION_V4,
  DEFAULT_CALIBRATION,
  EMPTY_CANDIDATE,
  aggregateMetrics,
  deriveCandidateProfile,
  dismissedBefore,
  effectsBefore,
  evaluate,
  isBelowTargetLevel,
  isMutedCompany,
  labelFromState,
  mutedCompanyKeys,
  rankingMetrics,
  scoreAd,
  selectTiers,
  type Calibration,
  type CandidateProfile,
  type Label,
  type RankingMetrics,
  type ScoreBreakdown,
  type ScoredAd,
  withExcludeEffects,
  withoutExcludeEffects,
} from '@job-digest/core';
import {
  accounts,
  adSightings,
  adUserState,
  ads,
  applicationEvents,
  getActiveProfile,
  getActiveRuleset,
  listFeedbackEffects,
  listInterestedDirections,
  matchesAnyDirection,
  previousWeekWindow,
  type DirectionRow,
  type FeedbackEffectRow,
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
}

function parseArgs(argv: readonly string[]): Args {
  const out: Args = { userId: '', weeks: 8, k: 10, movers: 10 };
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
  }
  if (!out.userId) throw new Error('missing --userId <uuid>');
  return out;
}

interface Variant {
  name: string;
  calibration: Calibration;
  candidate: CandidateProfile;
  /** Whether this variant's pipeline dropped ads outside the city before scoring (v1–v3). */
  locationGate: boolean;
  /** Whether entry-level titles go to Explore for a senior-or-above target (ADR-003 §8.7). */
  levelGate: boolean;
  /** Whether dismiss-reason effects saved before the week apply (ADR-003 §8.11). */
  feedback: boolean;
}

// ── The pre-v4 city gate, frozen for comparison ──────────────────────────────
//
// Copied verbatim from getDigest as it stood before location became a score
// component, so v2/v3 replay the pipeline they actually shipped with. Not
// used by the product any more.

const LEGACY_REMOTE_KEYWORDS = ['remote', 'home office', 'homeoffice', 'anywhere', 'distributed'];
const LEGACY_CITY_GEO: Record<string, string[]> = {
  barcelona: ['spain', 'españa', ', es'],
  madrid: ['spain', 'españa', ', es'],
  berlin: ['germany', 'deutschland', ', de'],
  munich: ['germany', 'deutschland', ', de'],
  münchen: ['germany', 'deutschland', ', de'],
  hamburg: ['germany', 'deutschland', ', de'],
  frankfurt: ['germany', 'deutschland', ', de'],
  cologne: ['germany', 'deutschland', ', de'],
  köln: ['germany', 'deutschland', ', de'],
  zurich: ['switzerland', 'schweiz', ', ch'],
  zürich: ['switzerland', 'schweiz', ', ch'],
  vienna: ['austria', 'österreich', ', at'],
  wien: ['austria', 'österreich', ', at'],
  'buenos aires': ['argentina', ', ar'],
};

function legacyPassesLocation(locationRaw: string | null, city: string | null, remoteOk: boolean): boolean {
  if (city === null || !locationRaw) return true;
  const c = city.toLowerCase();
  const loc = locationRaw.toLowerCase();
  if (remoteOk && LEGACY_REMOTE_KEYWORDS.some((kw) => loc.includes(kw))) return true;
  if (loc.includes(c)) return true;
  return (LEGACY_CITY_GEO[c] ?? []).some((alias) => loc.includes(alias));
}

interface WeekAd {
  id: string;
  title: string;
  /** `ads.description` — fed to the direction gate and to scoreAd, as getDigest does. */
  description: string | null;
  company: string | null;
  source: string;
  label: Label | null;
  locationRaw: string | null;
  directionOk: boolean;
  legacyLocationOk: boolean;
  repeat: boolean;
  facts: (typeof ads.$inferSelect)['facts'];
  verdicts: ReturnType<typeof evaluate>;
  receivedAt: Date;
  dismissReason: (typeof adUserState.$inferSelect)['dismissReason'];
}

interface VariantWeek {
  metrics: RankingMetrics;
  curatedPositives: number;
  curatedNegatives: number;
  curatedSize: number;
  /** The Top pick tier alone (I23 / ADR-003 §8.9): its size and the labels in it. */
  topSize: number;
  topPositives: number;
  topNegatives: number;
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
    const directionOk = ctx.dirs.length === 0 || matchesAnyDirection(row.ad.title, ctx.dirs, row.ad.description);
    const label = labelFromState({
      applied: ctx.applied.has(row.ad.id),
      saved: row.state?.saved ?? false,
      dismissed: row.state?.dismissedAt != null,
    });
    // Dismissed before this week began: already out of the product's view, and
    // possibly the source of a feedback effect this week replays — so not a
    // negative for this week.
    const priorDismissal = label === 'dismissed' && dismissedBefore(row.state?.dismissedAt, window.start);
    out.push({
      id: row.ad.id,
      title: row.ad.title,
      description: row.ad.description,
      company: row.ad.company,
      source: row.ad.source,
      label: priorDismissal ? null : label,
      locationRaw: row.ad.locationRaw,
      directionOk,
      legacyLocationOk: legacyPassesLocation(row.ad.locationRaw, ctx.city, ctx.remoteOk),
      repeat: row.ad.firstSeenAt < window.start,
      facts: row.ad.facts,
      verdicts,
      receivedAt: row.receivedAt,
      dismissReason: row.state?.dismissReason ?? null,
    });
  }
  return { ads: out, blocked };
}

function runVariant(
  week: readonly WeekAd[],
  window: Window,
  variant: Variant,
  ctx: {
    rules: Awaited<ReturnType<typeof getActiveRuleset>>['rules'];
    dirs: DirectionRow[];
    effects: readonly FeedbackEffectRow[];
  },
  k: number,
): VariantWeek {
  // `now` = end of the week: freshness as it stood when the week closed.
  const now = window.end;
  // Feedback as it stood when the week began — never an effect saved during it.
  const fx = variant.feedback ? effectsBefore(ctx.effects, window.start) : [];
  const dirs = variant.feedback ? withExcludeEffects(ctx.dirs, fx) : ctx.dirs;
  const muted = mutedCompanyKeys(fx);
  const directionOk = new Map(
    week.map((a) => [a.id, variant.feedback ? dirs.length === 0 || matchesAnyDirection(a.title, dirs, a.description) : a.directionOk]),
  );
  const scoreOf = new Map<string, ScoreBreakdown>();
  for (const ad of week) {
    scoreOf.set(
      ad.id,
      scoreAd({
        facts: ad.facts,
        verdicts: ad.verdicts,
        ruleset: ctx.rules,
        directions: dirs,
        candidate: variant.candidate,
        title: ad.title,
        description: ad.description,
        locationRaw: ad.locationRaw,
        source: ad.source,
        receivedAt: ad.receivedAt,
        now,
        calibration: variant.calibration,
      }),
    );
  }

  const isGated = (a: WeekAd) =>
    !isMutedCompany(a.company, muted) &&
    directionOk.get(a.id)! &&
    (!variant.locationGate || a.legacyLocationOk) &&
    (!variant.levelGate || !isBelowTargetLevel(a.title, variant.candidate));
  const byScore = (a: WeekAd, b: WeekAd) =>
    scoreOf.get(b.id)!.total - scoreOf.get(a.id)!.total || a.id.localeCompare(b.id);
  const ranked = [...week.filter(isGated).sort(byScore), ...week.filter((a) => !isGated(a)).sort(byScore)];
  const rankOf = new Map(ranked.map((a, i) => [a.id, i + 1]));

  const pool: ScoredAd[] = week
    .filter(isGated)
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
  const topLabels = tiers.topPicks.map((c) => labelOf.get(c.id) ?? null);

  return {
    metrics: rankingMetrics(ranked.map((a) => ({ id: a.id, label: a.label })), k),
    curatedPositives: curatedLabels.filter((l) => l === 'applied' || l === 'saved').length,
    curatedNegatives: curatedLabels.filter((l) => l === 'dismissed').length,
    curatedSize: curated.length,
    topSize: tiers.topPicks.length,
    topPositives: topLabels.filter((l) => l === 'applied' || l === 'saved').length,
    topNegatives: topLabels.filter((l) => l === 'dismissed').length,
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
      const city = acct[0]?.city ?? null;
      const remoteOk = acct[0]?.remoteOk ?? false;
      const effects = await listFeedbackEffects(tx, args.userId);
      // The stored directions already carry every exclude confirmed from a
      // dismissal; the baseline runs without them, the +fb variant re-adds
      // each one from its created_at (see runVariant).
      const dirs = withoutExcludeEffects(await listInterestedDirections(tx, args.userId), effects);
      const profile = await getActiveProfile(tx, args.userId);
      const candidate = deriveCandidateProfile({
        skills: profile?.skills ?? [],
        directions: dirs,
        location: { city, remoteOk },
      });
      const appliedRows = await tx
        .selectDistinct({ adId: applicationEvents.adId })
        .from(applicationEvents)
        .where(eq(applicationEvents.userId, args.userId));
      const applied = new Set(appliedRows.map((r) => r.adId));

      const variants: Variant[] = [
        {
          name: `v${CALIBRATION_V2.version}`,
          calibration: CALIBRATION_V2,
          candidate: EMPTY_CANDIDATE,
          locationGate: true,
          levelGate: false,
          feedback: false,
        },
        {
          name: `v${CALIBRATION_V3.version}`,
          calibration: CALIBRATION_V3,
          candidate: { ...candidate, location: EMPTY_CANDIDATE.location },
          locationGate: true,
          levelGate: false,
          feedback: false,
        },
        {
          name: `v${CALIBRATION_V4.version}`,
          calibration: CALIBRATION_V4,
          candidate,
          locationGate: false,
          levelGate: false,
          feedback: false,
        },
        {
          name: `v${CALIBRATION_V4.version}+level`,
          calibration: CALIBRATION_V4,
          candidate,
          locationGate: false,
          levelGate: true,
          feedback: false,
        },
        {
          name: `v${DEFAULT_CALIBRATION.version}+level`,
          calibration: DEFAULT_CALIBRATION,
          candidate,
          locationGate: false,
          levelGate: true,
          feedback: false,
        },
        {
          name: `v${DEFAULT_CALIBRATION.version}+level+fb`,
          calibration: DEFAULT_CALIBRATION,
          candidate,
          locationGate: false,
          levelGate: true,
          feedback: true,
        },
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
        const results = variants.map((v) => runVariant(weekAds, window, v, { rules, dirs, effects }, args.k));
        weeks.push({ window, ads: weekAds, blocked, results });
      }
      return { rulesetVersion, dirs, candidate, variants, weeks, effects };
    });

    const { variants, weeks, candidate, effects } = report;
    const day = (d: Date) => d.toISOString().slice(0, 10);

    console.log(`Ranking eval — user ${args.userId}, ${weeks.length} week(s), k=${args.k}`);
    console.log(`ruleset@v${report.rulesetVersion}, ${report.dirs.length} direction(s)`);
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
    // What the level gate (v4+level) takes out of the direction-gated pool,
    // and which labels go with it — a positive here is a cost of the gate.
    const levelGated = weeks
      .flatMap((w) => w.ads)
      .filter((a) => a.directionOk && isBelowTargetLevel(a.title, candidate));
    console.log(
      `level gate: ${levelGated.length} direction-matched ad(s) below the target level — ` +
        `${levelGated.filter((a) => a.label === 'applied' || a.label === 'saved').length} positive, ` +
        `${levelGated.filter((a) => a.label === 'dismissed').length} dismissed`,
    );
    // Dismiss reasons and the effects saved from them (ADR-003 §8.11).
    const reasons = new Map<string, number>();
    for (const a of weeks.flatMap((w) => w.ads)) {
      if (a.label === 'dismissed') reasons.set(a.dismissReason ?? 'none', (reasons.get(a.dismissReason ?? 'none') ?? 0) + 1);
    }
    console.log(
      `dismiss reasons: ${[...reasons].map(([r, n]) => `${r}=${n}`).join(' ') || '—'}; ` +
        `effects: ${effects.filter((e) => e.kind === 'mute_company').length} muted compan(ies), ` +
        `${effects.filter((e) => e.kind === 'exclude_term').length} exclude term(s)`,
    );
    // Ads +fb sends to Explore that the baseline scored, each week under the
    // effects that existed before it — a positive here is a cost of the feedback.
    const fbGated = weeks.flatMap((w) => {
      const fx = effectsBefore(effects, w.window.start);
      const muted = mutedCompanyKeys(fx);
      const fbDirs = withExcludeEffects(report.dirs, fx);
      return w.ads.filter(
        (a) =>
          a.directionOk &&
          (isMutedCompany(a.company, muted) || (fbDirs.length > 0 && !matchesAnyDirection(a.title, fbDirs, a.description))),
      );
    });
    console.log(
      `feedback gate: ${fbGated.length} direction-matched ad(s) sent to Explore by prior effects — ` +
        `${fbGated.filter((a) => a.label === 'applied' || a.label === 'saved').length} positive, ` +
        `${fbGated.filter((a) => a.label === 'dismissed').length} dismissed`,
    );
    console.log('');

    console.log('variant       pairwise  nDCG@k  recall@k  pos@k  neg@k  curated(+/−/size)');
    for (let v = 0; v < variants.length; v++) {
      const agg = aggregateMetrics(weeks.map((w) => w.results[v]!.metrics));
      const cp = weeks.reduce((n, w) => n + w.results[v]!.curatedPositives, 0);
      const cn = weeks.reduce((n, w) => n + w.results[v]!.curatedNegatives, 0);
      const cs = weeks.reduce((n, w) => n + w.results[v]!.curatedSize, 0);
      console.log(
        `${variants[v]!.name.padEnd(12)}  ${fmt(agg.pairwiseAccuracy)}     ${fmt(agg.ndcgAtK)}   ` +
          `${fmt(agg.recallAtK)}     ${String(agg.positivesAtK).padStart(3)}    ${String(agg.negativesAtK).padStart(3)}    ` +
          `${cp}/${cn}/${cs}`,
      );
    }
    console.log('');

    // The Top pick tier on its own. Its eligibility (I23) is the one thing
    // v4 and v5 disagree on, so this is where the two read apart. Weeks with
    // no ads at all are left out of the denominator.
    const weeksWithAds = weeks.filter((w) => w.ads.length > 0);
    console.log('top pick  empty weeks  mean size  top(+/−)');
    for (let v = 0; v < variants.length; v++) {
      const rs = weeksWithAds.map((w) => w.results[v]!);
      const empty = rs.filter((r) => r.topSize === 0).length;
      const size = rs.reduce((n, r) => n + r.topSize, 0);
      const tp = rs.reduce((n, r) => n + r.topPositives, 0);
      const tn = rs.reduce((n, r) => n + r.topNegatives, 0);
      console.log(
        `${variants[v]!.name.padEnd(8)}  ${`${empty}/${rs.length}`.padStart(11)}  ` +
          `${(rs.length > 0 ? size / rs.length : 0).toFixed(2).padStart(9)}  ${tp}/${tn}`,
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
