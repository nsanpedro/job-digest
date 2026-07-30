/**
 * The I5 gate: every German quote rendered in the UI must be a verified
 * substring of the stored email source, after whitespace normalization.
 *
 * This is the hard constraint on LLM involvement (§8.1): a model may point at
 * text, never author it. A proposed quote that fails this check is discarded
 * and the field degrades to `unknown` — a cheap, deterministic check that
 * removes hallucination from the trust path entirely.
 */

/**
 * Collapse whitespace runs to single spaces and drop soft hyphens (U+00AD),
 * which email HTML inserts freely mid-word. \s already covers NBSP and the
 * narrow no-break space German number formatting uses.
 */
export function normalizeWhitespace(s: string): string {
  return s.replace(/\u00AD/g, '').replace(/\s+/g, ' ').trim();
}

export function verifyQuote(quote: string, source: string): boolean {
  const q = normalizeWhitespace(quote);
  if (q.length === 0) return false;
  return normalizeWhitespace(source).includes(q);
}
