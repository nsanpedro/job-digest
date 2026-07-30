// Exploration only — the committed pipeline uses packages/ingest/src.
import { readFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { simpleParser } from 'mailparser';
import { parse } from 'node-html-parser';

const dir = process.argv[2];

// Tag-only paths, matching src/layout-hash.ts (classes are per-send churn).
function layoutHash(html) {
  const paths = new Set();
  const walk = (el, prefix) => {
    const tag = el.rawTagName?.toLowerCase() ?? '';
    const path = tag ? (prefix ? `${prefix}>${tag}` : tag) : prefix;
    if (tag) paths.add(path);
    for (const c of el.children ?? []) walk(c, path);
  };
  walk(parse(html, { comment: false }), '');
  return createHash('sha256').update([...paths].sort().join('
')).digest('hex').slice(0, 16);
}

for (const file of readdirSync(dir).filter((f) => f.endsWith('.eml'))) {
  const mail = await simpleParser(readFileSync(join(dir, file)));
  const html = typeof mail.html === 'string' ? mail.html : '';
  console.log('=== ' + file);
  console.log('from:', mail.from?.value[0]?.address, '| date:', mail.date?.toISOString());
  console.log('subject:', mail.subject);
  console.log('html bytes:', html.length, '| text bytes:', (mail.text ?? '').length, '| attachments:', mail.attachments.length);
  if (html) {
    console.log('layoutHash:', layoutHash(html));
    const root = parse(html);
    const jobLinks = root.querySelectorAll('a').filter((a) => /\/jobs\/view\//.test(a.getAttribute('href') ?? ''));
    console.log('anchors -> /jobs/view/:', jobLinks.length);
    for (const a of jobLinks.slice(0, 6)) {
      const text = a.text.replace(/\s+/g, ' ').trim().slice(0, 90);
      if (text) console.log('  •', JSON.stringify(text));
    }
  }
  console.log('');
}
