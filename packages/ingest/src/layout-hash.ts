/**
 * Structural fingerprint of an email's HTML (design §5.3).
 *
 * The hash covers the set of root-to-node *tag* paths with text stripped.
 * Classes are deliberately excluded: measured against real LinkedIn alerts,
 * utility classes on optional card elements (logo variants, captions) vary
 * per send, producing a different hash for every email of the same template —
 * a fingerprint with no repeat sightings identifies nothing. Tag paths alone
 * converge: one hash per template, and a template change (e.g. fields moving
 * into a header image) still changes the tag structure and therefore the
 * hash.
 *
 * Parsers register against (platform, layout_hash); an unknown hash means we
 * know we are blind *before* parsing, and coverage per hash aggregated across
 * tenants is the layout-regression alarm.
 *
 * Privacy: computed from tag structure only — no text, no attribute values —
 * so the hash does not encode anyone's mail.
 */
import { createHash } from 'node:crypto';
import { HTMLElement, parse } from 'node-html-parser';

export function layoutHash(html: string): string {
  const root = parse(html, { comment: false });
  const paths = new Set<string>();

  const walk = (el: HTMLElement, prefix: string): void => {
    const tag = el.rawTagName?.toLowerCase() ?? '';
    const path = tag ? (prefix ? `${prefix}>${tag}` : tag) : prefix;
    if (tag) paths.add(path);
    for (const child of el.children) walk(child, path);
  };
  walk(root, '');

  const skeleton = [...paths].sort().join('\n');
  return createHash('sha256').update(skeleton).digest('hex').slice(0, 16);
}
