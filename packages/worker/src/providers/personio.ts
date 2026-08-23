/**
 * Personio job-board adapter (ADR-002). Keyless XML feed — no auth header needed.
 *
 * Endpoints used:
 *   GET {slug}.jobs.personio.de/xml   (fallback: {slug}.jobs.personio.com/xml)
 *     → all open positions as XML
 *
 * What Personio gives us:
 *   - name (title), office (location), subcompany (company display name)
 *   - employmentType: "permanent" | "temporary" → maps to facts.permanent
 *   - createdAt: ISO date string
 *
 * What Personio does NOT give us:
 *   - Salary — not exposed in the public XML feed (I4)
 *   - Shift, German level — left null (I4)
 *
 * XML parsing: regex over flat <position>…</position> blocks.
 * Personio's schema is stable and flat — no nested elements we need except
 * the primary <office>. This avoids adding an XML-parser dependency for one
 * provider; if the schema grows we add fast-xml-parser then.
 *
 * TLD strategy: always try .de first (DACH focus), fall back to .com. The
 * stored slug is just the subdomain — no TLD encoded — so the same slug works
 * regardless of which URL variant the user pasted.
 */
import { normalizeWorkplace } from '@job-digest/ingest';
import type { Facts } from '@job-digest/core';
import type { JobBoardProvider, NormalizedJob } from './types';

// ── XML helpers ───────────────────────────────────────────────────────────────

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

/** Extract the text content of the first matching tag. */
function tag(xml: string, name: string): string | null {
  const m = xml.match(new RegExp(`<${name}>([\\s\\S]*?)<\\/${name}>`));
  return m && m[1] !== undefined ? decodeEntities(m[1].trim()) : null;
}

/** Split the XML body into individual <position>…</position> blocks. */
function parsePositions(xml: string): string[] {
  const blocks: string[] = [];
  const re = /<position>([\s\S]*?)<\/position>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) {
    if (m[1] !== undefined) blocks.push(m[1]);
  }
  return blocks;
}

// ── Feed fetcher ──────────────────────────────────────────────────────────────

/**
 * Fetch the XML feed for a slug, trying .de then .com. Returns null when
 * neither resolves to a real Personio board (the redirect target is their
 * marketing site, which serves HTML, not XML).
 */
async function fetchXml(slug: string): Promise<{ xml: string; tld: 'de' | 'com' } | null> {
  for (const tld of ['de', 'com'] as const) {
    const url = `https://${encodeURIComponent(slug)}.jobs.personio.${tld}/xml`;
    try {
      const res = await fetch(url, { redirect: 'follow' });
      if (!res.ok) continue;
      const ct = res.headers.get('content-type') ?? '';
      // A redirect to the Personio marketing site returns text/html.
      // A real board returns application/xml or text/xml.
      if (!ct.includes('xml')) continue;
      const xml = await res.text();
      if (!xml.includes('<workzag-jobs>')) continue;
      return { xml, tld };
    } catch {
      continue;
    }
  }
  return null;
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

function mapPosition(block: string, slug: string, tld: 'de' | 'com'): NormalizedJob | null {
  const id = tag(block, 'id');
  const name = tag(block, 'name');
  if (!id || !name) return null;

  const locationRaw = tag(block, 'office');
  const company = tag(block, 'subcompany') ?? slug;
  const employmentType = tag(block, 'employmentType');
  const createdAt = tag(block, 'createdAt');

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

  if (employmentType === 'permanent') {
    facts.permanent = true;
    wording.Contract = { value: 'permanent', quote: employmentType, note: '' };
  } else if (employmentType === 'temporary') {
    facts.permanent = false;
    wording.Contract = { value: 'temporary', quote: employmentType, note: '' };
  }

  return {
    externalId: `personio:${id}`,
    externalUrl: `https://${slug}.jobs.personio.${tld}/job/${id}`,
    title: name,
    company,
    locationRaw,
    platform: 'Personio',
    facts,
    wording,
    postedAt: createdAt ? new Date(createdAt) : null,
  };
}

// ── Provider ──────────────────────────────────────────────────────────────────

export const personio: JobBoardProvider = {
  name: 'Personio',

  parseSlugFromUrl(url: string): string | null {
    // Matches:
    //   https://company.jobs.personio.de/
    //   https://company.jobs.personio.com/
    //   https://company.jobs.personio.de/job/123456
    try {
      const u = new URL(url.startsWith('http') ? url : `https://${url}`);
      if (!u.hostname.includes('personio.')) return null;
      // Hostname is {slug}.jobs.personio.de or {slug}.jobs.personio.com
      const parts = u.hostname.split('.');
      // parts: ['company', 'jobs', 'personio', 'de']
      if (parts[1] !== 'jobs') return null;
      const slug = parts[0];
      return slug && slug.length > 0 ? slug : null;
    } catch {
      return null;
    }
  },

  async validateSlug(slug: string): Promise<string> {
    const result = await fetchXml(slug);
    if (!result) throw new Error(`Personio: no board found for slug "${slug}"`);
    // Use the first position's subcompany as the display name, falling back to slug.
    const positions = parsePositions(result.xml);
    const first = positions[0];
    const company = first ? (tag(first, 'subcompany') ?? slug) : slug;
    return company;
  },

  async fetchJobs(slug: string): Promise<NormalizedJob[]> {
    const result = await fetchXml(slug);
    if (!result) throw new Error(`Personio: failed to fetch jobs for "${slug}"`);
    const { xml, tld } = result;
    const positions = parsePositions(xml);
    const jobs: NormalizedJob[] = [];
    for (const block of positions) {
      const job = mapPosition(block, slug, tld);
      if (job) jobs.push(job);
    }
    return jobs;
  },
};
