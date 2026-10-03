import { describe, expect, it } from 'vitest';
import { explainMatch } from '../src/explain-match';
import {
  DISMISS_REASONS,
  companyKey,
  dismissedBefore,
  effectsBefore,
  excludeCoveredBy,
  groupExcludeEffects,
  isDismissReason,
  isMutedCompany,
  levelFeedback,
  mutedCompanyKeys,
  planDismissFeedback,
  planExcludeCarryOver,
  suggestExcludeTerms,
  withExcludeEffects,
  withoutExcludeEffects,
  type FeedbackDirection,
  type FeedbackEffect,
  type RetiredExclude,
} from '../src/feedback';

const dir = (
  label: string,
  searchTerms: string[],
  excludeTerms: string[] = [],
  id = label,
): FeedbackDirection => ({ id, label, distance: 'adjacent', searchTerms, excludeTerms });

const effect = (partial: Partial<FeedbackEffect> & Pick<FeedbackEffect, 'kind' | 'value'>): FeedbackEffect => ({
  directionId: null,
  valueKey: partial.kind === 'mute_company' ? companyKey(partial.value)! : partial.value.toLowerCase(),
  createdAt: new Date('2026-09-01T00:00:00Z'),
  ...partial,
});

describe('dismiss reasons', () => {
  it('is a closed set', () => {
    expect(DISMISS_REASONS).toEqual(['wrong_role', 'wrong_level', 'location', 'company', 'other']);
    expect(isDismissReason('company')).toBe(true);
    expect(isDismissReason('salary')).toBe(false);
    expect(isDismissReason(null)).toBe(false);
  });
});

describe('companyKey', () => {
  it('folds case, diacritics and trailing legal forms', () => {
    expect(companyKey('Acme GmbH')).toBe('acme');
    expect(companyKey('ACME GmbH & Co. KG')).toBe('acme');
    expect(companyKey('acme')).toBe('acme');
    expect(companyKey('Müller Consulting AG')).toBe('muller consulting');
    expect(companyKey('Foo Bar e.V.')).toBe('foo bar');
    expect(companyKey('Iberia S.L.U.')).toBe('iberia');
    expect(companyKey('Globex, Inc.')).toBe('globex');
  });

  it('keeps words that are part of the name', () => {
    expect(companyKey('Acme Group')).toBe('acme group');
    expect(companyKey('SE Ventures GmbH')).toBe('se ventures');
    // A name that is nothing but a legal form stays itself rather than vanishing.
    expect(companyKey('AG')).toBe('ag');
  });

  it('null when there is no name to mute', () => {
    expect(companyKey(null)).toBeNull();
    expect(companyKey('')).toBeNull();
    expect(companyKey(' – ')).toBeNull();
  });
});

describe('company mute', () => {
  const muted = mutedCompanyKeys([
    effect({ kind: 'mute_company', value: 'Acme GmbH' }),
    effect({ kind: 'exclude_term', value: 'sales', directionId: 'd1' }),
  ]);

  it('collects only mute effects', () => {
    expect([...muted]).toEqual(['acme']);
  });

  it('matches every spelling of the muted company, and nothing else', () => {
    expect(isMutedCompany('ACME GmbH & Co. KG', muted)).toBe(true);
    expect(isMutedCompany('Acme', muted)).toBe(true);
    expect(isMutedCompany('Acme Group', muted)).toBe(false);
    expect(isMutedCompany('Acmetech', muted)).toBe(false);
    expect(isMutedCompany(null, muted)).toBe(false);
    expect(isMutedCompany('Acme', new Set())).toBe(false);
  });
});

describe('suggestExcludeTerms', () => {
  const pm = dir('Product Manager', ['Product Manager', 'Produktmanager']);

  it('proposes the title word no direction covers, for the matched direction', () => {
    const s = suggestExcludeTerms({ title: 'Senior Product Manager, Sales (m/w/d)' }, [pm]);
    expect(s).toEqual({ directions: [{ id: 'Product Manager', label: 'Product Manager' }], terms: ['sales'] });
  });

  it('never proposes a word already in a direction’s search terms or label', () => {
    const dirs = [
      dir('Solutions Engineer', ['Solutions Engineer', 'Sales Engineer']),
      dir('Product Manager', ['Product Manager']),
    ];
    // "sales" is one of the user's own search terms: excluding it would drop that direction's matches.
    const s = suggestExcludeTerms({ title: 'Sales Solutions Engineer Automotive' }, dirs);
    expect(s?.terms).not.toContain('sales');
    expect(s?.terms).not.toContain('solutions');
    expect(s?.terms).not.toContain('engineer');
    expect(s?.terms).toEqual(['automotive']);
  });

  it('covered is checked across every direction, not only the matched one', () => {
    const dirs = [pm, dir('Growth Marketing', ['Growth Marketing'])];
    const s = suggestExcludeTerms({ title: 'Product Manager Growth Marketing' }, dirs);
    // Both directions match; neither "growth" nor "marketing" may be proposed.
    expect(s).toBeNull();
  });

  it('skips level words, boilerplate, company and location words', () => {
    const s = suggestExcludeTerms(
      {
        title: 'Werkstudent Product Manager Hamburg Payments (all gender) Vollzeit',
        company: 'Payments Hamburg GmbH',
        location: 'Hamburg, Germany',
      },
      [pm],
    );
    expect(s).toBeNull();
  });

  it('ranks longer words first, keeps at most three, and each one fires', () => {
    const title = 'Product Manager Partnerships Sales Enablement Ads';
    const s = suggestExcludeTerms({ title }, [pm]);
    expect(s?.terms).toEqual(['partnerships', 'enablement', 'sales']);
    for (const term of s!.terms) {
      const [exp] = explainMatch(title, null, [{ ...pm, excludeTerms: [term] }]);
      expect(exp!.kind).toBe('excluded');
    }
  });

  it('names every matched direction — excluding from one alone would leave the ad in', () => {
    const dirs = [pm, dir('Product Owner', ['Product Owner', 'Product Manager'])];
    const s = suggestExcludeTerms({ title: 'Product Manager Insurance' }, dirs);
    expect(s?.directions.map((d) => d.id)).toEqual(['Product Manager', 'Product Owner']);
    expect(s?.terms).toEqual(['insurance']);
  });

  it('null when the title matched no direction — there is nothing to exclude it from', () => {
    expect(suggestExcludeTerms({ title: 'Accountant (m/w/d)' }, [pm])).toBeNull();
    expect(suggestExcludeTerms({ title: 'Sales Manager' }, [])).toBeNull();
  });

  it('speaks the matcher’s spelling: a split compound counts as covered', () => {
    const dev = dir('Frontend Developer', ['Frontend Entwickler']);
    const s = suggestExcludeTerms({ title: 'Frontendentwickler E-Commerce Shopware' }, [dev]);
    expect(s?.terms).not.toContain('entwickler');
    expect(s?.terms).not.toContain('frontend');
    // Same length → title order.
    expect(s?.terms).toEqual(['commerce', 'shopware']);
  });
});

describe('exclude effects on directions', () => {
  const d1 = dir('Product Manager', ['Product Manager'], ['Intern'], 'd1');
  const d2 = dir('Product Owner', ['Product Owner'], [], 'd2');
  const effects = [
    effect({ kind: 'exclude_term', value: 'sales', directionId: 'd1' }),
    effect({ kind: 'exclude_term', value: 'Intern', valueKey: 'intern', directionId: 'd1' }),
    effect({ kind: 'mute_company', value: 'Acme' }),
  ];

  it('adds each term to its own direction, once', () => {
    const [a, b] = withExcludeEffects([d1, d2], effects);
    expect(a!.excludeTerms).toEqual(['Intern', 'sales']);
    expect(b).toBe(d2);
  });

  it('takes feedback terms back out, leaving hand-written ones', () => {
    const stored = { ...d1, excludeTerms: ['Recruiting', 'sales'] };
    const [a] = withoutExcludeEffects([stored], effects);
    expect(a!.excludeTerms).toEqual(['Recruiting']);
  });

  it('round-trips', () => {
    const base = withoutExcludeEffects([d1, d2], effects);
    const withFx = withExcludeEffects(base, effects);
    expect(withoutExcludeEffects(withFx, effects)).toEqual(base);
  });
});

describe('temporal split', () => {
  const weekStart = new Date('2026-09-14T00:00:00Z');
  const at = (iso: string) => ({ createdAt: new Date(iso) });

  it('keeps only effects strictly before the week starts', () => {
    const fx = [at('2026-09-13T23:59:59Z'), at('2026-09-14T00:00:00Z'), at('2026-09-16T10:00:00Z')];
    expect(effectsBefore(fx, weekStart)).toEqual([fx[0]]);
  });

  it('a dismissal counts as prior only when it predates the week', () => {
    expect(dismissedBefore(new Date('2026-09-10T00:00:00Z'), weekStart)).toBe(true);
    expect(dismissedBefore(weekStart, weekStart)).toBe(false);
    expect(dismissedBefore(new Date('2026-09-15T00:00:00Z'), weekStart)).toBe(false);
    expect(dismissedBefore(null, weekStart)).toBe(false);
  });
});

describe('levelFeedback', () => {
  it('gated when the existing level gate already covers the title', () => {
    expect(levelFeedback('Junior Frontend Developer', { seniorities: ['senior'] })).toBe('gated');
  });
  it('no_target when the user names no rung', () => {
    expect(levelFeedback('Junior Frontend Developer', { seniorities: [] })).toBe('no_target');
  });
  it('not_gated otherwise — recorded only', () => {
    expect(levelFeedback('Senior Frontend Developer', { seniorities: ['lead'] })).toBe('not_gated');
    expect(levelFeedback('Frontend Developer', { seniorities: ['senior'] })).toBe('not_gated');
    expect(levelFeedback('Junior Frontend Developer', { seniorities: ['junior'] })).toBe('not_gated');
  });
});

describe('planDismissFeedback', () => {
  const pm = dir('Product Manager', ['Product Manager']);
  const base = {
    ad: { title: 'Product Manager Sales', company: 'Acme GmbH', location: 'Berlin' },
    directions: [pm],
    candidate: { seniorities: ['senior'] as const },
  };

  it('company → mute under the company key', () => {
    expect(planDismissFeedback({ ...base, reason: 'company' })).toEqual({
      kind: 'mute',
      company: 'Acme GmbH',
      companyKey: 'acme',
    });
  });

  it('company without a company name → noted, nothing to mute', () => {
    expect(planDismissFeedback({ ...base, ad: { ...base.ad, company: null }, reason: 'company' })).toEqual({
      kind: 'noted',
    });
  });

  it('wrong_role → a proposal, never a saved term', () => {
    const out = planDismissFeedback({ ...base, reason: 'wrong_role' });
    expect(out).toEqual({
      kind: 'suggest_exclude',
      suggestion: { directions: [{ id: 'Product Manager', label: 'Product Manager' }], terms: ['sales'] },
    });
    expect(pm.excludeTerms).toEqual([]);
  });

  it('wrong_role with nothing to propose → noted', () => {
    expect(planDismissFeedback({ ...base, directions: [], reason: 'wrong_role' })).toEqual({ kind: 'noted' });
  });

  it('wrong_level → what the level gate does, no new mechanism', () => {
    expect(planDismissFeedback({ ...base, reason: 'wrong_level' })).toEqual({ kind: 'level', level: 'not_gated' });
  });

  it('location and other → recorded only', () => {
    expect(planDismissFeedback({ ...base, reason: 'location' })).toEqual({ kind: 'noted' });
    expect(planDismissFeedback({ ...base, reason: 'other' })).toEqual({ kind: 'noted' });
  });
});

describe('re-derivation: excludes on retired directions (ADR-003 §8.13)', () => {
  const retired = (id: string, value: string, day: number, adId: string | null = `ad-${id}`): RetiredExclude => ({
    id,
    adId,
    value,
    valueKey: value.toLowerCase(),
    createdAt: new Date(Date.UTC(2026, 8, day)),
  });
  const next = [
    dir('Frontend Engineer', ['Frontend Engineer', 'Frontend Developer'], [], 'n1'),
    dir('Engineering Manager', ['Engineering Manager'], [], 'n2'),
  ];

  it('carries each word to every new direction', () => {
    const plan = planExcludeCarryOver([retired('e1', 'Sales', 10)], next);
    expect(plan.held).toEqual([]);
    expect(plan.carry).toEqual([
      {
        value: 'Sales',
        valueKey: 'sales',
        adId: 'ad-e1',
        createdAt: new Date(Date.UTC(2026, 8, 10)),
        directionIds: ['n1', 'n2'],
        sourceIds: ['e1'],
      },
    ]);
  });

  it('collapses one word saved on several old directions onto the earliest row', () => {
    const plan = planExcludeCarryOver(
      [retired('late', 'sales', 12, 'ad-late'), retired('early', 'Sales', 10, 'ad-early'), retired('x', 'SAP', 11)],
      next,
    );
    expect(plan.carry.map((c) => [c.valueKey, c.adId, c.createdAt.getUTCDate(), c.sourceIds])).toEqual([
      ['sales', 'ad-early', 10, ['early', 'late']],
      ['sap', 'ad-x', 11, ['x']],
    ]);
  });

  it('holds a word a new direction searches for, naming that direction', () => {
    const withSales = [...next, dir('Sales Engineer', ['Sales Engineer', 'Pre-Sales'], [], 'n3')];
    const plan = planExcludeCarryOver([retired('e1', 'sales', 10), retired('e2', 'recruiting', 10)], withSales);
    expect(plan.held).toEqual([{ value: 'sales', valueKey: 'sales', coveredBy: 'Sales Engineer', sourceIds: ['e1'] }]);
    expect(plan.carry.map((c) => c.valueKey)).toEqual(['recruiting']);
  });

  it('coverage is word-boundary, the exclude gate’s own rule: "lead" is not covered by "Leadership"', () => {
    const plan = planExcludeCarryOver([retired('e1', 'lead', 10)], [dir('Leadership Coach', ['Leadership'], [], 'n1')]);
    expect(plan.carry.map((c) => c.directionIds)).toEqual([['n1']]);
  });

  it('holds everything when the new derivation has no directions', () => {
    const plan = planExcludeCarryOver([retired('e1', 'sales', 10)], []);
    expect(plan.carry).toEqual([]);
    expect(plan.held).toEqual([{ value: 'sales', valueKey: 'sales', coveredBy: null, sourceIds: ['e1'] }]);
  });

  it('nothing retired, nothing to do', () => {
    expect(planExcludeCarryOver([], next)).toEqual({ carry: [], held: [] });
  });

  it('a carried word fires on every new direction, and a held one would have cut a direction’s own matches', () => {
    const plan = planExcludeCarryOver([retired('e1', 'sales', 10)], next);
    const applied = next.map((d) => ({ ...d, excludeTerms: plan.carry.map((c) => c.value) }));
    expect(explainMatch('Frontend Engineer Sales Enablement', null, applied).map((e) => e.kind)).toEqual([
      'excluded',
      'excluded',
    ]);
    const salesDir = dir('Sales Engineer', ['Sales Engineer'], ['sales'], 'n3');
    expect(explainMatch('Sales Engineer', null, [salesDir])[0]!.kind).toBe('excluded');
  });

  it('excludeCoveredBy is the check suggestExcludeTerms uses', () => {
    const dirs = [dir('UX Designer', ['UX Designer', 'Product Designer'])];
    expect(excludeCoveredBy('product', dirs)?.label).toBe('UX Designer');
    expect(excludeCoveredBy('interior', dirs)).toBeNull();
    expect(suggestExcludeTerms({ title: 'Product Designer Interior' }, dirs)?.terms).toEqual(['interior']);
  });

  describe('groupExcludeEffects', () => {
    const at = (day: number) => new Date(Date.UTC(2026, 8, day));
    const current = [dir('Frontend Engineer', ['Frontend Engineer']), dir('Sales Engineer', ['Sales Engineer'])];

    it('one entry per word, applied to the directions that hold it, dated by the earliest row', () => {
      const groups = groupExcludeEffects(
        [
          { value: 'SAP', valueKey: 'sap', createdAt: at(12), directionLabel: 'Frontend Engineer', applied: true },
          { value: 'SAP', valueKey: 'sap', createdAt: at(10), directionLabel: 'Sales Engineer', applied: true },
        ],
        current,
      );
      expect(groups).toEqual([
        {
          value: 'SAP',
          valueKey: 'sap',
          since: at(10),
          applied: true,
          directionLabels: ['Frontend Engineer', 'Sales Engineer'],
          coveredBy: null,
        },
      ]);
    });

    it('a held word is not applied and names the direction that searches for it', () => {
      const [g] = groupExcludeEffects(
        [{ value: 'sales', valueKey: 'sales', createdAt: at(10), directionLabel: 'Old direction', applied: false }],
        current,
      );
      expect(g).toMatchObject({ applied: false, directionLabels: [], coveredBy: 'Sales Engineer' });
    });

    it('a held word no current direction covers waits for the next analysis', () => {
      const [g] = groupExcludeEffects(
        [{ value: 'recruiting', valueKey: 'recruiting', createdAt: at(10), directionLabel: 'Old', applied: false }],
        current,
      );
      expect(g).toMatchObject({ applied: false, coveredBy: null });
    });
  });
});
