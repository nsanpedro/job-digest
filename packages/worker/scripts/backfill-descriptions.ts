// One-off: fill `ads.description` for ads that predate migration 0018, or
// that the regular refresh never reached (ADR-003 §8.15 "Description
// backfill"). 0018 shipped with "no backfill — the next API re-fetch fills
// it"; that held only for jobs clearing the ingest direction gate, which ran
// before the upsert (fixed in fetch-apis.ts), and never for email ads
// enriched before the column existed (fixed in enrich-ad.ts). The regular
// path now converges on its own; this script closes the existing gap in one
// pass instead of waiting for every source to be refreshed.
//
// What it does, per account (each account inside withTenant — a script is
// not an exemption from RLS):
//   1. Selects the account's ads with `description IS NULL` and plans each
//      one (planDescriptionBackfill in src/description-fill.ts, unit-tested):
//        - ad from an API source → that board's list call, the same one
//          fetch-apis.ts makes (it carries every open posting's
//          description). One fetch per board, cached across accounts.
//        - no source, but the URL is one Greenhouse/Lever posting (email
//          ads, or API ads whose source row was deleted) → one request to
//          that posting, description only. Never the LLM fact extraction:
//          no ANTHROPIC_API_KEY needed, no Haiku spend.
//        - anything else (LinkedIn/Xing/Indeed/StepStone alert links) →
//          counted as unreachable, never fetched. These stay null by design
//          (title-only matching, §8.10).
//   2. Matches fetched postings to ads by externalId, then dedupe key (the
//      same order ingestJob uses) and writes with
//      `UPDATE … WHERE description IS NULL`.
//
// Idempotent: only rows with `description IS NULL` are selected or written,
// so a re-run fetches only what is still missing and never overwrites a
// description (including one the app wrote meanwhile). Ads whose posting has
// closed are not on the board any more and simply stay null.
//
// Polite to the job boards: one request in flight at a time, `--delay-ms`
// (default 1000) between requests, each board fetched once per run however
// many accounts or ads share it. Expected volume: 1 request per distinct
// board (Greenhouse: +1 per extra 500-job page, rare; Personio: up to 2 when
// the .de host misses and .com is tried) plus 1 per single posting link. Run
// `--dry-run` first: it makes no HTTP requests and no writes, and prints the
// counts per source and the request estimate.
//
// Run with tsx, not raw node: this script imports the provider adapters and
// @job-digest/db, which go through the workspace barrels whose extensionless
// re-exports raw `node --experimental-strip-types` cannot resolve (see
// backfill-title-facts.ts, which avoids them and therefore can use raw node).
//
// Usage (from the repo root):
//   DATABASE_URL=... npx tsx packages/worker/scripts/backfill-descriptions.ts --dry-run
//   DATABASE_URL=... npx tsx packages/worker/scripts/backfill-descriptions.ts
//   options: --user <uuid>   one account only
//            --delay-ms <n>  pause between HTTP requests (default 1000)
//
// Exit codes: 0 — done (per-board/per-posting failures are reported, not
// fatal); 1 — database or unexpected error; 2 — bad arguments.
import { eq, isNull, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { ads, sources } from '@job-digest/db';
import { withTenant } from '../src/tenant';
import { ashby } from '../src/providers/ashby';
import { greenhouse } from '../src/providers/greenhouse';
import { lever } from '../src/providers/lever';
import { personio } from '../src/providers/personio';
import type { JobBoardProvider } from '../src/providers/types';
import { fetchTier1 } from '../src/enrich/enrich-ad';
import { writeDescriptionFills } from '../src/fill-descriptions';
import {
  descriptionSources,
  matchDescriptionFills,
  planDescriptionBackfill,
  type BackfillPlan,
  type BackfillRow,
  type BoardProvider,
  type DescriptionSource,
} from '../src/description-fill';

// ── Arguments ────────────────────────────────────────────────────────────────

interface Args {
  dryRun: boolean;
  userId: string | null;
  delayMs: number;
}

function parseArgs(argv: readonly string[]): Args {
  const args: Args = { dryRun: false, userId: null, delayMs: 1000 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') args.dryRun = true;
    else if (a === '--user') {
      const v = argv[++i];
      if (!v || !/^[0-9a-f-]{36}$/i.test(v)) usage(`--user needs a uuid, got "${v ?? ''}"`);
      args.userId = v;
    } else if (a === '--delay-ms') {
      const v = Number(argv[++i]);
      if (!Number.isInteger(v) || v < 0) usage('--delay-ms needs a non-negative integer');
      args.delayMs = v;
    } else usage(`unknown argument "${a}"`);
  }
  return args;
}

function usage(msg: string): never {
  console.error(`${msg}\nusage: backfill-descriptions.ts [--dry-run] [--user <uuid>] [--delay-ms <n>]`);
  process.exit(2);
}

// ── Polite HTTP: one request at a time, a pause between requests ─────────────

const PROVIDERS: Record<BoardProvider, JobBoardProvider> = {
  Greenhouse: greenhouse,
  Lever: lever,
  Ashby: ashby,
  Personio: personio,
};

let lastRequestAt = 0;
async function politely<T>(delayMs: number, fn: () => Promise<T>): Promise<T> {
  const wait = lastRequestAt + delayMs - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  try {
    return await fn();
  } finally {
    lastRequestAt = Date.now();
  }
}

// ── Main ─────────────────────────────────────────────────────────────────────

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL is not set');
  process.exit(2);
}
const args = parseArgs(process.argv.slice(2));
const client = postgres(url, { max: 1 });
const db = drizzle(client);

interface BoardTally { ads: number; filled: number; notOnBoard: number; error: string | null }
interface SingleTally { ads: number; filled: number; noDescription: number; failed: number }

async function loadRows(userId: string): Promise<BackfillRow[]> {
  return withTenant(db, userId, async (tx) => {
    const rows = await tx
      .select({
        id: ads.id,
        externalId: ads.externalId,
        externalUrl: ads.externalUrl,
        dedupeKey: ads.dedupeKey,
        platform: ads.source,
        sourceProvider: sources.provider,
        sourceSlug: sources.externalSlug,
      })
      .from(ads)
      .leftJoin(sources, eq(sources.id, ads.sourceId))
      .where(sql`${ads.userId} = ${userId} AND ${ads.description} IS NULL`);
    return rows.map((r) => ({ ...r, platform: String(r.platform) }));
  });
}

async function main(): Promise<void> {
  const userRows = await db
    .selectDistinct({ userId: ads.userId })
    .from(ads)
    .where(args.userId ? sql`${ads.description} IS NULL AND ${ads.userId} = ${args.userId}` : isNull(ads.description));
  console.log(
    `${userRows.length} account(s) have ads with no description${args.dryRun ? ' — DRY RUN: no HTTP requests, no writes' : ''}`,
  );

  const plans: Array<{ userId: string; plan: BackfillPlan }> = [];
  for (const { userId } of userRows) {
    plans.push({ userId, plan: planDescriptionBackfill(await loadRows(userId)) });
  }

  // Counts per source, across accounts.
  const boardTally = new Map<string, BoardTally>();
  const singleTally = new Map<string, SingleTally>();
  const unreachable = new Map<string, number>();
  for (const { userId, plan } of plans) {
    let boardAds = 0;
    for (const [key, b] of plan.boards) {
      const t = boardTally.get(key) ?? { ads: 0, filled: 0, notOnBoard: 0, error: null };
      t.ads += b.ads.length;
      boardAds += b.ads.length;
      boardTally.set(key, t);
    }
    for (const s of plan.singles) {
      const k = `${s.match.platform} posting links (${s.platform} ads)`;
      const t = singleTally.get(k) ?? { ads: 0, filled: 0, noDescription: 0, failed: 0 };
      t.ads++;
      singleTally.set(k, t);
    }
    let unreachableAds = 0;
    for (const [p, n] of plan.unreachable) {
      unreachable.set(p, (unreachable.get(p) ?? 0) + n);
      unreachableAds += n;
    }
    console.log(
      `  ${userId}: ${boardAds} via ${plan.boards.size} board(s), ${plan.singles.length} single posting(s), ${unreachableAds} unreachable`,
    );
  }

  if (args.dryRun) {
    printSummary(boardTally, singleTally, unreachable, false);
    const requests = boardTally.size + [...singleTally.values()].reduce((n, t) => n + t.ads, 0);
    console.log(
      `\nwould make ≈${requests} request(s) (${boardTally.size} board fetch(es) + single postings; ` +
        `Personio boards may take 2) — ≈${Math.ceil((requests * args.delayMs) / 1000)} s at --delay-ms ${args.delayMs}`,
    );
    return;
  }

  // Board fetches are cached across accounts: the same board is fetched once.
  const boardCache = new Map<string, DescriptionSource[] | Error>();
  for (const { userId, plan } of plans) {
    for (const [key, board] of plan.boards) {
      const tally = boardTally.get(key)!;
      let fetched = boardCache.get(key);
      if (!fetched) {
        try {
          const jobs = await politely(args.delayMs, () => PROVIDERS[board.provider].fetchJobs(board.slug));
          fetched = descriptionSources(jobs);
        } catch (err) {
          fetched = err instanceof Error ? err : new Error(String(err));
        }
        boardCache.set(key, fetched);
      }
      if (fetched instanceof Error) {
        tally.error = fetched.message;
        continue;
      }
      const fills = matchDescriptionFills(board.ads, fetched);
      const changed = fills.length > 0 ? await withTenant(db, userId, (tx) => writeDescriptionFills(tx, userId, fills)) : 0;
      tally.filled += changed;
      tally.notOnBoard += board.ads.length - fills.length;
    }

    for (const single of plan.singles) {
      const tally = singleTally.get(`${single.match.platform} posting links (${single.platform} ads)`)!;
      try {
        const { descriptionText } = await politely(args.delayMs, () => fetchTier1(single.match));
        if (!descriptionText) {
          tally.noDescription++;
          continue;
        }
        tally.filled += await withTenant(db, userId, (tx) =>
          writeDescriptionFills(tx, userId, [{ adId: single.adId, description: descriptionText }]),
        );
      } catch {
        // Usually a 404: the posting closed. The ad stays null (I4).
        tally.failed++;
      }
    }
  }

  printSummary(boardTally, singleTally, unreachable, true);
}

function printSummary(
  boards: Map<string, BoardTally>,
  singles: Map<string, SingleTally>,
  unreachable: Map<string, number>,
  done: boolean,
): void {
  console.log('\nper board (ads with no description):');
  for (const [key, t] of [...boards].sort(([a], [b]) => a.localeCompare(b))) {
    const outcome = !done
      ? ''
      : t.error
        ? `  — fetch failed: ${t.error}`
        : `  → filled ${t.filled}, not on the board / no description ${t.notOnBoard}`;
    console.log(`  ${key.padEnd(40)} ${String(t.ads).padStart(5)}${outcome}`);
  }
  if (singles.size > 0) console.log('single postings:');
  for (const [key, t] of singles) {
    const outcome = done ? `  → filled ${t.filled}, no description ${t.noDescription}, fetch failed ${t.failed}` : '';
    console.log(`  ${key.padEnd(40)} ${String(t.ads).padStart(5)}${outcome}`);
  }
  if (unreachable.size > 0) console.log('unreachable (no keyless API — stay null, title-only):');
  for (const [platform, n] of [...unreachable].sort(([, a], [, b]) => b - a)) {
    console.log(`  ${platform.padEnd(40)} ${String(n).padStart(5)}`);
  }
  if (done) {
    const filled =
      [...boards.values()].reduce((n, t) => n + t.filled, 0) + [...singles.values()].reduce((n, t) => n + t.filled, 0);
    console.log(`\ndone — ${filled} ad(s) got a description`);
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await client.end();
  });
