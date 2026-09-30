/**
 * Description backfill (ADR-003 §8.15): the pure decisions behind filling
 * `ads.description` for rows that already exist, and each provider adapter
 * against a fixture shaped like its real API response (every field the
 * public endpoint returns, not only the ones we read). No Postgres, no
 * network — `fetch` is stubbed.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { dedupeKeyFromStrings } from '@job-digest/ingest';
import type { CurationDirection } from '@job-digest/core';
import {
  descriptionSources,
  matchDescriptionFills,
  mergeDescription,
  planDescriptionBackfill,
  planEnrichment,
  shouldEnrichExisting,
  type BackfillRow,
} from '../src/description-fill';
import { detectTier1 } from '../src/enrich/detect-tier';
import { gateJobs } from '../src/fetch-apis';
import { ashby } from '../src/providers/ashby';
import { greenhouse } from '../src/providers/greenhouse';
import { lever } from '../src/providers/lever';
import { personio } from '../src/providers/personio';
import type { NormalizedJob } from '../src/providers/types';

const FIXTURES = join(__dirname, 'fixtures', 'providers');
const fixture = (name: string) => readFileSync(join(FIXTURES, name), 'utf8');

afterEach(() => {
  vi.unstubAllGlobals();
});

function stubFetch(body: string, contentType: string): string[] {
  const urls: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL) => {
      urls.push(String(input));
      return new Response(body, { status: 200, headers: { 'content-type': contentType } });
    }),
  );
  return urls;
}

// ── Adapters against realistic responses ────────────────────────────────────

describe('adapters produce a description from a realistic response', () => {
  it('Greenhouse: `content` (entity-escaped HTML) from the ?content=true list call', async () => {
    const urls = stubFetch(fixture('greenhouse-jobs.json'), 'application/json');
    const jobs = await greenhouse.fetchJobs('acmepay');
    expect(urls).toHaveLength(1);
    expect(new URL(urls[0]!).searchParams.get('content')).toBe('true');
    expect(jobs.map((j) => j.externalId)).toEqual(['greenhouse:7012345002', 'greenhouse:7012345003']);
    expect(jobs[0]!.description).toBe(
      [
        'About AcmePay',
        'AcmePay builds payment infrastructure for 40,000 merchants across Europe.',
        'The role',
        'We are looking for an Engineering Manager for our Checkout frontend team (6 engineers) in Berlin.',
        'What you’ll do',
        'Lead, hire and coach a cross-functional team',
        'Own delivery of the Checkout SDK roadmap',
        'AcmePay is an equal opportunity employer.',
      ].join('\n'),
    );
    expect(jobs[1]!.description).toBe('Als Data Analyst (m/w/d) unterstützt du unser Risk-Team.');
  });

  it('Lever: descriptionPlain + lists[] + additionalPlain, HTML fallback when plain is empty', async () => {
    const urls = stubFetch(fixture('lever-postings.json'), 'application/json');
    const jobs = await lever.fetchJobs('flowtech');
    expect(urls).toHaveLength(1);
    expect(urls[0]).toBe('https://api.lever.co/v0/postings/flowtech?mode=json');
    expect(jobs[0]!.description).toBe(
      [
        'Flowtech is hiring an Engineering Manager for the Platform team.',
        'You will lead eight backend engineers building our workflow engine.',
        "What you'll do",
        'Grow the team from 8 to 12',
        'Run the on-call rotation',
        "What we're looking for",
        '3+ years managing engineers',
        'Go or Java',
        'We offer 30 days of paid vacation and a yearly learning budget.',
        'Flowtech is an equal opportunity employer.',
      ].join('\n'),
    );
    // descriptionPlain is "" on this posting — the HTML `description` is used.
    expect(jobs[1]!.description).toBe('Product Designer for our mobile app.');
  });

  it('Ashby: descriptionPlain, descriptionHtml fallback when plain is empty', async () => {
    const urls = stubFetch(fixture('ashby-job-board.json'), 'application/json');
    const jobs = await ashby.fetchJobs('lumen');
    expect(urls).toHaveLength(1);
    expect(jobs[0]!.description).toBe(
      [
        'About the role',
        'Lumen is looking for an Engineering Manager to lead the Growth frontend team.',
        '* Coach five engineers',
        '* Own experimentation tooling',
      ].join('\n'),
    );
    expect(jobs[1]!.description).toBe('Sell Lumen to mid-market SaaS companies.');
  });

  it('Personio: <jobDescriptions> sections, CDATA or entity-escaped', async () => {
    const urls = stubFetch(fixture('personio.xml'), 'text/xml; charset=UTF-8');
    const jobs = await personio.fetchJobs('nordlicht');
    expect(urls).toEqual(['https://nordlicht.jobs.personio.de/xml']);
    expect(jobs.map((j) => j.title)).toEqual(['Software Engineer (m/w/d)', 'Werkstudent Operations (m/w/d)']);
    expect(jobs[0]!.locationRaw).toBe('Hamburg');
    expect(jobs[0]!.description).toBe(
      [
        'Über uns',
        'Nordlicht baut Software für Logistikunternehmen.',
        'Deine Aufgaben',
        'Als Engineering Manager führst du unser Frontend-Team (5 Personen).',
        'Hiring & Coaching',
        'Roadmap-Planung',
        'Dein Profil',
        'Mehrjährige Führungserfahrung',
        'Deutsch auf C1-Niveau',
      ].join('\n'),
    );
    expect(jobs[1]!.description).toBe('Deine Aufgaben\nDu unterstützt unser Ops-Team.');
  });
});

// ── The upsert rule ─────────────────────────────────────────────────────────

describe('mergeDescription (existing API ad, admitted by the gate)', () => {
  it('takes the current description over an older one', () => {
    expect(mergeDescription('old text', 'edited text')).toBe('edited text');
  });
  it('fills a null description', () => {
    expect(mergeDescription(null, 'text')).toBe('text');
  });
  it('never erases a known description with null', () => {
    expect(mergeDescription('kept', null)).toBe('kept');
    expect(mergeDescription(null, null)).toBeNull();
  });
});

// ── The gate no longer hides known ads from the description fill ────────────

function job(over: Partial<NormalizedJob> & Pick<NormalizedJob, 'externalId' | 'title'>): NormalizedJob {
  return {
    externalUrl: `https://example.test/${over.externalId}`,
    company: 'Acme',
    locationRaw: 'Berlin',
    platform: 'Greenhouse',
    facts: {
      rotating: null, weekend: null, german: null, home: null, pay: null,
      payMax: null, payFte: null, fteNote: null, permanent: null, commuteMin: null,
    },
    wording: {},
    postedAt: null,
    description: null,
    ...over,
  };
}

describe('gateJobs + descriptionSources', () => {
  const dirs: CurationDirection[] = [
    { distance: 'adjacent', searchTerms: ['Engineering Manager'], excludeTerms: ['sales'] },
  ];
  const jobs = [
    job({ externalId: 'greenhouse:1', title: 'Engineering Manager', description: 'Lead the team.' }),
    // Admitted by an earlier (looser / title-only) gate, refused by today's.
    job({ externalId: 'greenhouse:2', title: 'Office Manager', description: 'Run the Berlin office.' }),
    // Refused because the description now hits an exclude.
    job({ externalId: 'greenhouse:3', title: 'Engineering Manager', description: 'Sales engineering team lead.' }),
    job({ externalId: 'greenhouse:4', title: 'Recruiter', description: null }),
  ];

  it('splits admitted and gated-out without losing either', () => {
    const { admitted, gatedOut } = gateJobs(jobs, dirs);
    expect(admitted.map((j) => j.externalId)).toEqual(['greenhouse:1']);
    expect(gatedOut.map((j) => j.externalId)).toEqual(['greenhouse:2', 'greenhouse:3', 'greenhouse:4']);
  });

  it('admits everything when the user has no directions', () => {
    expect(gateJobs(jobs, []).admitted).toHaveLength(4);
  });

  it('the fill reads every fetched job (gated-out included) that has a description', () => {
    const sources = descriptionSources(jobs);
    expect(sources.map((s) => s.externalId)).toEqual(['greenhouse:1', 'greenhouse:2', 'greenhouse:3']);
    expect(sources[1]!.dedupeKey).toBe(dedupeKeyFromStrings('Office Manager', 'Acme', 'Berlin'));
  });
});

describe('matchDescriptionFills', () => {
  const sources = descriptionSources([
    job({ externalId: 'lever:a', title: 'Platform Lead', description: 'A text' }),
    job({ externalId: 'lever:b', title: 'Data Engineer', description: 'B text' }),
  ]);

  it('matches on externalId first', () => {
    const fills = matchDescriptionFills(
      [{ id: 'ad1', externalId: 'lever:b', dedupeKey: sources[0]!.dedupeKey }],
      sources,
    );
    expect(fills).toEqual([{ adId: 'ad1', description: 'B text' }]);
  });

  it('falls back to the dedupe key (title reworded id, or an email row for the same posting)', () => {
    const fills = matchDescriptionFills([{ id: 'ad2', externalId: 'linkedin:999', dedupeKey: sources[0]!.dedupeKey }], sources);
    expect(fills).toEqual([{ adId: 'ad2', description: 'A text' }]);
    expect(matchDescriptionFills([{ id: 'ad3', externalId: null, dedupeKey: sources[1]!.dedupeKey }], sources)).toEqual([
      { adId: 'ad3', description: 'B text' },
    ]);
  });

  it('leaves ads the fetch does not describe alone, and fills each ad once', () => {
    expect(matchDescriptionFills([{ id: 'ad4', externalId: 'lever:zzz', dedupeKey: 'nope' }], sources)).toEqual([]);
    const dup = { id: 'ad5', externalId: 'lever:a', dedupeKey: sources[0]!.dedupeKey };
    expect(matchDescriptionFills([dup, dup], sources)).toHaveLength(1);
    expect(matchDescriptionFills([], sources)).toEqual([]);
  });
});

// ── Enrichment re-fill decision ─────────────────────────────────────────────

describe('planEnrichment', () => {
  it('runs the full enrichment (LLM included) for an ad never enriched', () => {
    expect(planEnrichment({ enrichmentStatus: null, hasDescription: false })).toBe('full');
    expect(planEnrichment({ enrichmentStatus: null, hasDescription: true })).toBe('full');
  });

  it('fetches the description only — no second LLM call — when enrichment predates 0018', () => {
    expect(planEnrichment({ enrichmentStatus: 'fetched', hasDescription: false })).toBe('description_only');
  });

  it('skips when the description is already there', () => {
    expect(planEnrichment({ enrichmentStatus: 'fetched', hasDescription: true })).toBe('skip');
    expect(planEnrichment({ enrichmentStatus: 'fetch_failed', hasDescription: true }, { retryFailed: true })).toBe('skip');
  });

  it('does not retry a failed fetch on every sighting; the backfill may, description-only', () => {
    expect(planEnrichment({ enrichmentStatus: 'fetch_failed', hasDescription: false })).toBe('skip');
    expect(planEnrichment({ enrichmentStatus: 'fetch_failed', hasDescription: false }, { retryFailed: true })).toBe(
      'description_only',
    );
    expect(planEnrichment({ enrichmentStatus: 'tier_skip', hasDescription: false }, { retryFailed: true })).toBe('skip');
  });
});

describe('shouldEnrichExisting (re-sighted email ad)', () => {
  it('only for a null description and a Greenhouse/Lever posting URL', () => {
    const gh = 'https://boards.greenhouse.io/acme/jobs/123';
    expect(shouldEnrichExisting({ description: null, externalUrl: gh })).toBe(true);
    expect(shouldEnrichExisting({ description: 'x', externalUrl: gh })).toBe(false);
    expect(shouldEnrichExisting({ description: null, externalUrl: 'https://www.linkedin.com/jobs/view/42' })).toBe(false);
    expect(shouldEnrichExisting({ description: null, externalUrl: null })).toBe(false);
  });
});

describe('detectTier1', () => {
  it('recognises the current job-boards.greenhouse.io domain as well as boards.', () => {
    expect(detectTier1('https://job-boards.greenhouse.io/acmepay/jobs/7012345002?gh_src=x')).toEqual({
      platform: 'greenhouse',
      slug: 'acmepay',
      jobId: '7012345002',
    });
    expect(detectTier1('https://boards.greenhouse.io/acmepay/jobs/1')).toMatchObject({ slug: 'acmepay', jobId: '1' });
    expect(detectTier1('https://job-boards.eu.greenhouse.io/acmepay/jobs/1')).toBeNull();
  });
});

// ── Backfill selection ──────────────────────────────────────────────────────

describe('planDescriptionBackfill', () => {
  const row = (over: Partial<BackfillRow> & Pick<BackfillRow, 'id'>): BackfillRow => ({
    externalId: null,
    externalUrl: null,
    dedupeKey: `key-${over.id}`,
    platform: 'LinkedIn',
    sourceProvider: null,
    sourceSlug: null,
    ...over,
  });

  const plan = planDescriptionBackfill([
    row({ id: 'g1', platform: 'Greenhouse', externalId: 'greenhouse:1', sourceProvider: 'Greenhouse', sourceSlug: 'acme' }),
    row({ id: 'g2', platform: 'Greenhouse', externalId: 'greenhouse:2', sourceProvider: 'Greenhouse', sourceSlug: 'acme' }),
    row({ id: 'l1', platform: 'Lever', externalId: 'lever:x', sourceProvider: 'Lever', sourceSlug: 'flowtech' }),
    row({ id: 'p1', platform: 'Personio', externalId: 'personio:9', sourceProvider: 'Personio', sourceSlug: 'nordlicht' }),
    // API ad whose source row was deleted (source_id set null): single fetch.
    row({ id: 'g3', platform: 'Greenhouse', externalId: 'greenhouse:3', externalUrl: 'https://boards.greenhouse.io/other/jobs/3' }),
    // Email ad linking straight to a Lever posting.
    row({ id: 'e1', externalUrl: 'https://jobs.lever.co/flowtech/5f0c3b1e-8a2d-4c6f-9e1a-2b3c4d5e6f70' }),
    // Email ads nobody can describe.
    row({ id: 'e2', externalUrl: 'https://www.linkedin.com/jobs/view/1' }),
    row({ id: 'e3', platform: 'Xing', externalUrl: null }),
    row({ id: 'e4' }),
  ]);

  it('groups source-backed ads by board — one fetch per board', () => {
    expect([...plan.boards.keys()]).toEqual(['Greenhouse:acme', 'Lever:flowtech', 'Personio:nordlicht']);
    expect(plan.boards.get('Greenhouse:acme')!.ads.map((a) => a.id)).toEqual(['g1', 'g2']);
    expect(plan.boards.get('Greenhouse:acme')!.ads[0]).toEqual({ id: 'g1', externalId: 'greenhouse:1', dedupeKey: 'key-g1' });
  });

  it('sends Greenhouse/Lever posting links without a source to a single-posting fetch', () => {
    expect(plan.singles.map((s) => [s.adId, s.match.platform])).toEqual([
      ['g3', 'greenhouse'],
      ['e1', 'lever'],
    ]);
  });

  it('counts, and never fetches, ads no keyless API can describe', () => {
    expect(Object.fromEntries(plan.unreachable)).toEqual({ LinkedIn: 2, Xing: 1 });
  });

  it('is empty for an empty gap (a re-run after convergence does nothing)', () => {
    const empty = planDescriptionBackfill([]);
    expect(empty.boards.size + empty.singles.length + empty.unreachable.size).toBe(0);
  });
});
