/**
 * Direct tests for `computeMatch` — the single source of truth for
 * title × direction matching. Curation and scoring tests already cover
 * the tier arithmetic *as applied by their callers*; these tests pin the
 * shape of the return value itself (matchedTerm provenance, viaLongWord
 * populated correctly, surface reported honestly) so the explain-the-match
 * UI can be built on it without surprises.
 */
import { describe, expect, it } from 'vitest';
import { computeMatch, containsWord, tokenize } from '../src/matching';

describe('computeMatch — return shape', () => {
  it('empty searchTerms returns the null-match sentinel', () => {
    const r = computeMatch('Senior Product Manager', null, []);
    expect(r).toEqual({
      tier: 0,
      matchedTerm: null,
      viaFullPhrase: false,
      viaLongWord: null,
      surface: 'none',
    });
  });

  it('tier 1.0 — full phrase in title, matchedTerm is the winning term', () => {
    const r = computeMatch('Senior Product Manager', null, ['product manager', 'other role']);
    expect(r.tier).toBe(1.0);
    expect(r.matchedTerm).toBe('product manager');
    expect(r.viaFullPhrase).toBe(true);
    expect(r.viaLongWord).toBeNull();
    expect(r.surface).toBe('title');
  });

  it('tier 0.8 — full phrase in description when title misses', () => {
    const r = computeMatch(
      'Growth Lead',
      'You will act as our Product Manager for the growth pod.',
      ['product manager'],
    );
    expect(r.tier).toBe(0.8);
    expect(r.matchedTerm).toBe('product manager');
    expect(r.viaFullPhrase).toBe(true);
    expect(r.surface).toBe('description');
  });

  it('tier 0.6 — long-word (non-role-suffix) in title, viaLongWord populated', () => {
    const r = computeMatch('Distributed Data Platform Lead', null, ['distributed systems engineer']);
    expect(r.tier).toBe(0.6);
    expect(r.matchedTerm).toBe('distributed systems engineer');
    expect(r.viaFullPhrase).toBe(false);
    // "engineer" is a role suffix (blocked); "systems" is 7 chars (below floor);
    // "distributed" (11 chars, domain word) is the winning long-word.
    expect(r.viaLongWord).toBe('distributed');
    expect(r.surface).toBe('title');
  });

  it('tier 0.4 — long-word in description window only', () => {
    const r = computeMatch(
      'Growth Lead',
      'Owning the distributed platform roadmap end-to-end.',
      ['distributed systems'],
    );
    expect(r.tier).toBe(0.4);
    expect(r.viaLongWord).toBe('distributed');
    expect(r.surface).toBe('description');
  });

  it('description past DESCRIPTION_MATCH_CHARS does not count', () => {
    const filler = 'x'.repeat(500);
    const r = computeMatch('Growth Lead', `${filler} Distributed Systems`, ['distributed']);
    expect(r.tier).toBe(0);
  });

  it('null description collapses to title-only', () => {
    const r = computeMatch('Growth Lead', null, ['distributed']);
    expect(r.tier).toBe(0);
  });
});

describe('computeMatch — role-suffix blocklist', () => {
  it('a role suffix (engineer) does NOT count as a long-word on its own', () => {
    // "engineer" is 8 chars but in NON_DISCRIMINATIVE_ROLE_WORDS — a
    // "Sales Engineer" must not match a "software engineer" direction.
    const r = computeMatch('Sales Engineer', null, ['software engineer']);
    expect(r.tier).toBe(0);
  });

  it('a role suffix still contributes when the full phrase matches', () => {
    const r = computeMatch('Senior Software Engineer', null, ['software engineer']);
    expect(r.tier).toBe(1.0);
  });

  it('director alone (from "Creative Director") does not match "Sales Director"', () => {
    const r = computeMatch('Sales Director', null, ['creative director', 'design director']);
    expect(r.tier).toBe(0);
  });
});

describe('computeMatch — role synonyms', () => {
  it('"engineer" in the search term matches "developer" in the title (full phrase)', () => {
    const r = computeMatch('Senior Frontend Developer', null, ['frontend engineer']);
    expect(r.tier).toBe(1.0);
  });

  it('"engineer" search matches "entwickler" title (German synonym)', () => {
    const r = computeMatch('Senior Frontend Entwickler', null, ['frontend engineer']);
    expect(r.tier).toBe(1.0);
  });
});

describe('computeMatch — determinism + provenance', () => {
  it('first matching searchTerm wins (order-preserving)', () => {
    const r = computeMatch('Senior Product Manager', null, [
      'product manager',
      'senior manager',
    ]);
    expect(r.matchedTerm).toBe('product manager');
  });

  it('long-word tier reports the source searchTerm the winning word came from', () => {
    const r = computeMatch('Kubernetes Platform Lead', null, [
      'typescript engineer',
      'kubernetes engineer',
    ]);
    expect(r.tier).toBe(0.6);
    expect(r.matchedTerm).toBe('kubernetes engineer');
    expect(r.viaLongWord).toBe('kubernetes');
  });
});

describe('computeMatch — Spanish ↔ English cross-language matching', () => {
  it('CV in Spanish ("diseñador ux") matches an English ad title ("UX Designer")', () => {
    const r = computeMatch('Senior UX Designer', null, ['diseñador ux']);
    expect(r.tier).toBe(1.0);
    expect(r.matchedTerm).toBe('diseñador ux');
  });

  it('CV in English ("ux designer") matches a Spanish ad title ("Diseñadora UX")', () => {
    const r = computeMatch('Diseñadora UX Senior', null, ['ux designer']);
    expect(r.tier).toBe(1.0);
  });

  it('unaccented Spanish ("disenador") matches accented Spanish ad title', () => {
    // A common real-world case: recruiters and ATS strip tildes.
    const r = computeMatch('Diseñador de Producto', null, ['disenador de producto']);
    expect(r.tier).toBe(1.0);
  });

  it('engineer synonym family bridges EN/DE/ES', () => {
    // Spanish CV → English ad.
    expect(computeMatch('Backend Engineer', null, ['ingeniero backend']).tier).toBe(1.0);
    // Spanish CV → German ad.
    expect(computeMatch('Backend Entwickler', null, ['ingeniero backend']).tier).toBe(1.0);
    // English CV → Spanish ad.
    expect(computeMatch('Desarrollador Backend', null, ['backend engineer']).tier).toBe(1.0);
  });

  it('Spanish role suffixes are also blocked from the long-word tier', () => {
    // "director" already blocked; here we exercise the Spanish additions.
    // "Diseñador de UX" as searchTerm → "diseñador" (9) is a role suffix,
    // so a title with only "diseñador" (no other CV word) still needs the
    // full phrase to match. A "Diseñador Comercial" ad must not match a
    // "Diseñador de Producto UX" direction on "diseñador" alone.
    const r = computeMatch('Diseñador Comercial', null, ['diseñador de producto ux']);
    expect(r.tier).toBe(0);
  });

  it('a Spanish direction "creativo publicitario" matches on the domain long-word', () => {
    // "creativo" (8) is not a role suffix → long-word tier accepts.
    const r = computeMatch('Head of Creativo Digital', null, ['creativo publicitario']);
    expect(r.tier).toBe(0.6);
    expect(r.viaLongWord).toBe('creativo');
  });
});

describe('tokenize + containsWord (helpers)', () => {
  it('tokenize splits on punctuation, drops stop words and short tokens', () => {
    expect(tokenize('Senior Product Manager, mit UX')).toEqual(['senior', 'product', 'manager']);
    // "mit" is a German stop word; "UX" is under 3 chars → dropped.
  });

  it('containsWord respects ROLE_SYNONYMS', () => {
    expect(containsWord('senior frontend developer', 'engineer')).toBe(true);
    expect(containsWord('senior product manager', 'managerin')).toBe(true);
    expect(containsWord('senior sales director', 'designer')).toBe(false);
  });
});
