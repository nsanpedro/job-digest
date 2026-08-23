/**
 * Ashby job-board adapter (ADR-002). Keyless API — no auth header needed.
 *
 * Endpoints used:
 *   GET api.ashbyhq.com/posting-api/job-board/{slug}?includeCompensation=true
 *     → all open positions + salary ranges
 *
 * What Ashby gives us:
 *   - title, location (single string), absolute URL (jobUrl), published date
 *   - isRemote (boolean), workplaceType ("Remote", "OnSite", "Hybrid")
 *   - compensation.scrapeableCompensationSalarySummary: "€110K – €185K" ready to parse
 *   - compensation.compensationTiers[].components[]: typed breakdown with minValue/maxValue
 *
 * What Ashby does NOT give us:
 *   - Shift, German level, Contract type — left null (I4).
 */
import { normalizeWorkplace } from '@job-digest/ingest';
import { eur } from '@job-digest/core';
import type { Facts } from '@job-digest/core';
import type { JobBoardProvider, NormalizedJob } from './types';

const BASE = 'https://api.ashbyhq.com/posting-api/job-board';

// ── API response types ────────────────────────────────────────────────────────

interface AshbyCompensationComponent {
  compensationType: string;  // 'Salary', 'Bonus', 'EquityPercentage', ...
  interval: string;          // '1 YEAR', '1 MONTH', ...
  currencyCode: string | null;
  minValue: number | null;
  maxValue: number | null;
}

interface AshbyPosting {
  id: string;
  title: string;
  location: string;
  isRemote: boolean;
  workplaceType: string;  // 'Remote', 'OnSite', 'Hybrid'
  jobUrl: string;
  publishedAt: string | null;
  compensation?: {
    scrapeableCompensationSalarySummary?: string;
    compensationTiers?: Array<{
      components: AshbyCompensationComponent[];
    }>;
  } | null;
}

interface AshbyBoardResponse {
  jobs: AshbyPosting[];
  apiVersion: string;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

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

interface PayExtract {
  payMonthly: number;
  payMaxMonthly: number | null;
  displayText: string;
  derivedFromAnnual: boolean;
}

/**
 * Pull salary from the structured Ashby compensation object. Uses raw numbers
 * directly — normalizePay is designed for German-format salary text ("110.000
 * – 185.000 €") and cannot parse Ashby's "€110K – €185K" format. Since we
 * have clean minValue/maxValue we don't need the text parser at all.
 */
function extractPay(comp: AshbyPosting['compensation']): PayExtract | null {
  if (!comp) return null;
  const salaryComp = comp.compensationTiers
    ?.flatMap((t) => t.components)
    .find((c) => c.compensationType === 'Salary');
  if (!salaryComp?.minValue) return null;

  const { minValue, maxValue, interval } = salaryComp;
  const isAnnual = interval.includes('YEAR');
  const toMonthly = (n: number) => Math.round(n / 12);
  const payMonthly = isAnnual ? toMonthly(minValue) : minValue;
  const payMaxMonthly = maxValue ? (isAnnual ? toMonthly(maxValue) : maxValue) : null;
  const displayText = comp.scrapeableCompensationSalarySummary ?? '';

  return { payMonthly, payMaxMonthly, displayText, derivedFromAnnual: isAnnual };
}

function mapPosting(posting: AshbyPosting, slug: string): NormalizedJob {
  const locationRaw = posting.location ?? null;
  const facts = emptyFacts();
  const wording: NormalizedJob['wording'] = {};

  // workplaceType gives us a clean signal: 'Remote' → home=5 directly,
  // no need to parse the location string for remote cues when the field exists.
  if (posting.workplaceType === 'Remote') {
    facts.home = 5;
    wording.Onsite = { value: 'remote', quote: posting.workplaceType, note: 'fully remote' };
  } else if (locationRaw) {
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

  const pay = extractPay(posting.compensation);
  if (pay) {
    facts.pay = pay.payMonthly;
    facts.payMax = pay.payMaxMonthly;
    const monthly =
      pay.payMaxMonthly !== null && pay.payMaxMonthly !== pay.payMonthly
        ? `${eur(pay.payMonthly)} – ${eur(pay.payMaxMonthly)}`
        : eur(pay.payMonthly);
    wording.Pay = pay.derivedFromAnnual
      ? { value: `≈ ${monthly}/mo`, quote: pay.displayText, note: `${pay.displayText} annual, ÷ 12 — no 13th salary assumed` }
      : { value: monthly, quote: pay.displayText, note: '' };
  }

  return {
    externalId: `ashby:${posting.id}`,
    externalUrl: posting.jobUrl,
    title: posting.title,
    // Ashby boards don't include the company name on individual postings.
    company: slug,
    locationRaw,
    platform: 'Ashby',
    facts,
    wording,
    postedAt: posting.publishedAt ? new Date(posting.publishedAt) : null,
  };
}

// ── Provider ──────────────────────────────────────────────────────────────────

export const ashby: JobBoardProvider = {
  name: 'Ashby',

  parseSlugFromUrl(url: string): string | null {
    // Matches:
    //   https://jobs.ashbyhq.com/ashby
    //   https://jobs.ashbyhq.com/ashby/12345
    //   https://app.ashbyhq.com/companies/ashby
    try {
      const u = new URL(url.startsWith('http') ? url : `https://${url}`);
      if (!u.hostname.includes('ashbyhq.com')) return null;
      const parts = u.pathname.replace(/^\//, '').split('/');
      // /companies/{slug}/... → skip "companies"
      const companiesIdx = parts.indexOf('companies');
      const slug = companiesIdx >= 0 ? parts[companiesIdx + 1] : parts[0];
      return slug && slug.length > 0 ? slug : null;
    } catch {
      return null;
    }
  },

  async validateSlug(slug: string): Promise<string> {
    const res = await fetch(`${BASE}/${encodeURIComponent(slug)}`);
    if (res.status === 404) throw new Error(`Ashby: board "${slug}" not found`);
    if (!res.ok) throw new Error(`Ashby: HTTP ${res.status} validating slug "${slug}"`);
    // Ashby doesn't expose a board display name — use slug as-is.
    return slug;
  },

  async fetchJobs(slug: string): Promise<NormalizedJob[]> {
    const res = await fetch(`${BASE}/${encodeURIComponent(slug)}?includeCompensation=true`);
    if (res.status === 404) throw new Error(`Ashby: board "${slug}" not found`);
    if (!res.ok) throw new Error(`Ashby: HTTP ${res.status} fetching jobs for "${slug}"`);
    const data = (await res.json()) as AshbyBoardResponse;
    return (data.jobs ?? []).map((p) => mapPosting(p, slug));
  },
};
