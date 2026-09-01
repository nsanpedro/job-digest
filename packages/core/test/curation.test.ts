/**
 * Curation gate — one describe block per function, with a table for the
 * tier boundaries in directionFitStrength. Same style as scoring.test.ts.
 * Every tier and every short-circuit has its own case so a change in the
 * formula surfaces here, not in the ingest wire test.
 */
import { describe, expect, it } from 'vitest';
import {
  CURATION_THRESHOLDS,
  directionFitStrength,
  inferMode,
  type CurationDirection,
} from '../src/curation';

const adjacent = (
  searchTerms: string[],
  excludeTerms: string[] = [],
): CurationDirection => ({
  distance: 'adjacent',
  searchTerms,
  excludeTerms,
});

const stretch = (
  searchTerms: string[],
  excludeTerms: string[] = [],
): CurationDirection => ({
  distance: 'stretch',
  searchTerms,
  excludeTerms,
});

describe('inferMode', () => {
  it('discovery when no directions', () => {
    expect(inferMode([])).toBe('discovery');
  });

  it('focused with 1 direction', () => {
    expect(inferMode([{ distance: 'adjacent' }])).toBe('focused');
  });

  it('focused with 3 directions', () => {
    expect(inferMode([
      { distance: 'adjacent' },
      { distance: 'adjacent' },
      { distance: 'stretch' },
    ])).toBe('focused');
  });

  it('discovery with 4+ directions', () => {
    expect(inferMode([
      { distance: 'adjacent' },
      { distance: 'adjacent' },
      { distance: 'adjacent' },
      { distance: 'stretch' },
    ])).toBe('discovery');
  });
});

describe('directionFitStrength — tiers', () => {
  const dirs = [adjacent(['Product Manager'])];

  it('returns 1.0 on full-phrase title match', () => {
    expect(directionFitStrength('Senior Product Manager', null, dirs)).toBe(1.0);
  });

  it('returns 0.8 on full-phrase description match when title misses', () => {
    expect(directionFitStrength('Growth Lead', 'You will act as our Product Manager for the growth pod.', dirs)).toBe(0.8);
  });

  it('returns 0.6 on long-word (≥8, non-role-suffix) title match when full phrase misses', () => {
    // "Product" is 7 chars — not long-word. Pick a searchTerm whose long
    // word is domain-specific (not in NON_DISCRIMINATIVE_ROLE_WORDS): a
    // long word that IS a role suffix (engineer/director/onboarding/...)
    // needs the full phrase to count — that's the "Sales Director" fix.
    const d = [adjacent(['distributed systems'])];
    expect(directionFitStrength('Distributed Backend Role', null, d)).toBe(0.6);
  });

  it('returns 0.4 on long-word description match when title and full phrase miss', () => {
    const d = [adjacent(['distributed systems'])];
    expect(
      directionFitStrength(
        'Head of Growth',
        'You will own the roadmap for our distributed platform.',
        d,
      ),
    ).toBe(0.4);
  });

  it('returns 0 when nothing matches', () => {
    expect(directionFitStrength('Marketing Coordinator', 'Own the campaign calendar.', dirs)).toBe(0);
  });

  it('returns 1.0 across empty directions (belt-and-braces)', () => {
    expect(directionFitStrength('Anything', null, [])).toBe(1.0);
  });
});

describe('directionFitStrength — exclude terms (ad-level)', () => {
  it('exclude hit in title zeros the ad even on full-phrase match', () => {
    const dirs = [adjacent(['Product Manager'], ['sales'])];
    expect(directionFitStrength('Sales Product Manager', null, dirs)).toBe(0);
  });

  it('exclude hit in description zeros the ad', () => {
    const dirs = [adjacent(['Product Manager'], ['insurance'])];
    expect(directionFitStrength('Senior Product Manager', 'Own our insurance products end-to-end.', dirs)).toBe(0);
  });

  it('exclude on one direction zeros the ad even when another direction matches', () => {
    // Semantics: excludes are ad-level. A user who sets "no sales" on any
    // direction means "not sales" for the whole ad — matching a permissive
    // second direction (Solutions Consultant) does not undo it. See the
    // docstring of directionFitStrength for the rationale.
    const dirs = [
      adjacent(['Product Manager'], ['sales']),
      adjacent(['Solutions Consultant']),
    ];
    expect(directionFitStrength('Sales Solutions Consultant', null, dirs)).toBe(0);
  });

  it('empty excludeTerms behaves like no filter', () => {
    const dirs = [adjacent(['Product Manager'], [])];
    expect(directionFitStrength('Sales Product Manager', null, dirs)).toBe(1.0);
  });

  it('exclude uses word boundaries — "lead" does not clobber "Leadership"', () => {
    // The substring bug: an exclude "lead" used to match "Leadership",
    // silently zeroing legitimate leadership-adjacent ads. Word-boundary
    // regex closes it.
    const dirs = [adjacent(['Engineering Leadership'], ['lead'])];
    // 'lead' is present as a whole word in "Team Lead" → excluded.
    expect(directionFitStrength('Team Lead', null, dirs)).toBe(0);
    // 'lead' as a substring of "Leadership" is NOT a hit.
    expect(directionFitStrength('Head of Engineering Leadership', null, dirs)).toBe(1.0);
  });

  it('exclude "sales" does not clobber "wholesale"', () => {
    const dirs = [adjacent(['Product Manager'], ['sales'])];
    // A description mentioning "wholesale" is not a sales exclude hit.
    expect(
      directionFitStrength(
        'Senior Product Manager',
        'You will own our wholesale distribution channel.',
        dirs,
      ),
    ).toBe(1.0);
    // Real "sales" as a word is still excluded.
    expect(directionFitStrength('Senior Sales Manager', null, dirs)).toBe(0);
  });

  it('multi-word exclude requires the whole phrase', () => {
    const dirs = [adjacent(['Backend Engineer'], ['customer success'])];
    // Both words but not adjacent as a phrase → NOT excluded.
    expect(
      directionFitStrength(
        'Backend Engineer',
        'Reporting to the customer team; success metrics owned by product.',
        dirs,
      ),
    ).toBe(1.0);
    // Adjacent phrase in description → excluded.
    expect(
      directionFitStrength(
        'Backend Engineer',
        'Embedded in the customer success org.',
        dirs,
      ),
    ).toBe(0);
  });
});

describe('directionFitStrength — distance factor', () => {
  it('stretch × full-phrase title = 0.5', () => {
    expect(directionFitStrength('Product Manager', null, [stretch(['Product Manager'])])).toBe(0.5);
  });

  it('stretch × long-word title = 0.3 (accepted in discovery, rejected in focused)', () => {
    const d = [stretch(['distributed systems'])];
    const strength = directionFitStrength('Distributed Backend Role', null, d);
    expect(strength).toBeCloseTo(0.3, 5);
    expect(strength).toBeGreaterThanOrEqual(CURATION_THRESHOLDS.discovery);
    expect(strength).toBeLessThan(CURATION_THRESHOLDS.focused);
  });

  it('best wins across directions of different distances', () => {
    const dirs = [
      stretch(['Product Manager']),   // 0.5
      adjacent(['Engineer']),          // 1.0 on a match, but title is PM → 0
    ];
    // Title matches only the stretch direction.
    expect(directionFitStrength('Senior Product Manager', null, dirs)).toBe(0.5);
  });
});

describe('directionFitStrength — role synonyms + description window', () => {
  it('applies role synonyms in title (engineer ↔ developer ↔ entwickler)', () => {
    const dirs = [adjacent(['Backend Engineer'])];
    expect(directionFitStrength('Backend Developer (m/w/d)', null, dirs)).toBe(1.0);
    expect(directionFitStrength('Backend Entwickler', null, dirs)).toBe(1.0);
  });

  it('ignores description content beyond DESCRIPTION_MATCH_CHARS', () => {
    const dirs = [adjacent(['Product Manager'])];
    const filler = 'x'.repeat(500);
    const description = filler + ' Product Manager for the fintech pod.';
    // The match phrase is past char 400 — should not count.
    expect(directionFitStrength('Growth Lead', description, dirs)).toBe(0);
  });

  it('CURATION_THRESHOLDS constants are the ones the wire expects', () => {
    // focused = 0.7 sits above the long-word tier (0.6) so a focused user
    // only lets a title in on a full-phrase match. See CURATION_THRESHOLDS
    // docstring for the reasoning behind 0.7 vs 0.6.
    expect(CURATION_THRESHOLDS.focused).toBe(0.7);
    expect(CURATION_THRESHOLDS.discovery).toBe(0.3);
  });
});

// ── Regression: real-world false positives that used to leak through ────────

describe('directionFitStrength — role-suffix false positives (the bug this fixes)', () => {
  it('a designer CV proposing "Creative Director" does NOT match "Sales Director"', () => {
    // The exact case reported: CV → adjacent design directions look fine,
    // but the digest then surfaces "Sales Director" / "Marketing Director"
    // because "director" alone (8 chars) used to pass the long-word tier.
    const dirs = [
      adjacent(['Creative Director', 'Design Director', 'Head of Design']),
    ];
    expect(directionFitStrength('Sales Director', null, dirs)).toBe(0);
    expect(directionFitStrength('Marketing Director', null, dirs)).toBe(0);
    expect(directionFitStrength('Regional Director of Operations', null, dirs)).toBe(0);
    // Sanity: the legitimate full-phrase match still lands.
    expect(directionFitStrength('Senior Creative Director', null, dirs)).toBe(1.0);
  });

  it('an "Enterprise Onboarding Designer" direction does NOT match "SMB Onboarding Lead"', () => {
    // Same class: "onboarding" (10 chars) used to be a long-word match on
    // its own. "SMB Onboarding Lead" has nothing to do with design.
    const dirs = [adjacent(['Enterprise Onboarding Designer'])];
    expect(directionFitStrength('SMB Onboarding Lead', null, dirs)).toBe(0);
    // Sanity: a real designer role still matches on the full phrase.
    expect(directionFitStrength('Enterprise Onboarding Designer', null, dirs)).toBe(1.0);
  });

  it('a domain-specific long-word (non-role-suffix) still matches at the 0.6 tier', () => {
    // The blocklist should NOT swallow domain evidence. "kubernetes" (10),
    // "distributed" (11), "healthcare" (10), "typescript" (10) are all
    // discriminative on their own.
    const dirs = [adjacent(['distributed systems engineer'])];
    // "engineer" is blocked, "distributed" is not → 0.6.
    expect(directionFitStrength('Distributed Data Platform Lead', null, dirs)).toBe(0.6);
  });
});
