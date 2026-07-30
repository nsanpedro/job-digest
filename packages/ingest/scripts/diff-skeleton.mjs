// Dev tool: diff the structural skeletons of two .eml files to see why their
// layout hashes differ. Usage: node scripts/diff-skeleton.mjs a.eml b.eml
import { readFileSync } from 'node:fs';
import { simpleParser } from 'mailparser';
import { parse } from 'node-html-parser';

async function skeleton(path) {
  const mail = await simpleParser(readFileSync(path));
  const html = typeof mail.html === 'string' ? mail.html : '';
  const paths = new Set();
  const walk = (el, prefix) => {
    const tag = el.rawTagName?.toLowerCase() ?? '';
    const classes = el.classList ? [...el.classList.values()].sort() : [];
    const label = tag ? (classes.length ? `${tag}.${classes.join('.')}` : tag) : '';
    const path = label ? (prefix ? `${prefix}>${label}` : label) : prefix;
    if (label) paths.add(path);
    for (const c of el.children ?? []) walk(c, path);
  };
  walk(parse(html, { comment: false }), '');
  return paths;
}

const [a, b] = [await skeleton(process.argv[2]), await skeleton(process.argv[3])];
const onlyA = [...a].filter((p) => !b.has(p));
const onlyB = [...b].filter((p) => !a.has(p));
console.log(`paths: A=${a.size} B=${b.size} | only in A: ${onlyA.length} | only in B: ${onlyB.length}`);
const tail = (p) => p.split('>').slice(-3).join('>');
console.log('\n-- only in A (last 3 segments, first 15):');
for (const p of onlyA.slice(0, 15)) console.log('  ', tail(p));
console.log('\n-- only in B (last 3 segments, first 15):');
for (const p of onlyB.slice(0, 15)) console.log('  ', tail(p));
