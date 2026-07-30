/**
 * Xing card extractor, written against the fixture corpus (design §14).
 *
 * The card is a small table whose direct rows read, in order:
 *
 *   [optional badge row]  "Dringend gesucht" / "Zu den Ersten gehören"
 *   title row             <a> …title… (wrapped in span/b/u — inline noise)
 *   company row           plain text
 *   location row          plain text
 *   [optional meta row]   spans: employment type, and often a salary band
 *
 * Xing sends a salary band on most cards ("47.000 € - 69.500 €") — unlike
 * LinkedIn, which never does. platform_capabilities records that difference;
 * here it just means the Pay rule has real input from this platform.
 *
 * One structural template covers Apr 2025 → Jul 2026: a 2026 redesign renamed
 * classes and reshuffled inline spans but left the block structure intact,
 * which is exactly why the layout hash ignores both (see layout-hash.ts).
 *
 * Job URLs are opaque tracking redirects (/m/{token}) with no job id, so
 * within-email dedupe keys on title|company instead.
 */
import { HTMLElement, parse } from 'node-html-parser';
import type { ExtractedAd, ExtractResult, Extractor, FieldSpan } from './types';

const clean = (s: string): string => s.replace(/\s+/g, ' ').trim();

function span(el: HTMLElement, value: string): FieldSpan {
  const [start, end] = el.range;
  return { value, start, end, sourceKind: 'html' };
}

/** Direct rows of a table, tolerating an implicit or explicit tbody. */
function directRows(table: HTMLElement): HTMLElement[] {
  const tbody = table.children.find((c) => c.rawTagName === 'tbody') ?? table;
  return tbody.children.filter((c) => c.rawTagName === 'tr');
}

/**
 * Walk up from an anchor to the card table: the nearest ancestor table whose
 * direct rows contain the anchor's row followed by two short text rows
 * (company, location). Header/footer links never sit in such a table.
 */
function findCard(
  anchor: HTMLElement,
): { rows: HTMLElement[]; titleIdx: number } | null {
  let el: HTMLElement | null = anchor.parentNode;
  for (let depth = 0; el && depth < 6; depth++, el = el.parentNode) {
    if (el.rawTagName !== 'table') continue;
    const rows = directRows(el);
    if (rows.length < 3 || rows.length > 8) continue;
    const titleIdx = rows.findIndex((r) => r.querySelectorAll('a').some((a) => a === anchor));
    if (titleIdx < 0 || titleIdx + 2 >= rows.length) continue;
    const company = clean(rows[titleIdx + 1]?.text ?? '');
    const location = clean(rows[titleIdx + 2]?.text ?? '');
    if (!company || !location || company.length > 100 || location.length > 60) continue;
    return { rows, titleIdx };
  }
  return null;
}

export const xingCards: Extractor = {
  platform: 'Xing',
  id: 'xing-cards@1',
  layoutHashes: ['db693329b63ee72b'],

  extract(email): ExtractResult {
    const root = parse(email.bodyHtml ?? '', { comment: false });
    const seen = new Set<string>();
    const ads: ExtractedAd[] = [];
    let salaryStated = 0;

    for (const anchor of root.querySelectorAll('a')) {
      const title = clean(anchor.text);
      if (!title) continue;
      const card = findCard(anchor);
      if (!card) continue;

      const { rows, titleIdx } = card;
      const companyEl = rows[titleIdx + 1];
      const locationEl = rows[titleIdx + 2];
      if (!companyEl || !locationEl) continue;

      const key = `${title}|${clean(companyEl.text)}`;
      if (seen.has(key)) continue;
      seen.add(key);

      const ad: ExtractedAd = {
        title: span(anchor, title),
        company: span(companyEl, clean(companyEl.text)),
        location: span(locationEl, clean(locationEl.text)),
        // Opaque tracking redirect — the only link Xing gives us.
        url: span(anchor, anchor.getAttribute('href') ?? ''),
      };

      const metaEl = rows[titleIdx + 3];
      if (metaEl) {
        const spans = metaEl.querySelectorAll('span');
        const salaryEl = spans.find((s) => s.text.includes('€'));
        const typeEl = spans.find((s) => clean(s.text).length > 0 && !s.text.includes('€'));
        if (salaryEl) {
          ad.pay = span(salaryEl, clean(salaryEl.text));
          salaryStated++;
        }
        if (typeEl) {
          ad.employmentType = span(typeEl, clean(typeEl.text));
        } else if (!salaryEl && clean(metaEl.text)) {
          // Older markup variant: the meta row is plain text.
          ad.employmentType = span(metaEl, clean(metaEl.text));
        }
      }

      ads.push(ad);
    }

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
        // Absence on some cards is the ad's doing, not the reader's (§9).
        { name: 'Salary', ok: n > 0, value: `${salaryStated} of ${n} stated` },
      ],
    };
  },
};
