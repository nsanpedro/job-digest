/**
 * Greenhouse job-board adapter (ADR-002). Keyless API — no auth header needed.
 *
 * Endpoints used:
 *   GET boards-api.greenhouse.io/v1/boards/{slug}
 *     → validate slug + get display name (throws 404 on unknown slug)
 *   GET boards-api.greenhouse.io/v1/boards/{slug}/jobs
 *     → paginated list of open positions (pagination via ?page=&per_page=)
 *
 * What Greenhouse gives us structurally:
 *   - title, location.name, absolute_url, id, company_name, first_published
 *   - metadata[]: freeform key-value pairs some companies use for salary —
 *     not standardized, so we attempt to parse it but never invent a number
 *     if the shape is unexpected (I4).
 *
 * What Greenhouse does NOT give us:
 *   - Shift, German level, Contract type — left null (I4).
 *   - Salary is sometimes in metadata[].value as "90000-120000" or similar;
 *     we parse it best-effort, treating it as annual per the pay normalizer's
 *     magnitude heuristic.
 */
import { normalizePay, normalizeWorkplace } from '@job-digest/ingest';
import { eur } from '@job-digest/core';
import type { Facts } from '@job-digest/core';
import type { JobBoardProvider, NormalizedJob } from './types';

const BASE = 'https://boards-api.greenhouse.io/v1/boards';
const PER_PAGE = 500;

// ── API response types (subset we actually read) ────────────────────────────

interface GreenhouseJob {
  id: number;
  title: string;
  company_name: string;
  absolute_url: string;
  location: { name: string } | null;
  first_published: string | null;
  metadata: Array<{ name: string; value: string | null }> | null;
}

interface GreenhouseJobsResponse {
  jobs: GreenhouseJob[];
}

interface GreenhouseBoardResponse {
  name: string;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function emptyFacts(): Facts {
  return {
    rotating: null,
    weekend: null,
    german: null,
    home: null,
    pay: null,
    payMax: null,
    payFte: null,
    fteNote: null,
    permanent: null,
    commuteMin: null,
  };
}

/**
 * Some companies put salary in metadata under various key names. We look for
 * any metadata entry whose name contains "salary" or "compensation" (case-
 * insensitive) and try to parse its value. If the value is a range like
 * "90000-120000" or "90,000 - 120,000 USD", we extract the two numbers.
 * We treat it as annual (Greenhouse companies are mostly USD/EUR with annual
 * figures) and let normalizePay's magnitude heuristic handle it — if the
 * number is above 20k it divides by 12, otherwise treats as monthly (the
 * same heuristic the email extractors use for Xing bands).
 */
function extractPayFromMetadata(
  metadata: Array<{ name: string; value: string | null }> | null,
): string | null {
  if (!metadata) return null;
  const entry = metadata.find((m) => /salary|compensation|gehalt|vergütung/i.test(m.name));
  if (!entry?.value) return null;
  return entry.value;
}

async function fetchPage(slug: string, page: number): Promise<GreenhouseJob[]> {
  const url = `${BASE}/${encodeURIComponent(slug)}/jobs?page=${page}&per_page=${PER_PAGE}`;
  const res = await fetch(url);
  if (res.status === 404) throw new Error(`Greenhouse: board "${slug}" not found`);
  if (!res.ok) throw new Error(`Greenhouse: HTTP ${res.status} fetching ${url}`);
  const data = (await res.json()) as GreenhouseJobsResponse;
  return data.jobs ?? [];
}

// ── Provider ─────────────────────────────────────────────────────────────────

export const greenhouse: JobBoardProvider = {
  name: 'Greenhouse',

  parseSlugFromUrl(url: string): string | null {
    // Matches:
    //   https://boards.greenhouse.io/stripe
    //   https://boards.greenhouse.io/stripe/jobs
    //   https://boards-api.greenhouse.io/v1/boards/stripe
    //   https://job-boards.greenhouse.io/stripe  (some embed variants)
    try {
      const u = new URL(url.startsWith('http') ? url : `https://${url}`);
      if (!u.hostname.includes('greenhouse.io')) return null;
      const parts = u.pathname.replace(/^\//, '').split('/');
      // /boards/{slug}/... or /{slug}/... depending on subdomain
      const boardsIdx = parts.indexOf('boards');
      const slug = boardsIdx >= 0 ? parts[boardsIdx + 1] : parts[0];
      return slug && slug !== 'jobs' ? slug : null;
    } catch {
      return null;
    }
  },

  async validateSlug(slug: string): Promise<string> {
    const res = await fetch(`${BASE}/${encodeURIComponent(slug)}`);
    if (res.status === 404) throw new Error(`Greenhouse: no board found for slug "${slug}"`);
    if (!res.ok) throw new Error(`Greenhouse: HTTP ${res.status} validating slug "${slug}"`);
    const data = (await res.json()) as GreenhouseBoardResponse;
    if (!data.name) throw new Error(`Greenhouse: unexpected response shape for "${slug}"`);
    return data.name;
  },

  async fetchJobs(slug: string): Promise<NormalizedJob[]> {
    // Greenhouse paginates but most companies have <500 open roles. Fetch
    // page 1; if it comes back full, keep going — rare in practice.
    const all: GreenhouseJob[] = [];
    let page = 1;
    while (true) {
      const batch = await fetchPage(slug, page);
      all.push(...batch);
      if (batch.length < PER_PAGE) break;
      page++;
    }

    return all.map((job): NormalizedJob => {
      const locationRaw = job.location?.name ?? null;
      const facts = emptyFacts();
      const wording: NormalizedJob['wording'] = {};

      // ── Onsite from location string ────────────────────────────────────
      if (locationRaw) {
        const w = normalizeWorkplace(locationRaw);
        if (w) {
          facts.home = w.home;
          const note =
            w.home === null
              ? 'the ad says how it works, not how many days — check before counting on it'
              : w.home >= 5
                ? 'fully remote'
                : w.home === 0
                  ? 'no home office'
                  : `${w.home} home-office day${w.home === 1 ? '' : 's'} a week`;
          wording.Onsite = { value: w.matched, quote: locationRaw, note };
        }
      }

      // ── Pay from metadata (best-effort) ───────────────────────────────
      const payRaw = extractPayFromMetadata(job.metadata);
      if (payRaw) {
        const p = normalizePay(payRaw);
        if (p) {
          facts.pay = p.pay;
          facts.payMax = p.payMax;
          facts.payFte = p.payFte;
          facts.fteNote = p.fteNote;
          const monthly =
            p.payMax !== null && p.payMax !== p.pay
              ? `${eur(p.pay)} – ${eur(p.payMax)}`
              : eur(p.pay);
          wording.Pay = p.derivedFromAnnual
            ? { value: `≈ ${monthly}/mo`, quote: payRaw, note: `${payRaw} annual, ÷ 12 — no 13th salary assumed` }
            : { value: monthly, quote: payRaw, note: '' };
        }
      }

      return {
        externalId: `greenhouse:${job.id}`,
        externalUrl: job.absolute_url,
        title: job.title,
        company: job.company_name,
        locationRaw,
        platform: 'Greenhouse',
        facts,
        wording,
        postedAt: job.first_published ? new Date(job.first_published) : null,
      };
    });
  },
};
