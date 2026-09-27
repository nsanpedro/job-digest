/**
 * Descriptions in matching (ADR-003 §8.x). Every caller of the match ladder
 * now passes `ads.description`: the ingest gate (`directionFitStrength`),
 * the digest read gate (`explainMatch` → `isDirectionHit`) and ranking
 * (`directionFit` / `scoreAd`). These tests pin:
 *
 *   - the motivating case — a generic title whose lede names the role —
 *     reaches the description tier at every caller;
 *   - the anti-boilerplate guards: the 400-char window, the tight-phrase
 *     rule for prose, no one-word "phrases" in prose;
 *   - the digest gate's policy: a lone description long-word does not put
 *     an ad in a direction;
 *   - null / omitted description = exactly the old title-only numbers.
 *
 * Kept in its own file (not scoring.test.ts / matching.test.ts) so the
 * feature's contract reads in one place.
 */
import { describe, expect, it } from 'vitest';
import { computeMatch, DESCRIPTION_MATCH_CHARS } from '../src/matching';
import { directionFitStrength, CURATION_THRESHOLDS } from '../src/curation';
import { explainMatch, isDirectionHit, type ExplainableDirection, type MatchExplanation } from '../src/explain-match';
import { DEFAULT_CALIBRATION, directionFit, scoreAd, type ScoringDirection } from '../src/scoring';
import type { Facts, Ruleset } from '../src/index';

const EM_TERMS = ['Engineering Manager'];
const GENERIC_TITLE = 'Software Engineer (m/w/d)';
const EM_LEDE = 'We are hiring an Engineering Manager for our frontend team. You will lead six engineers.';

/** Typical company-intro + EEO boilerplate, comfortably longer than the match window. */
const BOILERPLATE =
  'Acme GmbH is a Berlin-based company founded in 2012 with offices in Munich, Hamburg and Vienna. ' +
  'We value diversity and welcome applications from all backgrounds regardless of gender, age, religion, ' +
  'disability or sexual orientation. Our benefits include flexible hours, a public transport ticket, ' +
  'a learning budget, company pension scheme, sports membership, team events and 30 days of holiday a year.\n';

const adjacent = (searchTerms: string[], excludeTerms: string[] = []) => ({
  distance: 'adjacent' as const,
  searchTerms,
  excludeTerms,
});

const explainDir = (label: string, searchTerms: string[]): ExplainableDirection => ({
  label,
  distance: 'adjacent',
  searchTerms,
  excludeTerms: [],
});

describe('computeMatch — description window', () => {
  it('a generic title whose lede names the role reaches tier 0.8', () => {
    expect(computeMatch(GENERIC_TITLE, null, EM_TERMS).tier).toBe(0);
    const r = computeMatch(GENERIC_TITLE, EM_LEDE, EM_TERMS);
    expect(r).toMatchObject({ tier: 0.8, surface: 'description', matchedTerm: 'Engineering Manager', viaFullPhrase: true });
  });

  it('the same sentence past DESCRIPTION_MATCH_CHARS of boilerplate does not count', () => {
    expect(BOILERPLATE.length).toBeGreaterThan(DESCRIPTION_MATCH_CHARS);
    expect(computeMatch(GENERIC_TITLE, BOILERPLATE + EM_LEDE, EM_TERMS).tier).toBe(0);
  });

  it('a title match still wins over the description (1.0, surface title)', () => {
    const r = computeMatch('Engineering Manager (m/w/d)', EM_LEDE, EM_TERMS);
    expect(r).toMatchObject({ tier: 1.0, surface: 'title' });
  });

  it('term words scattered across a prose sentence are not a phrase', () => {
    // Title rule would accept this (both words, in order, one segment);
    // in prose they are two tokens apart — a frontend engineer ad that
    // mentions the product manager is not an Engineering Manager ad.
    const desc = 'You will work closely with our engineering team and the product manager on checkout.';
    expect(computeMatch('Frontend Engineer', desc, EM_TERMS).tier).toBe(0);
  });

  it('one token between term words is still a phrase', () => {
    const desc = 'Join our Engineering leadership as Manager of the payments group.';
    // "engineering leadership manager" — one token between.
    expect(computeMatch(GENERIC_TITLE, desc, EM_TERMS).tier).toBe(0.8);
  });

  it('a heading line on its own is its own segment', () => {
    const desc = 'Engineering Manager (m/w/d)\nAbout us\nWe build logistics software.';
    expect(computeMatch('Job 4711', desc, EM_TERMS).tier).toBe(0.8);
  });

  it('a one-word term never reaches 0.8 from prose — it gets the long-word tier or nothing', () => {
    // Domain word, ≥ 8 chars → long-word tier 0.4.
    expect(computeMatch('Developer', 'Our stack is TypeScript and Go.', ['typescript'])).toMatchObject({
      tier: 0.4,
      viaLongWord: 'typescript',
    });
    // Role-suffix word → blocked from the long-word tier, so nothing.
    expect(computeMatch('Account Lead', 'You will support our engineers.', ['engineer']).tier).toBe(0);
    // In a title a one-word term is still a full phrase, as before.
    expect(computeMatch('Senior Engineer', null, ['engineer']).tier).toBe(1.0);
  });

  it('no Role, Qualifier inversion in prose', () => {
    // In a title "Engineer, Frontend" reads as a frontend engineer. In prose,
    // a bare "Engineer" line plus "frontend" somewhere else is not the phrase.
    const desc = 'Engineer\nYou will pair with the frontend chapter on accessibility.';
    expect(computeMatch('Platform Role', desc, ['frontend engineer']).tier).toBe(0.4);
    expect(computeMatch('Software Engineer, Frontend', null, ['frontend engineer']).tier).toBe(1.0);
  });
});

describe('directionFitStrength (ingest gate) with a description', () => {
  const dirs = [adjacent(EM_TERMS)];

  it('a focused user gets the generic-title EM ad in on its lede', () => {
    expect(directionFitStrength(GENERIC_TITLE, null, dirs)).toBe(0);
    expect(directionFitStrength(GENERIC_TITLE, EM_LEDE, dirs)).toBe(0.8);
    expect(directionFitStrength(GENERIC_TITLE, EM_LEDE, dirs)).toBeGreaterThanOrEqual(CURATION_THRESHOLDS.focused);
  });

  it('boilerplate past the window does not', () => {
    expect(directionFitStrength(GENERIC_TITLE, BOILERPLATE + EM_LEDE, dirs)).toBe(0);
  });

  it('a lone description long-word clears discovery but not focused', () => {
    const d = [adjacent(['distributed systems'])];
    const s = directionFitStrength('Backend Engineer', 'Build our distributed payments ledger.', d);
    expect(s).toBe(0.4);
    expect(s).toBeGreaterThanOrEqual(CURATION_THRESHOLDS.discovery);
    expect(s).toBeLessThan(CURATION_THRESHOLDS.focused);
  });
});

describe('isDirectionHit (digest read gate)', () => {
  const run = (title: string, desc: string | null, terms: string[]): MatchExplanation =>
    explainMatch(title, desc, [explainDir('D', terms)])[0]!;

  it('title matches count, as before', () => {
    expect(isDirectionHit(run('Engineering Manager', null, EM_TERMS))).toBe(true);
    expect(isDirectionHit(run('Distributed Backend Role', null, ['distributed systems']))).toBe(true);
  });

  it('a full phrase in the description lede counts', () => {
    const exp = run(GENERIC_TITLE, EM_LEDE, EM_TERMS);
    expect(exp).toMatchObject({ kind: 'matched', surface: 'description', via: 'full-phrase', tier: 0.8 });
    expect(isDirectionHit(exp)).toBe(true);
  });

  it('a lone description long-word is explained but does not count', () => {
    const exp = run('Backend Engineer', 'Build our distributed payments ledger.', ['distributed systems']);
    expect(exp).toMatchObject({ kind: 'matched', surface: 'description', via: 'long-word', tier: 0.4 });
    expect(isDirectionHit(exp)).toBe(false);
  });

  it('no-signal and excluded never count', () => {
    expect(isDirectionHit(run('Chef', null, EM_TERMS))).toBe(false);
    const excluded = explainMatch('Sales Engineering Manager', null, [
      { label: 'EM', distance: 'adjacent', searchTerms: EM_TERMS, excludeTerms: ['sales'] },
    ])[0]!;
    expect(excluded.kind).toBe('excluded');
    expect(isDirectionHit(excluded)).toBe(false);
  });
});

describe('ranking with a description', () => {
  const now = new Date('2026-09-21T12:00:00Z');
  const NO_FACTS: Facts = {
    rotating: null, weekend: null, german: null, home: null, pay: null,
    payMax: null, payFte: null, fteNote: null, permanent: null, commuteMin: null,
  };
  const ruleset: Ruleset = {
    Shift: { key: 'Shift', severity: 'hard', condition: { noRotating: true, noWeekend: true } },
    German: { key: 'German', severity: 'preference', condition: { maxDemanded: 'B2' } },
    Onsite: { key: 'Onsite', severity: 'preference', condition: { minHomeDays: 2 } },
    Pay: { key: 'Pay', severity: 'hard', condition: { minMonthly: 2600, basis: 'fte' } },
    Contract: { key: 'Contract', severity: 'preference', condition: { permanentOnly: true } },
  };
  const dirs: ScoringDirection[] = [{ distance: 'adjacent', searchTerms: EM_TERMS }];
  const base = {
    facts: NO_FACTS,
    verdicts: [],
    ruleset,
    directions: dirs,
    title: GENERIC_TITLE,
    source: 'Greenhouse',
    receivedAt: now,
    now,
    calibration: DEFAULT_CALIBRATION,
  };

  it('directionFit: omitted and null description are the title-only number', () => {
    expect(directionFit(GENERIC_TITLE, dirs)).toBe(0);
    expect(directionFit(GENERIC_TITLE, dirs, null)).toBe(0);
    expect(directionFit('Engineering Manager', dirs)).toBe(1.0);
  });

  it('directionFit: the lede lifts a generic title to 0.8; boilerplate does not', () => {
    expect(directionFit(GENERIC_TITLE, dirs, EM_LEDE)).toBe(0.8);
    expect(directionFit(GENERIC_TITLE, dirs, BOILERPLATE + EM_LEDE)).toBe(0);
    // Stretch direction halves description evidence like title evidence.
    expect(directionFit(GENERIC_TITLE, [{ distance: 'stretch', searchTerms: EM_TERMS }], EM_LEDE)).toBe(0.4);
  });

  it('scoreAd without a description is identical whether omitted or null', () => {
    expect(scoreAd({ ...base, description: null })).toEqual(scoreAd(base));
  });

  it('scoreAd with a lede that names the role scores the ad higher', () => {
    const without = scoreAd(base);
    const withLede = scoreAd({ ...base, description: EM_LEDE });
    expect(without.directionFit).toBe(0);
    expect(withLede.directionFit).toBe(0.8);
    expect(withLede.total).toBeGreaterThan(without.total);
    // Boilerplate-only description: same as no description.
    expect(scoreAd({ ...base, description: BOILERPLATE + EM_LEDE })).toEqual(without);
  });
});
