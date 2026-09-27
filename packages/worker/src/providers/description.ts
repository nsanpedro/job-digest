/**
 * Job-description text for `ads.description` (ADR-003 §8.x "Descriptions in
 * matching"). One place that turns whatever a provider hands us — HTML,
 * HTML-entity-escaped HTML (Greenhouse `content`), CDATA-wrapped HTML
 * (Personio), or already-plain text (Lever `descriptionPlain`, Ashby
 * `descriptionPlain`) — into the plain text we store and match against.
 *
 * Shape of the output, and why:
 *
 *   - Block boundaries (<p>, <li>, <br>, headings, …) become newlines. The
 *     matcher (`computeMatch` in core/matching.ts) treats "\n" as a phrase
 *     separator, so a heading line "Engineering Manager (m/w/d)" stays its
 *     own segment instead of running into the next paragraph.
 *   - Inline tags (<strong>, <span>, <a>) vanish without a space, so
 *     "<b>Engineering</b> Manager" reads as the phrase it is.
 *   - Whitespace collapses within a line; empty lines are dropped. The
 *     400-char match window (DESCRIPTION_MATCH_CHARS) is spent on words,
 *     not on indentation.
 *   - Capped at DESCRIPTION_MAX_CHARS — see there.
 *
 * Regex-based on purpose, like personio.ts's XML reader: job-board HTML is
 * shallow, and a DOM parser dependency for "strip tags, keep paragraphs"
 * is not worth it in a worker that Next bundles. Not a sanitizer — the
 * output is never rendered as HTML.
 */

/**
 * Stored-description cap (characters). The matcher only reads the first
 * 400 (DESCRIPTION_MATCH_CHARS), so this is not about matching. It is sized
 * so that:
 *
 *   - it covers the LLM fact extraction window (`MAX_TEXT_CHARS` = 3 500 in
 *     enrich/extract-from-text.ts) with slack — a later re-extraction or a
 *     re-tuned match window can run from the stored text without a
 *     re-fetch, reading what enrichment read;
 *   - it holds a typical job ad's lede + responsibilities + requirements
 *     (plain text of a real posting is ~2–6k chars; the tail is benefits
 *     and EEO boilerplate, which nothing here should read anyway);
 *   - it bounds row growth: ≤ ~4 KB per ad (TOAST-compressed above 2 KB),
 *     i.e. a few MB per user per year at hundreds of ads a week.
 */
export const DESCRIPTION_MAX_CHARS = 4000;

const BLOCK_TAGS =
  'p|div|br|li|ul|ol|h[1-6]|tr|td|th|table|thead|tbody|section|article|header|footer|blockquote|pre|hr|dl|dt|dd';
const BLOCK_TAG_RE = new RegExp(`<\\/?(?:${BLOCK_TAGS})\\b[^>]*>`, 'gi');
const ANY_TAG_RE = /<\/?[a-z][^>]*>/gi;
const COMMENT_RE = /<!--[\s\S]*?-->/g;
const SCRIPT_STYLE_RE = /<(script|style|head)\b[^>]*>[\s\S]*?<\/\1\s*>/gi;
const CDATA_RE = /<!\[CDATA\[([\s\S]*?)\]\]>/g;

const NAMED_ENTITIES: Readonly<Record<string, string>> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  ndash: '–', mdash: '—', hellip: '…', bull: '•', middot: '·',
  lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', laquo: '«', raquo: '»',
  euro: '€', pound: '£', copy: '©', reg: '®', trade: '™',
  auml: 'ä', ouml: 'ö', uuml: 'ü', Auml: 'Ä', Ouml: 'Ö', Uuml: 'Ü', szlig: 'ß',
  aacute: 'á', eacute: 'é', iacute: 'í', oacute: 'ó', uacute: 'ú', ntilde: 'ñ',
  Aacute: 'Á', Eacute: 'É', Iacute: 'Í', Oacute: 'Ó', Uacute: 'Ú', Ntilde: 'Ñ',
  agrave: 'à', egrave: 'è', ccedil: 'ç',
};

/**
 * Decode HTML entities in one pass (so "&amp;lt;" becomes the literal
 * "&lt;", not "<"). Unknown named entities are left as written — honest,
 * and harmless to the matcher.
 */
export function decodeEntities(s: string): string {
  return s.replace(/&(#\d+|#x[0-9a-f]+|[a-z][a-z0-9]*);/gi, (whole, body: string) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      // Out-of-range / NUL code points are dropped rather than thrown on.
      if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return '';
      return String.fromCodePoint(code);
    }
    return NAMED_ENTITIES[body] ?? whole;
  });
}

/**
 * HTML (or escaped HTML, or plain text) → plain text with one line per
 * block. Returns '' for input with no text in it.
 */
export function htmlToText(input: string): string {
  let s = input.replace(CDATA_RE, '$1');
  // Greenhouse's `content` is HTML with its markup entity-escaped
  // ("&lt;p&gt;We are…"). When there are no real tags but escaped ones,
  // unescape once so the tag pass below sees the markup.
  if (!/<[a-z!/]/i.test(s) && /&lt;\/?[a-z]/i.test(s)) s = decodeEntities(s);
  s = s
    .replace(COMMENT_RE, '')
    .replace(SCRIPT_STYLE_RE, '\n')
    .replace(BLOCK_TAG_RE, '\n')
    .replace(ANY_TAG_RE, '');
  return normalizeText(decodeEntities(s));
}

/**
 * Whitespace + control-character normalisation for text that is already
 * plain (Lever/Ashby `descriptionPlain`) or just came out of `htmlToText`.
 * Postgres `text` rejects NUL, so control characters other than newline
 * and tab go; tabs and every Unicode space collapse to one space per run.
 */
export function normalizeText(s: string): string {
  return s
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, ' ')
    .split('\n')
    .map((line) => line.replace(/[\s  -​  　]+/g, ' ').trim())
    .filter((line) => line.length > 0)
    .join('\n');
}

/** Truncate to DESCRIPTION_MAX_CHARS without splitting a surrogate pair. */
function cap(s: string): string {
  if (s.length <= DESCRIPTION_MAX_CHARS) return s;
  let out = s.slice(0, DESCRIPTION_MAX_CHARS);
  const last = out.charCodeAt(out.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) out = out.slice(0, -1);
  return out.trimEnd();
}

/**
 * Storage-ready description from one or more raw parts (HTML or plain),
 * joined as separate blocks. Null when there is no text at all — "the
 * source has no description" stays null (I4), never an empty string.
 */
export function toStoredDescription(...parts: ReadonlyArray<string | null | undefined>): string | null {
  const text = parts
    .filter((p): p is string => typeof p === 'string' && p.length > 0)
    .map(htmlToText)
    .filter((p) => p.length > 0)
    .join('\n');
  return text.length > 0 ? cap(text) : null;
}
