/**
 * Lever job-board adapter (ADR-002). Keyless API — no auth header needed.
 *
 * Endpoints used:
 *   GET api.lever.co/v0/postings/{slug}?mode=json
 *     → all open positions (no server-side pagination; returns full list)
 *
 * What Lever gives us:
 *   - title (text), location (categories.location), absolute URL (hostedUrl)
 *   - salaryRange: {min, max, currency, interval} — optional, not all posts include it
 *   - commitment (categories.commitment): "Full-time", "Part-time", "Contract", etc.
 *
 * What Lever does NOT give us:
 *   - Shift, German level, Contract type — left null (I4).
 *   - Posted date — not in the public API; firstSeenAt falls back to fetchedAt.
 */
import { normalizePay, normalizeWorkplace } from '@job-digest/ingest';
import { eur } from '@job-digest/core';
import type { Facts } from '@job-digest/core';
import type { JobBoardProvider, NormalizedJob } from './types';

const BASE = 'https://api.lever.co/v0/postings';

// ── API response types (subset we actually read) ─────────────────────────────

interface LeverPosting {
  id: string;
  text: string;
  hostedUrl: string;
  categories: {
    location?: string;
    commitment?: string;
    team?: string;
    department?: string;
  };
  salaryRange?: {
    min?: number;
    max?: number;
    currency?: string;
    interval?: string;
  };
}

// ── Helpers ──────────────────────────────────────────────────────────────────

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
 * Lever's salaryRange.interval values include "per-year-salary",
 * "per-month-salary", "per-hour-salary". We only normalise annual and monthly;
 * hourly is rare enough in tech that we skip it rather than guess (I4).
 */
function extractPayText(range: LeverPosting['salaryRange']): string | null {
  if (!range?.min || !range?.max) return null;
  const interval = (range.interval ?? '').toLowerCase();
  if (!interval.includes('year') && !interval.includes('month')) return null;
  const currency = (range.currency ?? 'USD').toUpperCase();
  const symbol = currency === 'EUR' ? '€' : currency === 'GBP' ? '£' : '$';
  const fmt = (n: number) => `${symbol}${Math.round(n / 1000)}K`;
  return interval.includes('year')
    ? `${fmt(range.min)} – ${fmt(range.max)} annual`
    : `${fmt(range.min)} – ${fmt(range.max)} monthly`;
}

function mapPosting(posting: LeverPosting, slug: string): NormalizedJob {
  const locationRaw = posting.categories.location ?? null;
  const facts = emptyFacts();
  const wording: NormalizedJob['wording'] = {};

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

  const payRaw = extractPayText(posting.salaryRange);
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
        ? { value: `≈ ${monthly}/mo`, quote: payRaw, note: `${payRaw}, ÷ 12 — no 13th salary assumed` }
        : { value: monthly, quote: payRaw, note: '' };
    }
  }

  return {
    externalId: `lever:${posting.id}`,
    externalUrl: posting.hostedUrl,
    title: posting.text,
    // Lever postings don't carry the company name — use the board slug as a
    // reasonable stand-in. Most slugs are the company's own domain handle.
    company: slug,
    locationRaw,
    platform: 'Lever',
    facts,
    wording,
    postedAt: null,
  };
}

// ── Provider ──────────────────────────────────────────────────────────────────

export const lever: JobBoardProvider = {
  name: 'Lever',

  parseSlugFromUrl(url: string): string | null {
    // Matches:
    //   https://jobs.lever.co/stripe
    //   https://jobs.lever.co/stripe/12345
    //   https://api.lever.co/v0/postings/stripe
    try {
      const u = new URL(url.startsWith('http') ? url : `https://${url}`);
      if (!u.hostname.includes('lever.co')) return null;
      const parts = u.pathname.replace(/^\//, '').split('/');
      // /v0/postings/{slug}/... → skip "v0" and "postings"
      const postingsIdx = parts.indexOf('postings');
      const slug = postingsIdx >= 0 ? parts[postingsIdx + 1] : parts[0];
      return slug && slug.length > 0 ? slug : null;
    } catch {
      return null;
    }
  },

  async validateSlug(slug: string): Promise<string> {
    // The public API returns [] for a valid board with 0 jobs, or
    // {ok: false, error: 'Document not found'} for an unknown slug.
    const res = await fetch(`${BASE}/${encodeURIComponent(slug)}?mode=json&limit=0`);
    if (!res.ok) throw new Error(`Lever: HTTP ${res.status} validating slug "${slug}"`);
    const data = (await res.json()) as LeverPosting[] | { ok: false; error: string };
    if (!Array.isArray(data)) throw new Error(`Lever: board "${slug}" not found`);
    return slug;
  },

  async fetchJobs(slug: string): Promise<NormalizedJob[]> {
    // Lever returns all postings in a single response — no server-side pagination.
    const res = await fetch(`${BASE}/${encodeURIComponent(slug)}?mode=json`);
    if (!res.ok) throw new Error(`Lever: HTTP ${res.status} fetching jobs for "${slug}"`);
    const data = (await res.json()) as LeverPosting[] | { ok: false; error: string };
    if (!Array.isArray(data)) throw new Error(`Lever: board "${slug}" not found`);
    return data.map((p) => mapPosting(p, slug));
  },
};
