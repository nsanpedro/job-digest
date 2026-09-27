// One-off: turn the matcher audit into a pass/fail check with an
// explicit acceptance criterion — the number a fix has to hit before
// we call it done.
//
// Same title-only match ladder as audit-match.ts (see that script's
// header for why: mirrors the digest read path, not the ingest gate).
// The extra move here is a --forbidden list of keywords; if any ad
// whose title matches a forbidden keyword lands in the top-K by score
// with directionFitStrength >= --strengthFloor, that ad is a false
// positive and the run fails. Everything else prints normally.
//
// Usage:
//   DATABASE_URL=... node --experimental-strip-types \
//     packages/worker/scripts/validate-matcher.ts \
//     --userId <uuid> \
//     --forbidden sales,finanzas,legal \
//     [--limit 200] [--topK 30] [--strengthFloor 0.6]
//
// Exit codes:
//   0 — no false positives in the top-K under the strength floor
//   1 — at least one false positive (details printed to stderr)
//   2 — argument or connection error before the check ran
//
// The intent is to run this once per test user (DG, PM) after A3's
// quirurgical fix, and to plug it into a cron / CI step later so the
// matcher cannot regress silently.

import { and, desc, eq, inArray } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { ads, directions as directionsTable } from '../../db/src/schema.ts';
import {
  computeMatch,
  DESCRIPTION_MATCH_CHARS,
  DISTANCE_FACTOR,
} from '../../core/src/matching.ts';
import { withTenant } from '../src/tenant.ts';

interface ParsedArgs {
  userId: string;
  forbidden: string[];
  limit: number;
  topK: number;
  strengthFloor: number;
}

function parseArgs(argv: readonly string[]): ParsedArgs {
  let userId: string | null = null;
  let forbidden: string[] = [];
  let limit = 200;
  let topK = 30;
  let strengthFloor = 0.6;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--userId') {
      userId = argv[++i] ?? null;
    } else if (a === '--forbidden') {
      const raw = argv[++i] ?? '';
      forbidden = raw
        .split(',')
        .map((s) => s.trim().toLowerCase())
        .filter((s) => s.length > 0);
    } else if (a === '--limit') {
      const parsed = Number.parseInt(argv[++i] ?? '', 10);
      if (Number.isFinite(parsed) && parsed > 0) limit = parsed;
    } else if (a === '--topK') {
      const parsed = Number.parseInt(argv[++i] ?? '', 10);
      if (Number.isFinite(parsed) && parsed > 0) topK = parsed;
    } else if (a === '--strengthFloor') {
      const parsed = Number.parseFloat(argv[++i] ?? '');
      if (Number.isFinite(parsed) && parsed >= 0 && parsed <= 1) strengthFloor = parsed;
    }
  }
  if (!userId) {
    throw new Error('missing --userId <uuid>');
  }
  if (forbidden.length === 0) {
    throw new Error('missing --forbidden <comma,separated,keywords> — nothing to check against');
  }
  return { userId, forbidden, limit, topK, strengthFloor };
}

// ── Inline gate helpers (mirrors curation.ts, kept here for the same
// reason audit-match.ts inlines them: `./matching` value-imports in
// curation.ts are extensionless and Node's ESM resolver refuses them
// even under --experimental-strip-types).

const REGEX_META = /[.*+?^${}()|[\]\\]/g;

interface AuditDirection {
  label: string;
  distance: 'adjacent' | 'stretch';
  searchTerms: readonly string[];
  excludeTerms: readonly string[];
}

function hasExcludeHit(
  title: string,
  description: string | null,
  excludeTerms: readonly string[],
): boolean {
  const descWindow = description ? description.slice(0, DESCRIPTION_MATCH_CHARS) : null;
  for (const raw of excludeTerms) {
    const term = raw.trim().toLowerCase();
    if (!term) continue;
    const escaped = term.replace(REGEX_META, '\\$&');
    const re = new RegExp(`\\b${escaped}\\b`, 'iu');
    if (re.test(title)) return true;
    if (descWindow && re.test(descWindow)) return true;
  }
  return false;
}

function directionFitStrength(
  title: string,
  description: string | null,
  directions: readonly AuditDirection[],
): number {
  if (directions.length === 0) return 1;
  const allExcludes = directions.flatMap((d) => d.excludeTerms);
  if (allExcludes.length > 0 && hasExcludeHit(title, description, allExcludes)) return 0;
  let best = 0;
  for (const dir of directions) {
    const match = computeMatch(title, description, dir.searchTerms);
    const scaled = match.tier * DISTANCE_FACTOR[dir.distance];
    if (scaled > best) {
      best = scaled;
      if (best >= 1.0) break;
    }
  }
  return best;
}

/** True when a word-boundary match on the title hits any forbidden keyword. */
function titleContainsForbidden(title: string, forbidden: readonly string[]): string | null {
  const t = title.toLowerCase();
  for (const kw of forbidden) {
    const escaped = kw.replace(REGEX_META, '\\$&');
    const re = new RegExp(`\\b${escaped}\\b`, 'iu');
    if (re.test(t)) return kw;
  }
  return null;
}

// ── Main ────────────────────────────────────────────────────────────────────

const url = process.env.DATABASE_URL;
if (!url) {
  process.stderr.write('DATABASE_URL is not set\n');
  process.exit(2);
}

const client = postgres(url, { max: 1 });
const db = drizzle(client);

interface Offender {
  id: string;
  title: string;
  strength: number;
  matchedForbidden: string;
  matchedDirection: string | null;
}

async function main(): Promise<void> {
  const { userId, forbidden, limit, topK, strengthFloor } = parseArgs(process.argv.slice(2));

  await withTenant(db, userId, async (tx) => {
    const directionRows = await tx
      .select()
      .from(directionsTable)
      .where(
        and(
          eq(directionsTable.userId, userId),
          inArray(directionsTable.state, ['suggested', 'interested', 'alert_configured']),
        ),
      );

    process.stderr.write(
      `user ${userId} has ${directionRows.length} direction(s): ${
        directionRows.map((d) => d.label).join(', ') || '(none)'
      }\n`,
    );
    process.stderr.write(`forbidden keywords: ${forbidden.join(', ')}\n`);
    process.stderr.write(`criterion: no forbidden titles in top ${topK} with strength >= ${strengthFloor}\n\n`);

    const auditDirections: AuditDirection[] = directionRows.map((d) => ({
      label: d.label,
      distance: d.distance,
      searchTerms: d.searchTerms,
      excludeTerms: d.excludeTerms,
    }));

    const rows = await tx
      .select({
        id: ads.id,
        title: ads.title,
        source: ads.source,
      })
      .from(ads)
      .where(eq(ads.userId, userId))
      .orderBy(desc(ads.firstSeenAt))
      .limit(limit);

    // Score every ad by directionFitStrength (title-only, matches the
    // digest read path). Sort desc; the top-K is our window.
    const scored = rows
      .map((ad) => ({
        ...ad,
        strength: directionFitStrength(ad.title, null, auditDirections),
      }))
      .sort((a, b) => b.strength - a.strength);

    const topWindow = scored.slice(0, topK);

    const offenders: Offender[] = [];
    for (const ad of topWindow) {
      if (ad.strength < strengthFloor) continue;
      const forbiddenHit = titleContainsForbidden(ad.title, forbidden);
      if (forbiddenHit === null) continue;
      // Name the winning direction so the fix has a starting point.
      let winningDirection: string | null = null;
      let winningStrength = 0;
      for (const dir of auditDirections) {
        const match = computeMatch(ad.title, null, dir.searchTerms);
        const scaled = match.tier * DISTANCE_FACTOR[dir.distance];
        if (scaled > winningStrength) {
          winningStrength = scaled;
          winningDirection = dir.label;
        }
      }
      offenders.push({
        id: ad.id,
        title: ad.title,
        strength: ad.strength,
        matchedForbidden: forbiddenHit,
        matchedDirection: winningDirection,
      });
    }

    if (offenders.length === 0) {
      process.stderr.write(
        `PASS — top ${topK} of ${rows.length} ads contains zero forbidden-title matches at strength >= ${strengthFloor}\n`,
      );
      process.exit(0);
    }

    process.stderr.write(
      `FAIL — ${offenders.length} false positive(s) in top ${topK} (out of ${rows.length} ads):\n\n`,
    );
    for (const off of offenders) {
      process.stderr.write(
        `  strength=${off.strength.toFixed(3)} forbidden="${off.matchedForbidden}" direction="${
          off.matchedDirection ?? '(none)'
        }"\n    title: ${off.title}\n    id:    ${off.id}\n\n`,
      );
    }
    process.exit(1);
  });
}

main().catch((err) => {
  process.stderr.write(`${err}\n`);
  process.exitCode = 2;
  void client.end();
});
