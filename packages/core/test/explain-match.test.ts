/**
 * Tests for `explainMatch` / `describeMatch`. Pins the return-shape
 * contract so the "why is this here?" UI (and every log line built on it)
 * can rely on discriminated-union narrowing and stable wording.
 */
import { describe, expect, it } from 'vitest';
import {
  describeMatch,
  explainMatch,
  type ExplainableDirection,
} from '../src/explain-match';
import type { Distance } from '../src/discovery';

const dir = (
  label: string,
  searchTerms: string[],
  excludeTerms: string[] = [],
  distance: Distance = 'adjacent',
): ExplainableDirection => ({ label, distance, searchTerms, excludeTerms });

describe('explainMatch — outcomes', () => {
  it('matched via full phrase in title', () => {
    const [exp] = explainMatch('Senior Creative Director', null, [
      dir('Creative Director', ['creative director']),
    ]);
    expect(exp).toMatchObject({
      kind: 'matched',
      label: 'Creative Director',
      distance: 'adjacent',
      tier: 1.0,
      matchedTerm: 'creative director',
      via: 'full-phrase',
      surface: 'title',
      longWord: null,
    });
  });

  it('matched via long-word in description reports the winning domain word', () => {
    const [exp] = explainMatch(
      'Growth Lead',
      'Owning our distributed data platform end-to-end.',
      [dir('Distributed Systems', ['distributed systems engineer'])],
    );
    expect(exp.kind).toBe('matched');
    if (exp.kind !== 'matched') throw new Error('narrowing');
    expect(exp.via).toBe('long-word');
    expect(exp.longWord).toBe('distributed');
    expect(exp.surface).toBe('description');
    expect(exp.tier).toBe(0.4);
  });

  it('excluded reports which term and where', () => {
    const [exp] = explainMatch('Senior Sales Manager', null, [
      dir('Product Manager', ['product manager'], ['sales']),
    ]);
    expect(exp).toEqual({
      kind: 'excluded',
      label: 'Product Manager',
      distance: 'adjacent',
      term: 'sales',
      where: 'title',
    });
  });

  it('excluded takes precedence over an otherwise-matching direction', () => {
    // "product manager" would match at tier 1.0; the exclude "sales" in
    // the title short-circuits and the outcome is 'excluded', not 'matched'.
    const [exp] = explainMatch('Sales Product Manager', null, [
      dir('Product Manager', ['product manager'], ['sales']),
    ]);
    expect(exp.kind).toBe('excluded');
  });

  it('no-signal when the direction neither matches nor excludes', () => {
    const [exp] = explainMatch('Marketing Coordinator', null, [
      dir('Backend Engineer', ['backend engineer'], ['sales']),
    ]);
    expect(exp).toEqual({
      kind: 'no-signal',
      label: 'Backend Engineer',
      distance: 'adjacent',
    });
  });

  it('empty directions returns an empty array', () => {
    expect(explainMatch('Anything', null, [])).toEqual([]);
  });

  it('order is preserved so callers can zip against their own direction list', () => {
    const exps = explainMatch('Senior Backend Engineer', null, [
      dir('Product Manager', ['product manager']),
      dir('Backend Engineer', ['backend engineer']),
      dir('Marketing', ['marketing lead']),
    ]);
    expect(exps.map((e) => e.label)).toEqual([
      'Product Manager',
      'Backend Engineer',
      'Marketing',
    ]);
    expect(exps[0].kind).toBe('no-signal');
    expect(exps[1].kind).toBe('matched');
    expect(exps[2].kind).toBe('no-signal');
  });

  it('word-boundary excludes — "lead" does not clobber "Leadership"', () => {
    // Same rule as directionFitStrength: exclude uses \b, not substring.
    const [exp] = explainMatch('Head of Engineering Leadership', null, [
      dir('Engineering Leadership', ['engineering leadership'], ['lead']),
    ]);
    expect(exp.kind).toBe('matched');
  });
});

describe('describeMatch — human wording', () => {
  it('full-phrase renders the source term and the surface', () => {
    const s = describeMatch({
      kind: 'matched',
      label: 'Creative Director',
      distance: 'adjacent',
      tier: 1.0,
      matchedTerm: 'creative director',
      via: 'full-phrase',
      surface: 'title',
      longWord: null,
    });
    expect(s).toBe('Matched “Creative Director” — full phrase “creative director” in title.');
  });

  it('long-word renders both the winning word and the source term', () => {
    const s = describeMatch({
      kind: 'matched',
      label: 'Kubernetes',
      distance: 'adjacent',
      tier: 0.6,
      matchedTerm: 'kubernetes engineer',
      via: 'long-word',
      surface: 'title',
      longWord: 'kubernetes',
    });
    expect(s).toBe('Matched “Kubernetes” — long-word “kubernetes” from “kubernetes engineer” in title.');
  });

  it('excluded names the term and the surface', () => {
    const s = describeMatch({
      kind: 'excluded',
      label: 'Product Manager',
      distance: 'adjacent',
      term: 'sales',
      where: 'title',
    });
    expect(s).toBe('Excluded from “Product Manager” — “sales” in title.');
  });

  it('no-signal is a short honest sentence', () => {
    const s = describeMatch({
      kind: 'no-signal',
      label: 'Backend Engineer',
      distance: 'adjacent',
    });
    expect(s).toBe('No match for “Backend Engineer”.');
  });
});

describe('explainMatch — ad-level exclude view (derived by caller)', () => {
  it('any excluded outcome in the array signals an ad-level exclude', () => {
    // The ingest gate applies excludes ad-level (union across dirs). The
    // explainer returns per-direction; the ad-level view is derived.
    const exps = explainMatch('Sales Solutions Engineer', null, [
      dir('Product Manager', ['product manager'], ['sales']),
      dir('Solutions Engineer', ['solutions engineer']),
    ]);
    const excluded = exps.find((e) => e.kind === 'excluded');
    expect(excluded).toBeDefined();
    expect(excluded!.kind === 'excluded' && excluded.term).toBe('sales');
    // The second direction still reports its own outcome ('matched') — a
    // consumer that wants to render "would have matched but the ad is
    // excluded" has both halves.
    expect(exps[1].kind).toBe('matched');
  });
});
