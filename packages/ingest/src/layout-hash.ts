/**
 * Structural fingerprint of an email's HTML (design §5.3).
 *
 * The hash covers the set of tag+class paths with all text stripped, so it is
 * stable across different ads in the same template and changes when the
 * template changes. Parsers register against (platform, layout_hash); an
 * unknown hash means we know we are blind *before* parsing, and coverage per
 * hash aggregated across tenants is the layout-regression alarm.
 *
 * Privacy: computed from structure only — no text, no attribute values — so
 * the hash does not encode anyone's mail.
 */
import { createHash } from 'node:crypto';
import { HTMLElement, parse } from 'node-html-parser';

function nodeLabel(el: HTMLElement): string {
  const tag = el.rawTagName?.toLowerCase() ?? '';
  if (!tag) return '';
  const classes = [...el.classList.values()].sort();
  return classes.length ? `${tag}.${classes.join('.')}` : tag;
}

export function layoutHash(html: string): string {
  const root = parse(html, { comment: false });
  const paths = new Set<string>();

  const walk = (el: HTMLElement, prefix: string): void => {
    const label = nodeLabel(el);
    const path = label ? (prefix ? `${prefix}>${label}` : label) : prefix;
    if (label) paths.add(path);
    for (const child of el.children) walk(child, path);
  };
  walk(root, '');

  const skeleton = [...paths].sort().join('\n');
  return createHash('sha256').update(skeleton).digest('hex').slice(0, 16);
}
