/**
 * `summarizeWeek` is pure over the digest read model, so it needs no database
 * — which is the point of computing it there rather than in a second query.
 */
import { describe, expect, it } from 'vitest';
import type { Verdict } from '@job-digest/core';
import { summarizeWeek } from '../src/queries/summary';
import type { Digest, DigestAd } from '../src/queries/types';

function verdict(key: Verdict['key'], state: Verdict['state']): Verdict {
  return { key, severity: 'hard', state, because: [] };
}

function ad(over: Partial<DigestAd> = {}): DigestAd {
  return {
    id: crypto.randomUUID(),
    title: 'Frontend Developer',
    company: 'ACME',
    location: 'Hamburg',
    source: 'LinkedIn',
    externalUrl: null,
    score: null,
    seen: false,
    saved: false,
    incomplete: false,
    incompleteNote: null,
    alert: 'Frontend Hamburg',
    receivedAt: new Date('2026-08-01'),
    firstSeenAt: new Date('2026-08-01'),
    repeat: false,
    verdicts: [verdict('Pay', 'unknown')],
    wording: {},
    titleFacts: null,
    fit: null,
    gap: null,
    applicationStatus: null,
    platformFields: {},
    ...over,
  };
}

function digest(visible: DigestAd[], dismissed: DigestAd[] = []): Digest {
  return {
    window: { start: new Date('2026-07-27'), end: new Date('2026-08-03') },
    metrics: {
      adsReceived: visible.length + dismissed.length,
      offTarget: null,
      passing: visible.length,
      filteredByRule: 0,
      dismissedByUser: 0,
      alreadySeen: 0,
    },
    visible,
    dismissed: dismissed.map((a) => ({ ...a, reason: { kind: 'user' as const } })),
    parse: {
      emailsRead: 1,
      emailsNotFullyRead: 0,
      adsUnaccountedFor: 0,
      hasUnknownLayout: false,
      platforms: ['LinkedIn'],
      lastRunAt: null,
      lastRunFailed: false,
    },
    rulesetVersion: 1,
  };
}

describe('summarizeWeek', () => {
  it('counts filtered-out ads too — they still arrived and still cost the user attention', () => {
    const s = summarizeWeek(digest([ad(), ad()], [ad()]));
    expect(s.total).toBe(3);
  });

  it('reports only companies that sent more than one ad — one ad is not a pattern', () => {
    const s = summarizeWeek(
      digest([
        ad({ company: 'ADVERGY', title: 'A' }),
        ad({ company: 'ADVERGY', title: 'B' }),
        ad({ company: 'ADVERGY', title: 'C' }),
        ad({ company: 'Solo GmbH', title: 'D' }),
      ]),
    );
    expect(s.senders).toEqual([{ company: 'ADVERGY', count: 3 }]);
  });

  it('reads pay coverage off the verdicts the digest already computed, never recomputing', () => {
    const s = summarizeWeek(
      digest([
        ad({ title: 'A', verdicts: [verdict('Pay', 'pass')] }),
        ad({ title: 'B', verdicts: [verdict('Pay', 'block')] }),
        ad({ title: 'C', verdicts: [verdict('Pay', 'unknown')] }),
      ]),
    );
    expect(s.pay).toEqual({ stated: 2, clears: 1 });
  });

  it('groups gender-tag variants of one title and reports it once posted across cities', () => {
    // Verified against the live corpus (3 Aug 2026): every title+company match
    // turned out to differ by city and by external_url — genuinely separate
    // postings, not a §6.7 dedupe miss. So this only reports the pattern the
    // data actually showed: the same role, run in more than one city.
    const s = summarizeWeek(
      digest([
        ad({ title: 'Fullstack Entwickler (m/w/d)', company: 'ADVERGY', location: 'Hamburg' }),
        ad({ title: 'Fullstack Entwickler (w/m/d)', company: 'ADVERGY', location: 'Berlin' }),
      ]),
    );
    expect(s.repostedAcrossCities).toHaveLength(1);
    expect(s.repostedAcrossCities[0]).toMatchObject({ company: 'ADVERGY', cities: ['Hamburg', 'Berlin'] });
  });

  it('does not report anything when the same title+company repeats in the same city', () => {
    // This is the case the old "duplicates" name got wrong — nothing in the
    // measured corpus supports calling a same-city repeat a duplicate, so it
    // is not reported at all rather than guessed at.
    const s = summarizeWeek(
      digest([
        ad({ title: 'Fullstack Entwickler (m/w/d)', company: 'ADVERGY', location: 'Hamburg' }),
        ad({ title: 'Fullstack Entwickler (w/m/d)', company: 'ADVERGY', location: 'Hamburg' }),
      ]),
    );
    expect(s.repostedAcrossCities).toEqual([]);
  });

  it('does not group the same title across different companies', () => {
    const s = summarizeWeek(
      digest([
        ad({ title: 'Frontend Developer', company: 'A', location: 'Hamburg' }),
        ad({ title: 'Frontend Developer', company: 'A', location: 'Berlin' }),
        ad({ title: 'Frontend Developer', company: 'B', location: 'Hamburg' }),
        ad({ title: 'Frontend Developer', company: 'B', location: 'Berlin' }),
      ]),
    );
    expect(s.repostedAcrossCities).toHaveLength(2);
    expect(s.repostedAcrossCities.map((g) => g.company).sort()).toEqual(['A', 'B']);
  });

  it('counts repeats from earlier weeks', () => {
    const s = summarizeWeek(digest([ad({ repeat: true, title: 'A' }), ad({ title: 'B' })]));
    expect(s.repeats).toBe(1);
  });

  it('is empty, not zero-filled, on an empty week', () => {
    const s = summarizeWeek(digest([]));
    expect(s).toMatchObject({ total: 0, repeats: 0, senders: [], alerts: [], repostedAcrossCities: [] });
  });
});
