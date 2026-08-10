/**
 * `extractCvText` — PDF → text for the CV role-discovery feature.
 *
 * Unlike the alert-email fixture corpus (test/fixtures/README.md), these PDFs
 * are hand-built rather than real documents, and that is deliberate rather
 * than a shortcut. The README's "must be real" rule exists because the alert
 * parsers are written against a specific vendor's HTML layout, and I2's
 * re-parse guarantee is only meaningful against layouts that actually occur.
 * `extractCvText` doesn't parse a vendor's layout — it parses the PDF format
 * itself via pdf.js, so what needs testing is PDF-structural edge cases
 * (missing text layer, page count, corrupt bytes), not "did a job board
 * change its markup". A hand-built PDF can construct those exactly and
 * deterministically; a handful of real CVs could not guarantee covering all
 * of them. No real person's CV is used or represented here.
 */
import { describe, expect, it } from 'vitest';
import { extractCvText, MAX_CV_BYTES, MIN_CV_TEXT_LENGTH } from '../src/cv-pdf';

/**
 * Break a page's text into lines that fit the page width. Not cosmetic:
 * found live while writing these tests — pdf.js's text extraction only
 * returns text that renders within the page's MediaBox, so a long string
 * placed on a single unwrapped line comes back silently truncated at the
 * page edge (confirmed by varying the string length and watching the cutoff
 * track the rendered line width, not any fixed character count). 60 chars is
 * conservative for 12pt Helvetica inside a 612pt-wide page with 72pt margins.
 */
function wrapLines(text: string, maxCharsPerLine = 60): string[] {
  const words = text.split(' ');
  const lines: string[] = [];
  let line = '';
  for (const word of words) {
    const candidate = line ? `${line} ${word}` : word;
    if (candidate.length > maxCharsPerLine && line) {
      lines.push(line);
      line = word;
    } else {
      line = candidate;
    }
  }
  if (line) lines.push(line);
  return lines;
}

/**
 * The smallest valid PDF that carries real, extractable text — one text
 * object per page, via a minimal object/xref table written by hand. Good
 * enough to exercise pdf.js's real parser (this is not a fake response, it is
 * a real, spec-valid PDF), without needing an external PDF-generation tool
 * that is not available in this environment.
 */
function buildPdf(pageTexts: string[]): Buffer {
  const pageCount = pageTexts.length;
  const objs: string[] = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    `<< /Type /Pages /Kids [${pageTexts.map((_, i) => `${3 + i * 2} 0 R`).join(' ')}] /Count ${pageCount} >>`,
  ];
  for (const text of pageTexts) {
    const lines = wrapLines(text.replace(/[()\\]/g, ''));
    const content = [
      'BT',
      '/F1 12 Tf',
      '72 720 Td',
      '14 TL',
      ...lines.map((line, i) => `${i > 0 ? 'T*\n' : ''}(${line}) Tj`),
      'ET',
    ].join('\n');
    objs.push(
      `<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 ${3 + pageCount * 2} 0 R >> >> /MediaBox [0 0 612 792] /Contents ${objs.length + 2} 0 R >>`,
    );
    objs.push(`<< /Length ${content.length} >>\nstream\n${content}\nendstream`);
  }
  objs.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');

  let pdf = '%PDF-1.4\n';
  const offsets = [0];
  objs.forEach((o, i) => {
    offsets.push(pdf.length);
    pdf += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xrefStart = pdf.length;
  pdf += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (let i = 1; i <= objs.length; i++) pdf += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF`;
  return Buffer.from(pdf, 'latin1');
}

/** A page with no /Contents at all — the honest stand-in for a scanned/image-only PDF. */
function buildPdfWithNoText(): Buffer {
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /Resources << >> /MediaBox [0 0 612 792] >>',
  ];
  let pdf = '%PDF-1.4\n';
  const offsets = [0];
  objs.forEach((o, i) => {
    offsets.push(pdf.length);
    pdf += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xrefStart = pdf.length;
  pdf += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (let i = 1; i <= objs.length; i++) pdf += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF`;
  return Buffer.from(pdf, 'latin1');
}

// Generic, fictional filler — long enough to clear MIN_CV_TEXT_LENGTH,
// matching the redaction convention already used for StepStone fixtures
// (generic name, no real person).
const CV_LIKE_TEXT =
  'Jane Doe - Senior Fullstack Engineer. Experience: Built and maintained ' +
  'web applications using TypeScript, React and Node.js across five years at ' +
  'two companies. Led a team of four engineers on a checkout redesign that ' +
  'reduced page load time by forty percent. Comfortable with PostgreSQL, ' +
  'Docker and CI/CD pipelines. Fluent in English and German (B2). Education: ' +
  'BSc Computer Science.';

describe('extractCvText', () => {
  it('extracts real text from a valid single-page PDF', async () => {
    const result = await extractCvText(buildPdf([CV_LIKE_TEXT]));
    expect(result).toMatchObject({ ok: true, pageCount: 1 });
    if (result.ok) expect(result.text).toContain('Jane Doe');
  });

  it('reads text across multiple pages', async () => {
    const half = CV_LIKE_TEXT.slice(0, 120);
    const result = await extractCvText(buildPdf([half, half]));
    expect(result).toMatchObject({ ok: true, pageCount: 2 });
  });

  it('rejects bytes that are not a PDF at all, before attempting to parse', async () => {
    const result = await extractCvText(Buffer.from('this is a plain text file, not a PDF'));
    expect(result).toEqual({ ok: false, reason: 'not_a_pdf' });
  });

  it('rejects a PDF over the size cap without attempting to parse it', async () => {
    const oversized = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(MAX_CV_BYTES)]);
    const result = await extractCvText(oversized);
    expect(result).toEqual({ ok: false, reason: 'too_large' });
  });

  it('rejects a PDF over the page cap without extracting its text', async () => {
    const elevenPages = Array.from({ length: 11 }, (_, i) => `Page ${i + 1}`);
    const result = await extractCvText(buildPdf(elevenPages));
    expect(result).toEqual({ ok: false, reason: 'too_many_pages' });
  });

  it('reports a scanned/image-only PDF as no_text_layer, never as an empty CV', async () => {
    const result = await extractCvText(buildPdfWithNoText());
    expect(result).toEqual({ ok: false, reason: 'no_text_layer' });
  });

  it('reports a title-only PDF (some text, but under the floor) as no_text_layer', async () => {
    const result = await extractCvText(buildPdf(['Jane Doe']));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('no_text_layer');
    expect('Jane Doe'.length).toBeLessThan(MIN_CV_TEXT_LENGTH);
  });

  it('reports malformed PDF bytes as corrupt, not as a throw', async () => {
    const malformed = Buffer.from('%PDF-1.4\nthis is not valid PDF object syntax at all\n%%EOF');
    await expect(extractCvText(malformed)).resolves.toEqual({ ok: false, reason: 'corrupt' });
  });
});
