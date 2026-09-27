/**
 * Descriptions from the job-board providers (ADR-003 §8.10 "Descriptions in
 * matching"): the HTML → text pass every provider shares, and each
 * adapter's mapping from its real response shape to
 * `NormalizedJob.description`. `fetch` is stubbed — no network, no
 * Postgres — and each stub asserts the one request the adapter already
 * made before this change (Greenhouse's gains `content=true`, nothing
 * gains a call).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DESCRIPTION_MAX_CHARS,
  decodeEntities,
  htmlToText,
  toStoredDescription,
} from '../src/providers/description';
import { ashby } from '../src/providers/ashby';
import { greenhouse } from '../src/providers/greenhouse';
import { lever } from '../src/providers/lever';
import { personio } from '../src/providers/personio';

afterEach(() => {
  vi.unstubAllGlobals();
});

/** Stub `fetch` with one canned response per call; records the URLs. */
function stubFetch(...responses: Array<() => Response>): string[] {
  const urls: string[] = [];
  let i = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL) => {
      urls.push(String(input));
      const make = responses[Math.min(i++, responses.length - 1)];
      if (!make) throw new Error('no stubbed response');
      return make();
    }),
  );
  return urls;
}

const json = (body: unknown) => () =>
  new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });

describe('htmlToText', () => {
  it('turns block tags into lines and drops inline tags without splitting words', () => {
    const html = '<h2>Engineering Manager (m/w/d)</h2><p>You will lead our <b>front</b>end team.</p><ul><li>React</li><li>Go</li></ul>';
    expect(htmlToText(html)).toBe('Engineering Manager (m/w/d)\nYou will lead our frontend team.\nReact\nGo');
  });

  it('unescapes entity-escaped HTML (Greenhouse `content`) before stripping', () => {
    const escaped = '&lt;p&gt;We are hiring an &lt;strong&gt;Engineering Manager&lt;/strong&gt; &amp;amp; mentor.&lt;/p&gt;&lt;p&gt;Second&amp;nbsp;para&lt;/p&gt;';
    expect(htmlToText(escaped)).toBe('We are hiring an Engineering Manager & mentor.\nSecond para');
  });

  it('decodes named and numeric entities once, keeps unknown ones', () => {
    expect(decodeEntities('M&uuml;nchen &#8211; K&#xF6;ln &amp;lt; &foo;')).toBe('München – Köln &lt; &foo;');
    expect(htmlToText('<p>Gr&ouml;&szlig;e&nbsp;&amp;&nbsp;Qualit&auml;t</p>')).toBe('Größe & Qualität');
  });

  it('drops script/style/comments and CDATA wrappers', () => {
    const html = '<![CDATA[<style>p{color:red}</style><!-- tracking --><p>Hello</p><script>alert(1)</script><p>World</p>]]>';
    expect(htmlToText(html)).toBe('Hello\nWorld');
  });

  it('collapses whitespace, drops blank lines and control characters', () => {
    expect(htmlToText('  <div>\n\n  a \t b  c </div>\r\n\r\n<br/><br/>d\u0000e ')).toBe('a b c\nd e');
  });

  it('passes plain text through unchanged apart from whitespace', () => {
    expect(htmlToText('Plain text.\nSecond line')).toBe('Plain text.\nSecond line');
  });
});

describe('toStoredDescription', () => {
  it('joins parts as separate lines and skips empty ones', () => {
    expect(toStoredDescription('<p>Intro</p>', null, '', undefined, 'Tail')).toBe('Intro\nTail');
  });

  it('is null when there is no text at all (I4: absent, not empty)', () => {
    expect(toStoredDescription()).toBeNull();
    expect(toStoredDescription(null, '<p> </p>', '<br>')).toBeNull();
  });

  it(`caps at ${DESCRIPTION_MAX_CHARS} chars without splitting a surrogate pair`, () => {
    const long = 'a'.repeat(DESCRIPTION_MAX_CHARS - 1) + '😀' + 'b'.repeat(100);
    const out = toStoredDescription(long)!;
    expect(out.length).toBeLessThanOrEqual(DESCRIPTION_MAX_CHARS);
    expect(out).toBe('a'.repeat(DESCRIPTION_MAX_CHARS - 1));
    expect(toStoredDescription('x'.repeat(10_000))!.length).toBe(DESCRIPTION_MAX_CHARS);
  });
});

describe('Greenhouse adapter', () => {
  it('asks the list endpoint for content and maps it to plain text', async () => {
    const urls = stubFetch(
      json({
        jobs: [
          {
            id: 42,
            title: 'Software Engineer (m/w/d)',
            company_name: 'Acme',
            absolute_url: 'https://boards.greenhouse.io/acme/jobs/42',
            location: { name: 'Berlin' },
            first_published: '2026-09-01T00:00:00Z',
            metadata: null,
            content: '&lt;p&gt;We are hiring an Engineering Manager for our frontend team.&lt;/p&gt;&lt;ul&gt;&lt;li&gt;Lead 6 engineers&lt;/li&gt;&lt;/ul&gt;',
          },
          {
            id: 43,
            title: 'No content job',
            company_name: 'Acme',
            absolute_url: 'https://boards.greenhouse.io/acme/jobs/43',
            location: null,
            first_published: null,
            metadata: null,
          },
        ],
      }),
    );
    const jobs = await greenhouse.fetchJobs('acme');
    expect(urls).toHaveLength(1);
    expect(new URL(urls[0]!).searchParams.get('content')).toBe('true');
    expect(jobs[0]!.description).toBe('We are hiring an Engineering Manager for our frontend team.\nLead 6 engineers');
    expect(jobs[1]!.description).toBeNull();
  });
});

describe('Lever adapter', () => {
  it('concatenates opening, list sections and closing, preferring plain text', async () => {
    const urls = stubFetch(
      json([
        {
          id: 'abc',
          text: 'Software Engineer',
          hostedUrl: 'https://jobs.lever.co/acme/abc',
          categories: { location: 'Remote' },
          description: '<div>ignored because plain exists</div>',
          descriptionPlain: 'Engineering Manager for our frontend team.',
          lists: [{ text: "What you'll do", content: '<li>Hire</li><li>Coach</li>' }],
          additional: '<div>We offer <b>30</b> days off.</div>',
        },
        {
          id: 'def',
          text: 'Bare posting',
          hostedUrl: 'https://jobs.lever.co/acme/def',
          categories: {},
        },
      ]),
    );
    const jobs = await lever.fetchJobs('acme');
    expect(urls).toHaveLength(1);
    expect(jobs[0]!.description).toBe(
      "Engineering Manager for our frontend team.\nWhat you'll do\nHire\nCoach\nWe offer 30 days off.",
    );
    expect(jobs[1]!.description).toBeNull();
  });
});

describe('Ashby adapter', () => {
  it('uses descriptionPlain, falling back to descriptionHtml', async () => {
    const urls = stubFetch(
      json({
        apiVersion: '1',
        jobs: [
          {
            id: 'a1',
            title: 'Software Engineer',
            location: 'Berlin',
            isRemote: false,
            workplaceType: 'OnSite',
            jobUrl: 'https://jobs.ashbyhq.com/acme/a1',
            publishedAt: null,
            descriptionPlain: 'Engineering Manager for our frontend team.\n\n  Lead six engineers.  ',
            descriptionHtml: '<p>should not be used</p>',
          },
          {
            id: 'a2',
            title: 'Designer',
            location: 'Berlin',
            isRemote: false,
            workplaceType: 'OnSite',
            jobUrl: 'https://jobs.ashbyhq.com/acme/a2',
            publishedAt: null,
            descriptionHtml: '<p>Product <em>Designer</em> for payments.</p>',
          },
          {
            id: 'a3',
            title: 'Nothing',
            location: 'Berlin',
            isRemote: false,
            workplaceType: 'OnSite',
            jobUrl: 'https://jobs.ashbyhq.com/acme/a3',
            publishedAt: null,
          },
        ],
      }),
    );
    const jobs = await ashby.fetchJobs('acme');
    expect(urls).toHaveLength(1);
    expect(jobs.map((j) => j.description)).toEqual([
      'Engineering Manager for our frontend team.\nLead six engineers.',
      'Product Designer for payments.',
      null,
    ]);
  });
});

describe('Personio adapter', () => {
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<workzag-jobs>
  <position>
    <id>1001</id>
    <subcompany>Acme GmbH</subcompany>
    <office>München</office>
    <name>Software Engineer (m/w/d)</name>
    <jobDescriptions>
      <jobDescription>
        <name>Deine Rolle</name>
        <value><![CDATA[<p>Als <strong>Engineering Manager</strong> f&uuml;hrst du unser Frontend-Team.</p>]]></value>
      </jobDescription>
      <jobDescription>
        <name>Dein Profil</name>
        <value>&lt;ul&gt;&lt;li&gt;5+ Jahre Erfahrung&lt;/li&gt;&lt;/ul&gt;</value>
      </jobDescription>
    </jobDescriptions>
    <employmentType>permanent</employmentType>
    <createdAt>2026-09-01T10:00:00+00:00</createdAt>
  </position>
  <position>
    <id>1002</id>
    <jobDescriptions>
      <jobDescription><name>Section before title</name><value>x</value></jobDescription>
    </jobDescriptions>
    <name>Title After Descriptions</name>
  </position>
  <position>
    <id>1003</id>
    <name><![CDATA[Backend Entwickler & Co]]></name>
  </position>
</workzag-jobs>`;

  it('maps jobDescriptions (CDATA or escaped HTML) to "section\\ntext" lines', async () => {
    const urls = stubFetch(() => new Response(xml, { status: 200, headers: { 'content-type': 'application/xml' } }));
    const jobs = await personio.fetchJobs('acme');
    expect(urls).toHaveLength(1);
    expect(jobs[0]!.title).toBe('Software Engineer (m/w/d)');
    expect(jobs[0]!.description).toBe(
      'Deine Rolle\nAls Engineering Manager führst du unser Frontend-Team.\nDein Profil\n5+ Jahre Erfahrung',
    );
    expect(jobs[0]!.facts.permanent).toBe(true);
  });

  it('never takes a description section name for the job title', async () => {
    stubFetch(() => new Response(xml, { status: 200, headers: { 'content-type': 'application/xml' } }));
    const jobs = await personio.fetchJobs('acme');
    expect(jobs[1]!.title).toBe('Title After Descriptions');
    expect(jobs[1]!.description).toBe('Section before title\nx');
  });

  it('reads CDATA-wrapped tags verbatim and leaves description null when absent', async () => {
    stubFetch(() => new Response(xml, { status: 200, headers: { 'content-type': 'application/xml' } }));
    const jobs = await personio.fetchJobs('acme');
    expect(jobs[2]!.title).toBe('Backend Entwickler & Co');
    expect(jobs[2]!.description).toBeNull();
  });
});
