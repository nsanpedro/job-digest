// One-off: audit matching against a user's most recent ads. Emits CSV to
// stdout, human logs to stderr — pipe stdout into a file, open the file in
// Numbers/Excel, sort by directionFitStrength desc, look for rows in a rubro
// clearly outside the user's directions with strength ≥ 0.6. Those are the
// false positives that produced the "the digest shows me any ad" complaint.
//
// Title-only, description=null: the digest read path is title-only (see
// scoring.ts's directionFit and digest.ts's classifyDirections). Passing the
// alert body here would answer a different question — what the ingest gate
// used, not what the ranking used — and the user complaint is about ranking.
//
// Wrapped in withTenant like every other worker script: a script is not an
// exemption from RLS just because it runs outside a request.
//
// A note on imports: `computeMatch` in matching.ts is the only piece of the
// match ladder we can reach directly — matching.ts has type-only workspace
// imports (the `import type { Distance }`, erased by strip-types), so raw
// Node's resolver is happy. `curation.ts` and `explain-match.ts` bring the
// same ladder into direction-level fit and structured explanations, but they
// value-import `./matching` (extensionless), which Node's ESM resolver
// refuses. Both helpers we'd want (the ad-level exclude gate and the
// per-direction explanation) recompose `computeMatch` cheaply, so we inline
// them here rather than patch the runtime files for the sake of a script.
//
// Usage:
//   DATABASE_URL=... node --experimental-strip-types \
//     packages/worker/scripts/audit-match.ts --userId <uuid> [--limit 200] > audit.csv
import { and, desc, eq, inArray } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
// Same reach-through pattern as backfill-title-facts.ts — direct relative
// path + explicit .ts extension. Both files carry only type-only workspace
// imports, which strip-types erases before Node resolves anything.
import { ads, directions as directionsTable } from '../../db/src/schema.ts';
import {
  computeMatch,
  DESCRIPTION_MATCH_CHARS,
  DISTANCE_FACTOR,
  type MatchTier,
} from '../../core/src/matching.ts';
import { withTenant } from '../src/tenant.ts';

interface ParsedArgs {
  userId: string;
  limit: number;
}

function parseArgs(argv: readonly string[]): ParsedArgs {
  let userId: string | null = null;
  let limit = 200;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--userId') {
      userId = argv[++i] ?? null;
    } else if (a === '--limit') {
      const raw = argv[++i] ?? '';
      const parsed = Number.parseInt(raw, 10);
      if (Number.isFinite(parsed) && parsed > 0) limit = parsed;
    }
  }
  if (!userId) {
    throw new Error('missing --userId <uuid>');
  }
  return { userId, limit };
}

const CSV_HEADER = [
  'id',
  'firstSeenAt',
  'source',
  'company',
  'title',
  'directionFitStrength',
  'bestDirection',
  'bestTier',
  'bestMatchedTerm',
  'bestViaLongWord',
  'excluded',
  'explanations',
] as const;

function csvCell(v: unknown): string {
  if (v === null || v === undefined) return '';
  const s = typeof v === 'string' ? v : String(v);
  // Quote if the cell contains a delimiter, quote, or newline; escape
  // embedded quotes by doubling — RFC 4180 §2.
  if (/[",\r\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function csvLine(cells: readonly unknown[]): string {
  return cells.map(csvCell).join(',');
}

// ── Inline exclude / fit helpers (mirrors curation.ts / explain-match.ts) ───

const REGEX_META = /[.*+?^${}()|[\]\\]/g;

interface AuditDirection {
  label: string;
  distance: 'adjacent' | 'stretch';
  searchTerms: readonly string[];
  excludeTerms: readonly string[];
}

interface ExcludeHit {
  term: string;
  where: 'title' | 'description';
}

function findExcludeHit(
  title: string,
  description: string | null,
  excludeTerms: readonly string[],
): ExcludeHit | null {
  const descWindow = description ? description.slice(0, DESCRIPTION_MATCH_CHARS) : null;
  for (const raw of excludeTerms) {
    const term = raw.trim().toLowerCase();
    if (!term) continue;
    const escaped = term.replace(REGEX_META, '\\$&');
    const re = new RegExp(`\\b${escaped}\\b`, 'iu');
    if (re.test(title)) return { term, where: 'title' };
    if (descWindow && re.test(descWindow)) return { term, where: 'description' };
  }
  return null;
}

type DirectionOutcome =
  | {
      kind: 'matched';
      label: string;
      distance: 'adjacent' | 'stretch';
      tier: MatchTier;
      matchedTerm: string;
      via: 'full-phrase' | 'long-word';
      surface: 'title' | 'description';
      longWord: string | null;
    }
  | {
      kind: 'excluded';
      label: string;
      distance: 'adjacent' | 'stretch';
      term: string;
      where: 'title' | 'description';
    }
  | {
      kind: 'no-signal';
      label: string;
      distance: 'adjacent' | 'stretch';
    };

/**
 * Per-direction outcome for one (title, description). Mirrors
 * `explainMatch` in `packages/core/src/explain-match.ts:132`. Kept in the
 * same order as `directions` so callers can zip results back to labels.
 */
function explain(
  title: string,
  description: string | null,
  directions: readonly AuditDirection[],
): DirectionOutcome[] {
  return directions.map<DirectionOutcome>((dir) => {
    const excl = findExcludeHit(title, description, dir.excludeTerms);
    if (excl) {
      return { kind: 'excluded', label: dir.label, distance: dir.distance, ...excl };
    }
    const match = computeMatch(title, description, dir.searchTerms);
    if (match.tier === 0) {
      return { kind: 'no-signal', label: dir.label, distance: dir.distance };
    }
    return {
      kind: 'matched',
      label: dir.label,
      distance: dir.distance,
      tier: match.tier,
      matchedTerm: match.matchedTerm!,
      via: match.viaFullPhrase ? 'full-phrase' : 'long-word',
      surface: match.surface as 'title' | 'description',
      longWord: match.viaLongWord,
    };
  });
}

/**
 * Ad-level gate: union every direction's excludeTerms, apply once against
 * (title, description). A hit zeros the whole call. Otherwise return the
 * best `tier × DISTANCE_FACTOR` across directions. Empty directions → 1.
 * Mirrors `directionFitStrength` in `packages/core/src/curation.ts:118`.
 */
function directionFitStrength(
  title: string,
  description: string | null,
  directions: readonly AuditDirection[],
): number {
  if (directions.length === 0) return 1;
  const allExcludes = directions.flatMap((d) => d.excludeTerms);
  if (allExcludes.length > 0 && findExcludeHit(title, description, allExcludes)) return 0;
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

/**
 * Best "matched" outcome across per-direction explanations — highest tier
 * wins, ties by iteration order (the direction the user configured first).
 */
function pickBestMatched(outcomes: readonly DirectionOutcome[]): {
  label: string;
  tier: MatchTier;
  matchedTerm: string;
  viaLongWord: string | null;
} | null {
  let best: {
    label: string;
    tier: MatchTier;
    matchedTerm: string;
    viaLongWord: string | null;
  } | null = null;
  for (const outcome of outcomes) {
    if (outcome.kind !== 'matched') continue;
    if (best === null || outcome.tier > best.tier) {
      best = {
        label: outcome.label,
        tier: outcome.tier,
        matchedTerm: outcome.matchedTerm,
        viaLongWord: outcome.longWord,
      };
    }
  }
  return best;
}

function describe(outcome: DirectionOutcome): string {
  switch (outcome.kind) {
    case 'matched': {
      if (outcome.via === 'full-phrase') {
        return `matched "${outcome.label}" — full phrase "${outcome.matchedTerm}" in ${outcome.surface}`;
      }
      return `matched "${outcome.label}" — long-word "${outcome.longWord}" from "${outcome.matchedTerm}" in ${outcome.surface}`;
    }
    case 'excluded':
      return `excluded from "${outcome.label}" — "${outcome.term}" in ${outcome.where}`;
    case 'no-signal':
      return `no match for "${outcome.label}"`;
  }
}

// ── Main ────────────────────────────────────────────────────────────────────

const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL is not set');

const client = postgres(url, { max: 1 });
const db = drizzle(client);

async function main(): Promise<void> {
  const { userId, limit } = parseArgs(process.argv.slice(2));

  await withTenant(db, userId, async (tx) => {
    // Inlined to avoid the ../../db/src/queries/discovery.ts import chain
    // — that file value-imports '../schema' extensionless, which raw Node
    // cannot resolve. The query is the same one listInterestedDirections
    // runs (discovery.ts:214).
    const directionRows = await tx
      .select()
      .from(directionsTable)
      .where(
        and(
          eq(directionsTable.userId, userId),
          inArray(directionsTable.state, ['suggested', 'interested', 'alert_configured']),
        ),
      );

    if (directionRows.length === 0) {
      process.stderr.write(
        `user ${userId} has no interested directions — every ad passes the gate (directionFitStrength=1)\n`,
      );
    } else {
      const labels = directionRows.map((d) => d.label).join(', ');
      process.stderr.write(
        `user ${userId} has ${directionRows.length} direction(s): ${labels}\n`,
      );
    }

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
        company: ads.company,
        source: ads.source,
        firstSeenAt: ads.firstSeenAt,
      })
      .from(ads)
      .where(eq(ads.userId, userId))
      .orderBy(desc(ads.firstSeenAt))
      .limit(limit);

    process.stderr.write(`inspecting ${rows.length} ad(s)\n`);

    process.stdout.write(csvLine(CSV_HEADER) + '\n');

    for (const ad of rows) {
      const outcomes = explain(ad.title, null, auditDirections);
      const strength = directionFitStrength(ad.title, null, auditDirections);
      const best = pickBestMatched(outcomes);
      const excluded = outcomes.some((o) => o.kind === 'excluded');
      const explanationsText = outcomes.map(describe).join(' | ');

      process.stdout.write(
        csvLine([
          ad.id,
          ad.firstSeenAt.toISOString(),
          ad.source,
          ad.company,
          ad.title,
          strength.toFixed(3),
          best?.label ?? '',
          best?.tier ?? '',
          best?.matchedTerm ?? '',
          best?.viaLongWord ?? '',
          excluded ? 'yes' : 'no',
          explanationsText,
        ]) + '\n',
      );
    }
  });
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await client.end();
  });
