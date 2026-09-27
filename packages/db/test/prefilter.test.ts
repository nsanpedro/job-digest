/**
 * `applyPreFilters` — pass 2 of `getDigest` (direction gate, then the level
 * gate of ADR-003 §8.7). Pure, so no database; the titles are the real ones
 * from the ranking eval on a lead + senior account.
 */
import { describe, expect, it } from 'vitest';
import { applyPreFilters } from '../src/queries/digest';
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

const entry = (title: string) => ({ ad: { title } });
const titles = (xs: ReadonlyArray<{ ad: { title: string } }>) => xs.map((x) => x.ad.title);

const DISMISSED_ENTRY_LEVEL = [
  'Junior Software Engineer (m/w/d)',
  'Werkstudent Softwareentwicklung (m/w/d) – Greenfield / KI Fokus, InsurTech',
  'Intern - Front-End Developer (all gender) (Fleet Energy Performance)',
  '(Junior) Software Entwickler:in (m/w/d) | Java / Python / Apex',
  'Junior Frontend Developer / Softwareentwickler:in',
];

const MUST_KEEP = [
  'Senior Frontend Engineer',
  'Engineering Manager (m/w/d)',
  'Frontend Developer (m/w/d) React',
  'Staff Engineer - Virtual Assembly Line (m/f/d)',
  'Head of Frontend Development (iGaming)',
];

const LEAD_SENIOR = { seniorities: ['lead', 'senior'] } as const;

describe('applyPreFilters', () => {
  it('level gate alone: entry-level titles go to explore, the rest pass', () => {
    const split = applyPreFilters([...DISMISSED_ENTRY_LEVEL, ...MUST_KEEP].map(entry), [], LEAD_SENIOR);
    expect(split.active).toBe(true);
    expect(titles(split.belowTargetLevel)).toEqual(DISMISSED_ENTRY_LEVEL);
    expect(titles(split.passed)).toEqual(MUST_KEEP);
    expect(split.directionMisses).toEqual([]);
  });

  it('with directions: every entry-level title leaves the scored pool, and none is counted twice', () => {
    const dirs = [
      direction('Team Lead Frontend', ['Team Lead Software Entwicklung', 'Frontend Engineer']),
      direction('Engineering Manager', ['Engineering Manager', 'Head of Frontend']),
    ];
    const all = [...DISMISSED_ENTRY_LEVEL, ...MUST_KEEP].map(entry);
    const split = applyPreFilters(all, dirs, LEAD_SENIOR);
    for (const t of DISMISSED_ENTRY_LEVEL) expect(titles(split.passed)).not.toContain(t);
    // No keep-title is ever read as below the level; whether it passes is the matcher's call.
    for (const t of MUST_KEEP) expect(titles(split.belowTargetLevel)).not.toContain(t);
    expect(split.passed.length + split.directionMisses.length + split.belowTargetLevel.length).toBe(all.length);
  });

  it('an off-direction entry-level ad counts as a direction miss, not a level miss', () => {
    const split = applyPreFilters(
      [entry('Junior Accountant (m/w/d)')],
      [direction('Frontend Engineer', ['Frontend Engineer'])],
      LEAD_SENIOR,
    );
    expect(titles(split.directionMisses)).toEqual(['Junior Accountant (m/w/d)']);
    expect(split.belowTargetLevel).toEqual([]);
  });

  it('off for a user who targets junior, or names no rung', () => {
    const all = DISMISSED_ENTRY_LEVEL.map(entry);
    expect(applyPreFilters(all, [], { seniorities: ['junior', 'senior'] }).passed).toHaveLength(all.length);
    const none = applyPreFilters(all, [], { seniorities: [] });
    expect(none.passed).toHaveLength(all.length);
    // Neither gate had signal: getDigest reports `metrics.explore` as null.
    expect(none.active).toBe(false);
  });
});
