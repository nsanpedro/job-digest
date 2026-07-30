/**
 * Fixture harness (design §14): discovers real .eml files under
 * test/fixtures/<platform>/ and runs the shared pipeline over each —
 * classify, layout hash, declared count, and (once an extractor exists for
 * the layout) extraction against the .expected.json sibling.
 *
 * With no fixtures present the suite reports itself as skipped, loudly:
 * parsers are only written against real emails, never invented ones.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { classify } from '../src/classify';
import { declaredCount } from '../src/declare';
import { parseEml } from '../src/eml';
import { extractorFor } from '../src/extract/registry';
import { layoutHash } from '../src/layout-hash';

interface Expected {
  platform: string;
  declaredCount: number | null;
  adCount?: number;
  titles?: string[];
}

const fixturesRoot = new URL('./fixtures', import.meta.url).pathname;

const fixtures: Array<{ name: string; emlPath: string; expected: Expected }> = [];
for (const dir of readdirSync(fixturesRoot, { withFileTypes: true })) {
  if (!dir.isDirectory()) continue;
  const dirPath = join(fixturesRoot, dir.name);
  for (const file of readdirSync(dirPath)) {
    if (!file.endsWith('.eml')) continue;
    const expectedPath = join(dirPath, file.replace(/\.eml$/, '.expected.json'));
    fixtures.push({
      name: `${dir.name}/${file}`,
      emlPath: join(dirPath, file),
      expected: JSON.parse(readFileSync(expectedPath, 'utf8')) as Expected,
    });
  }
}

describe('fixture corpus', () => {
  if (fixtures.length === 0) {
    // Visible as skipped in every run: the corpus is missing, not forgotten.
    it.skip('no fixtures yet — see test/fixtures/README.md to add real .eml exports', () => {});
  }

  for (const f of fixtures) {
    describe(f.name, () => {
      it('classifies to the expected platform', async () => {
        const email = await parseEml(readFileSync(f.emlPath));
        expect(classify(email.fromAddr)).toBe(f.expected.platform);
      });

      it('reads the declared count (I3)', async () => {
        const email = await parseEml(readFileSync(f.emlPath));
        const platform = classify(email.fromAddr);
        if (platform === 'not_allowlisted') expect.unreachable();
        else expect(declaredCount(platform, email.subject).count).toBe(f.expected.declaredCount);
      });

      it('extracts the expected ads — or is an honest unknown_layout', async () => {
        const email = await parseEml(readFileSync(f.emlPath));
        const platform = classify(email.fromAddr);
        if (platform === 'not_allowlisted' || !email.bodyHtml) {
          expect.unreachable();
          return;
        }
        const hash = layoutHash(email.bodyHtml);
        const extractor = extractorFor(platform, hash);
        if (!extractor) {
          // Not a pass by accident: surface the hash so writing the extractor
          // for this layout starts from the test output.
          expect.fail(
            `no extractor registered for ${platform} layout ${hash} — write one against this fixture`,
          );
          return;
        }
        const result = extractor.extract(email);
        if (f.expected.adCount !== undefined) expect(result.ads).toHaveLength(f.expected.adCount);
        if (f.expected.titles) {
          expect(result.ads.map((a) => a.title?.value)).toEqual(f.expected.titles);
        }
      });
    });
  }
});
