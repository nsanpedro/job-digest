/**
 * StepStone card extractor, written against 9 real emails from the live
 * "jobagent" subscription (design §14) — a mix of single-job nudges ("You're
 * a great fit: …", "Few applicants so far…") and one genuine multi-job digest
 * ("New job opportunities for you"). Despite very different subject lines and
 * intro copy, every one shares the same card markup once inside it:
 *
 *   <strong style="font-size:18px…">{title}</strong>
 *   <img alt="company">  … <td>{company}</td>
 *   <img alt="location"> … <td>{location}</td>
 *   <img alt="contract type"> … <td>{contract type}</td>
 *   <img alt="time">     … <td>{Vollzeit/Teilzeit}</td>
 *   <img alt="salary">   … <td>{salary band}</td>   (optional — not every card has one)
 *
 * The title's own <strong> is not itself a link (unlike LinkedIn's anchor-per-card);
 * the click-through is a separate button ("I'm interested" on single-job
 * nudges, "more" on the digest) that appears right after the icon block, so
 * it is picked up as "the first link seen after this card's first icon" —
 * the label text differs by template, the position doesn't.
 *
 * font-size:18px is what tells a real title apart from incidental bold text
 * in the same emails ("1 applicant", the footer copyright line) — both were
 * observed in the fixtures and neither carries that style.
 *
 * Every link on this platform is a click.stepstone.de tracking redirect, the
 * same situation Xing is in — there is no plain job URL to recover.
 */
import { HTMLElement, parse } from 'node-html-parser';
import type { ExtractedAd, ExtractResult, Extractor, FieldSpan } from './types';

const clean = (s: string): string => s.replace(/\s+/g, ' ').trim();

function span(el: HTMLElement, value: string): FieldSpan {
  const [start, end] = el.range;
  return { value, start, end, sourceKind: 'html' };
}

/** The spec icons observed across every fixture, mapped to the ExtractedAd field they feed. */
const ICON_FIELD: Record<string, keyof ExtractedAd> = {
  company: 'company',
  location: 'location',
  'contract type': 'contract',
  time: 'employmentType',
  salary: 'pay',
};

function isTitle(el: HTMLElement): boolean {
  return el.rawTagName === 'strong' && (el.getAttribute('style') ?? '').includes('18px');
}

function iconField(el: HTMLElement): keyof ExtractedAd | null {
  if (el.rawTagName !== 'img') return null;
  const alt = el.getAttribute('alt') ?? '';
  return ICON_FIELD[alt] ?? null;
}

export const stepstoneCards: Extractor = {
  platform: 'StepStone',
  id: 'stepstone-cards@1',
  layoutHashes: [
    // Single-job "jobagent" nudges — six subject/intro variants observed,
    // same card markup underneath (§ file doc above).
    'b28f6d55101c9081', // "Few applicants so far, a great chance to stand out"
    '8e1cb422f8f1c476', // "You're a great candidate: …"
    '8f108c3dc1d72fe2', // "You're in demand: …"
    '2cb0c2fc10dba773', // "You're a great fit: Engineering Manager, Integrations"
    '48bbe8c37d10b58f', // "You're a great fit: … Software Engineering"
    '8b88cbfa32cc38f8', // "Your skills are needed: …"
    '1f88c96e1e4a146f', // "Popular job, join 40+ others by applying"
    // The genuine multi-job digest.
    '0b6a9d23dd6d8c52', // "New job opportunities for you"
    // Onboarding mail with the same sender, no card at all — extracting zero
    // ads from it is correct, not a miss (outcome.ts's not_an_alert path).
    '4301a3ab1044f306', // "Save time when job hunting!"
  ],

  extract(email): ExtractResult {
    const root = parse(email.bodyHtml ?? '', { comment: false });
    const nodes = root.querySelectorAll('strong, img[alt], a');

    const ads: ExtractedAd[] = [];
    let current: ExtractedAd | null = null;
    let sawIconForCurrent = false;

    for (const el of nodes) {
      if (isTitle(el)) {
        current = { title: span(el, clean(el.text)) };
        sawIconForCurrent = false;
        ads.push(current);
        continue;
      }
      if (!current) continue;

      const field = iconField(el);
      if (field) {
        const td = el.closest('td');
        const value = td ? clean(td.text) : '';
        if (value) (current[field] as FieldSpan | undefined) = span(td ?? el, value);
        sawIconForCurrent = true;
        continue;
      }

      if (el.rawTagName === 'a' && sawIconForCurrent && !current.url) {
        const href = el.getAttribute('href');
        if (href) current.url = span(el, href);
      }
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
        // Absence on some cards is the ad's doing, not the reader's (§9) — same framing as Xing's salary report.
        { name: 'Salary', ok: n > 0, value: `${count('pay')} of ${n} stated` },
      ],
    };
  },
};
