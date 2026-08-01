/**
 * Reading the ruleset in force, with the search mode applied (design §7.7).
 *
 * Its own module rather than part of digest.ts: every read path needs it —
 * the digest, the standing Saved/Dismissed views, and the applications list —
 * and hanging it off any one of them makes the others import from a sibling
 * that also imports back.
 */
import { applyMode, type Mode, type Ruleset } from '@job-digest/core';
import { and, eq } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { rulesets } from '../schema';

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

/**
 * `rules` is the *effective* ruleset — what every read path should evaluate
 * against, so a mode change takes effect everywhere without a second call site
 * remembering to apply it. `savedRules` is what the user actually authored,
 * and is only for the Profile editor: editing the demoted copy would silently
 * rewrite hard rules into preferences the moment someone saved while in urgent
 * mode.
 */
export async function getActiveRuleset(
  db: Db,
  userId: string,
): Promise<{ version: number; rules: Ruleset; savedRules: Ruleset; mode: Mode }> {
  const rows = await db
    .select({ version: rulesets.version, rules: rulesets.rules, mode: rulesets.mode })
    .from(rulesets)
    .where(and(eq(rulesets.userId, userId), eq(rulesets.isActive, true)))
    .limit(1);
  const row = rows[0];
  if (!row) throw new NoActiveRulesetError();
  return {
    version: row.version,
    savedRules: row.rules,
    mode: row.mode,
    rules: applyMode(row.rules, row.mode),
  };
}
