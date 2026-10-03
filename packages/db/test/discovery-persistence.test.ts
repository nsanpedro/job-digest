/**
 * `directionInsertValues` — the row mapping `completeDerivation` inserts.
 * Pure, so no database: the Postgres side (onConflictDoNothing on
 * user/version/label) is covered by rls.test.ts.
 */
import type { Direction } from '@job-digest/core';
import { describe, expect, it } from 'vitest';
import { directionInsertValues } from '../src/queries/discovery';

const direction: Direction = {
  label: 'Engineering Manager',
  bridge: ['team lead', 'hiring'],
  rationale: 'Leading engineers and running hiring are the core of the role.',
  searchTerms: ['Engineering Manager', 'Gerente de Ingeniería'],
  excludeTerms: ['Account Manager', 'Sales Manager'],
  distance: 'adjacent',
  seenTitles: [],
};

describe('directionInsertValues', () => {
  it("persists the model's gated exclude terms into exclude_terms", () => {
    const [row] = directionInsertValues('user-1', 3, [direction]);
    expect(row).toEqual({
      userId: 'user-1',
      profileVersion: 3,
      label: 'Engineering Manager',
      rationale: direction.rationale,
      bridge: ['team lead', 'hiring'],
      searchTerms: ['Engineering Manager', 'Gerente de Ingeniería'],
      excludeTerms: ['Account Manager', 'Sales Manager'],
      distance: 'adjacent',
      seenTitles: [],
      state: 'interested',
    });
  });

  it('writes an empty list, never null, when the model proposed none', () => {
    const [row] = directionInsertValues('user-1', 1, [{ ...direction, excludeTerms: [] }]);
    expect(row!.excludeTerms).toEqual([]);
  });

  it('every row is keyed to the new profile version — re-derivation never targets an earlier version', () => {
    const rows = directionInsertValues('user-1', 7, [direction, { ...direction, label: 'Tech Lead' }]);
    expect(rows.map((r) => r.profileVersion)).toEqual([7, 7]);
  });
});
