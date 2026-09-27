/**
 * The digest read gate with a stored description (ADR-003 §8.10
 * "Descriptions in matching"). Pure — `applyPreFilters` and
 * `matchesAnyDirection` need no database.
 */
import { describe, expect, it } from 'vitest';
import { applyPreFilters, matchesAnyDirection } from '../src/queries/digest';
import type { DirectionRow } from '../src/queries/types';

function direction(label: string, searchTerms: string[]): DirectionRow {
  return {
    id: crypto.randomUUID(),
    profileVersion: 1,
    label,
    rationale: '',
    bridge: [],
    searchTerms,
    excludeTerms: [],
    distance: 'adjacent',
    seenTitles: [],
    state: 'interested',
  };
}

const EM = [direction('Engineering Manager', ['Engineering Manager'])];
const GENERIC = 'Software Engineer (m/w/d)';
const LEDE = 'We are hiring an Engineering Manager for our frontend team.';
const BOILERPLATE = 'We are an equal opportunity employer and value diversity at our company. '.repeat(8);
const NONE = { seniorities: [] } as const;

describe('matchesAnyDirection with a description', () => {
  it('title-only when the description is omitted or null (email-alert ads)', () => {
    expect(matchesAnyDirection(GENERIC, EM)).toBe(false);
    expect(matchesAnyDirection(GENERIC, EM, null)).toBe(false);
  });

  it('a full phrase in the lede passes the gate on its own', () => {
    expect(matchesAnyDirection(GENERIC, EM, LEDE)).toBe(true);
  });

  it('the same phrase after 400 chars of boilerplate does not', () => {
    expect(matchesAnyDirection(GENERIC, EM, BOILERPLATE + LEDE)).toBe(false);
  });

  it('a lone description long-word does not put the ad in the direction', () => {
    const dirs = [direction('Distributed', ['distributed systems'])];
    expect(matchesAnyDirection('Backend Engineer', dirs, 'Build our distributed payments ledger.')).toBe(false);
    // …while the same word in the title still does, as before.
    expect(matchesAnyDirection('Distributed Backend Role', dirs, null)).toBe(true);
  });
});

describe('applyPreFilters reads entry.description', () => {
  it('routes by title + description; entries without the field stay title-only', () => {
    const entries = [
      { ad: { title: GENERIC }, description: LEDE },
      { ad: { title: GENERIC }, description: null },
      { ad: { title: GENERIC } },
      { ad: { title: 'Engineering Manager' }, description: null },
    ];
    const split = applyPreFilters(entries, EM, NONE);
    expect(split.passed).toEqual([entries[0], entries[3]]);
    expect(split.directionMisses).toEqual([entries[1], entries[2]]);
  });
});
