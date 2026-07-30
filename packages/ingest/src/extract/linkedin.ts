/**
 * LinkedIn card extractor, written against the fixture corpus (design §14).
 *
 * Covers the two observed LinkedIn alert templates, which share one semantic
 * invariant per job card:
 *
 *   <a href="…/jobs/view/{id}/…">          ← the card anchor
 *     …title as the first text-bearing <a> or <div>…
 *     <p>Company · Location (Modality)</p> ← the meta line, first <p> with '·'
 *     …badges ("Solicitud sencilla") in later, deeper <p>s…
 *   </a>
 *
 * Even single-job-subject alerts ("Full Stack Engineer en Arrows") are
 * digests internally: one headline plus similar jobs, ~3 anchors per job
 * (logo, card, bare title). Grouping by the job id in the URL collapses them.
 *
 * LinkedIn alert emails never carry a salary — that is platform_capabilities'
 * business ("the number simply is not in the email"), not a field report
 * failure here.
 */
import { HTMLElement, parse } from 'node-html-parser';
import type { ExtractedAd, ExtractResult, Extractor, FieldSpan } from './types';

const JOB_ID = /\/jobs\/view\/(\d+)/;

const clean = (s: string): string => s.replace(/\s+/g, ' ').trim();

function span(el: HTMLElement, value: string): FieldSpan {
  const [start, end] = el.range;
  return { value, start, end, sourceKind: 'html' };
}

export const linkedInCards: Extractor = {
  platform: 'LinkedIn',
  id: 'linkedin-cards@1',
  layoutHashes: [
    // "jobalerts-noreply" template: headline + similar jobs, 3 anchors/job.
    '02f90eda08093b26',
    // "jobs-noreply" digest template: one card anchor per job.
    '60069ab6374969dc',
  ],

  extract(email): ExtractResult {
    const root = parse(email.bodyHtml ?? '', { comment: false });
    const cards = new Map<string, ExtractedAd>();

    for (const anchor of root.querySelectorAll('a')) {
      const id = (anchor.getAttribute('href') ?? '').match(JOB_ID)?.[1];
      if (!id || cards.has(id)) continue;

      // The card anchor is the one carrying the meta <p>; logo and bare-title
      // anchors for the same job id do not, and are skipped.
      const metaEl = anchor.querySelectorAll('p').find((p) => p.text.includes('·'));
      if (!metaEl) continue;

      const ad: ExtractedAd = {
        // Canonical URL derived from the id; the literal href is wrapped in
        // /comm/ and tracking params. The span still points at the source.
        url: span(anchor, `https://www.linkedin.com/jobs/view/${id}/`),
      };

      const titleEl = anchor
        .querySelectorAll('a, div')
        .find((el) => clean(el.text).length > 0);
      if (titleEl) ad.title = span(titleEl, clean(titleEl.text));

      const meta = clean(metaEl.text);
      const sep = meta.indexOf('·');
      if (sep > 0) {
        ad.company = span(metaEl, clean(meta.slice(0, sep)));
        // Location keeps the raw tail, modality included ("Berlín (Híbrido)");
        // normalization is a later stage (§6.5).
        ad.location = span(metaEl, clean(meta.slice(sep + 1)));
      }

      cards.set(id, ad);
    }

    const ads = [...cards.values()];
    const n = ads.length;
    const count = (field: keyof ExtractedAd): number => ads.filter((a) => a[field]).length;
    const report = (name: string, ok: number): { name: string; ok: boolean; value: string } => ({
      name,
      ok: n > 0 && ok === n,
      value: `${ok} of ${n}`,
    });

    return {
      ads,
      fieldReport: [
        report('Title', count('title')),
        report('Company', count('company')),
        report('Location', count('location')),
        report('Link', count('url')),
      ],
    };
  },
};
