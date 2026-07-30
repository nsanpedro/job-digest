/**
 * Structural fingerprint of an email's HTML (design §5.3).
 *
 * The hash covers the set of root-to-node *block-level tag* paths, with text,
 * attributes and inline formatting tags stripped. Both exclusions are
 * measured, not aesthetic:
 *
 * - Classes: real LinkedIn alerts vary utility classes on optional card
 *   elements per send — with classes hashed, every email got its own hash,
 *   and a fingerprint with no repeat sightings identifies nothing.
 * - Inline tags (span/b/br/…): real Xing alerts wrap parts of the greeting in
 *   <span>/<br> depending on content, and a 2026 Xing redesign renamed every
 *   class and reshuffled spans while leaving the block/table structure — the
 *   thing extractors actually walk — untouched. Three emails spanning
 *   Apr 2025 → Jul 2026 converge on one hash under this definition, and one
 *   extractor does handle all three.
 *
 * The granularity rule: the fingerprint must change exactly when a registered
 * extractor might stop fitting. Extractors anchor on block structure, so the
 * fingerprint hashes block structure. Structural failures still move it: the
 * Xing fields-into-header-image case replaces text rows with an <img>, and
 * img is deliberately not an excluded tag.
 *
 * Privacy: computed from tag structure only — no text, no attribute values —
 * so the hash does not encode anyone's mail.
 */
import { createHash } from 'node:crypto';
import { HTMLElement, parse } from 'node-html-parser';

/** Text-formatting tags: emphasis and line-wrapping, not layout. */
const INLINE_TAGS = new Set([
  'span',
  'b',
  'strong',
  'i',
  'em',
  'u',
  'br',
  'font',
  'sub',
  'sup',
  'small',
]);

export function layoutHash(html: string): string {
  const root = parse(html, { comment: false });
  const paths = new Set<string>();

  const walk = (el: HTMLElement, prefix: string): void => {
    const tag = el.rawTagName?.toLowerCase() ?? '';
    const skip = !tag || INLINE_TAGS.has(tag);
    const path = skip ? prefix : prefix ? `${prefix}>${tag}` : tag;
    if (!skip) paths.add(path);
    for (const child of el.children) walk(child, path);
  };
  walk(root, '');

  const skeleton = [...paths].sort().join('\n');
  return createHash('sha256').update(skeleton).digest('hex').slice(0, 16);
}
