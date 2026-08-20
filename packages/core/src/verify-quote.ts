/**
 * The citation gate: every quote shown to a user (an ad's German wording, a
 * skill read from a CV) must be a verified substring of the stored source,
 * after whitespace normalization.
 *
 * Originated as the I5 gate (§8.1) for ad quotes — a model may point at
 * text, never author it, and a proposed quote that fails this check is
 * discarded, degrading the field to `unknown` rather than showing an
 * unverified claim. I17 (ADR-001) reuses it verbatim for CV skills: the
 * mechanism doesn't care what kind of source text it's checking against.
 *
 * Lives in `core`, not `ingest`, because both the ad pipeline (`ingest`) and
 * the CV role-discovery pipeline need it, and `ingest` has no reason to
 * depend on anything CV-related. Re-exported from `@job-digest/ingest` for
 * existing call sites.
 */

/**
 * Collapse whitespace runs to single spaces and drop soft hyphens (U+00AD),
 * which email HTML (and some PDF exporters) insert freely mid-word. \s
 * already covers NBSP and the narrow no-break space German number
 * formatting uses.
 */
export function normalizeWhitespace(s: string): string {
  return s.replace(/\u00AD/g, '').replace(/\s+/g, ' ').trim();
}

export function verifyQuote(quote: string, source: string): boolean {
  const q = normalizeWhitespace(quote);
  if (q.length === 0) return false;
  return normalizeWhitespace(source).includes(q);
}
