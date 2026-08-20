/**
 * PDF → plain text, for the CV role-discovery feature (docs/adr-001-role-discovery.md).
 * Sits beside eml.ts: same shape, bytes → structured content, pure and
 * testable, no I/O beyond the parse itself.
 *
 * Why this exists at all, rather than sending the PDF straight to the model.
 * I17 requires every proposed skill to cite a verbatim span of the user's own
 * text, checked with `verifyQuote` — and that check needs a text source to
 * check spans against. If the model read the PDF directly, there would be
 * nothing local to verify a citation against, and the gate that makes this
 * feature trustworthy would have nothing to bite on. So the text is always
 * extracted here first; only the extracted text is ever sent onward, and the
 * PDF bytes never leave this process (ADR-001 §2.8 — the CV itself is not
 * stored, and this is also why it is never forwarded anywhere).
 *
 * Every failure is reported, never silently downgraded to an empty result —
 * the same discipline §8.1 applies to an image-only alert email, applied here
 * to an image-only (scanned) CV.
 */
import { extractText, getDocumentProxy } from 'unpdf';

const MAGIC_BYTES = '%PDF-';

/** Generous for a CV; bounded against an accidental or abusive huge upload. */
export const MAX_CV_BYTES = 8 * 1024 * 1024;

/** A CV over 10 pages is unusual enough to be out of scope for v1 rather than guessed at. */
export const MAX_CV_PAGES = 10;

/**
 * Below this, extraction is treated as having found nothing — the honest
 * failure path for a scanned or image-only PDF. A one-page CV with a real
 * text layer runs into the hundreds of characters at minimum; this is a
 * conservative floor, not a precise measurement, and is meant to catch the
 * "near-zero text" case (a title, a name, page furniture) rather than to
 * finely distinguish a thin CV from a thick one.
 */
export const MIN_CV_TEXT_LENGTH = 200;

export type CvExtractionFailure =
  | 'not_a_pdf'
  | 'too_large'
  | 'too_many_pages'
  | 'no_text_layer'
  | 'corrupt';

export type CvExtraction =
  | { ok: true; text: string; pageCount: number }
  | { ok: false; reason: CvExtractionFailure };

export async function extractCvText(bytes: Buffer): Promise<CvExtraction> {
  // Magic bytes and size are checked before any parse attempt — cheap, and
  // reject a mislabeled upload or an oversized file without paying for one.
  if (bytes.subarray(0, 5).toString('latin1') !== MAGIC_BYTES) {
    return { ok: false, reason: 'not_a_pdf' };
  }
  if (bytes.length > MAX_CV_BYTES) {
    return { ok: false, reason: 'too_large' };
  }

  let pageCount: number;
  try {
    // Page count first, via the document proxy, before extracting any text —
    // an oversized page count is rejected without paying to extract text
    // from pages that are about to be thrown away.
    const pdf = await getDocumentProxy(new Uint8Array(bytes));
    pageCount = pdf.numPages;
    if (pageCount > MAX_CV_PAGES) {
      return { ok: false, reason: 'too_many_pages' };
    }

    const { text } = await extractText(pdf, { mergePages: true });
    if (text.trim().length < MIN_CV_TEXT_LENGTH) {
      return { ok: false, reason: 'no_text_layer' };
    }
    return { ok: true, text, pageCount };
  } catch {
    // pdf.js throws its own exception types for malformed input; any of them
    // collapses to the one reason a caller needs to act on — the file could
    // not be read as a PDF at all.
    return { ok: false, reason: 'corrupt' };
  }
}
