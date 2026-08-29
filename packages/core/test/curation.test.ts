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

  it('returns 0.6 on long-word (≥8) title match when full phrase misses', () => {
    // "Product" is 7 chars — not long-word. Add a direction whose token is ≥8.
    const d = [adjacent(['engineering leadership'])];
    expect(directionFitStrength('Head of Engineering', null, d)).toBe(0.6);
  });

  it('returns 0.4 on long-word description match when title and full phrase miss', () => {
    const d = [adjacent(['engineering leadership'])];
    expect(directionFitStrength('Head of Growth', 'You will report to the VP of engineering and own the roadmap.', d)).toBe(0.4);
  });

  it('returns 0 when nothing matches', () => {
    expect(directionFitStrength('Marketing Coordinator', 'Own the campaign calendar.', dirs)).toBe(0);
  });

  it('returns 1.0 across empty directions (belt-and-braces)', () => {
    expect(directionFitStrength('Anything', null, [])).toBe(1.0);
  });
});

describe('directionFitStrength — exclude terms', () => {
  it('exclude hit in title zeros this direction even on full-phrase match', () => {
    const dirs = [adjacent(['Engineer'], ['sales'])];
    expect(directionFitStrength('Sales Engineer', null, dirs)).toBe(0);
  });

  it('exclude hit in description zeros this direction', () => {
    const dirs = [adjacent(['Product Manager'], ['insurance'])];
    expect(directionFitStrength('Senior Product Manager', 'Own our insurance products end-to-end.', dirs)).toBe(0);
  });

  it('exclude on one direction does not affect another matching direction', () => {
    const dirs = [
      adjacent(['Engineer'], ['sales']),      // rejects
      adjacent(['Solutions Engineer']),        // matches full-phrase
    ];
    expect(directionFitStrength('Sales Solutions Engineer', null, dirs)).toBe(1.0);
  });

  it('empty excludeTerms behaves like no filter', () => {
    const dirs = [adjacent(['Engineer'], [])];
    expect(directionFitStrength('Sales Engineer', null, dirs)).toBe(1.0);
  });
});

describe('directionFitStrength — distance factor', () => {
  it('stretch × full-phrase title = 0.5', () => {
    expect(directionFitStrength('Product Manager', null, [stretch(['Product Manager'])])).toBe(0.5);
  });

  it('stretch × long-word title = 0.3 (accepted in discovery, rejected in focused)', () => {
    const d = [stretch(['engineering leadership'])];
    const strength = directionFitStrength('Head of Engineering', null, d);
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
    expect(CURATION_THRESHOLDS.focused).toBe(0.6);
    expect(CURATION_THRESHOLDS.discovery).toBe(0.3);
  });
});
