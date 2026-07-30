/**
 * Dedupe key behaviour (design §6.7), pinned by the real corpus.
 */
import { describe, expect, it } from 'vitest';
import { dedupeKey, externalId } from '../src/index';
import type { ExtractedAd } from '../src/index';

const fieldSpan = (value: string) => ({ value, start: 0, end: 0, sourceKind: 'html' as const });
const ad = (title: string, company: string, location: string, url?: string): ExtractedAd => ({
  title: fieldSpan(title),
  company: fieldSpan(company),
  location: fieldSpan(location),
  ...(url ? { url: fieldSpan(url) } : {}),
});

describe('externalId', () => {
  it('reads the LinkedIn ad id', () => {
    expect(externalId('https://www.linkedin.com/jobs/view/4444332346/')).toBe('linkedin:4444332346');
    expect(externalId('https://www.linkedin.com/comm/jobs/view/4419910551/?trackingId=x')).toBe(
      'linkedin:4419910551',
    );
  });

  it('refuses Xing tracking tokens — they encode (email, position), not the ad', () => {
    // Measured: the same ADVERGY vacancy carries a different token per send.
    expect(externalId('https://www.xing.com/m/YahMNMkDcJ-e_vX5zzi7AO')).toBeNull();
    expect(externalId('https://www.xing.com/m/94iSGT4qTkJixj7pRpPNAR')).toBeNull();
  });

  it('is null when there is no url at all', () => {
    expect(externalId(undefined)).toBeNull();
  });
});

describe('dedupeKey', () => {
  it('is stable for the same ad seen twice', () => {
    const a = ad('Senior Frontend Engineer', 'Joppy', 'Barcelona (Híbrido)');
    const b = ad('Senior Frontend Engineer', 'Joppy', 'Barcelona (Híbrido)');
    expect(dedupeKey(a)).toBe(dedupeKey(b));
  });

  it('ignores modality decoration and country, so one vacancy on two platforms is one ad', () => {
    const linkedIn = ad('Frontend Developer', 'YOOtheme', 'Hamburgo');
    const xing = ad('Frontend Developer', 'YOOtheme GmbH', 'Hamburg');
    expect(dedupeKey(linkedIn)).toBe(dedupeKey(xing));
  });

  it('folds Spanish exonyms LinkedIn emits for German cities', () => {
    expect(dedupeKey(ad('Dev', 'ACME', 'Hamburgo (Híbrido)'))).toBe(
      dedupeKey(ad('Dev', 'ACME', 'Hamburg')),
    );
    expect(dedupeKey(ad('Dev', 'ACME', 'Berlín, Alemania (Presencial)'))).toBe(
      dedupeKey(ad('Dev', 'ACME', 'Berlin')),
    );
  });

  it('keeps two real ADVERGY postings apart — the hyphen carries meaning', () => {
    // Both in one Xing email, same agency and city, different salary bands.
    // Merging them would silently swallow a real ad (§6.7).
    const hyphen = ad('Fullstack-Entwickler (m/w/d) | Hamburg', 'ADVERGY GmbH', 'Hamburg');
    const space = ad('Fullstack Entwickler (m/w/d) | Hamburg', 'ADVERGY GmbH', 'Hamburg');
    expect(dedupeKey(hyphen)).not.toBe(dedupeKey(space));
  });

  it('separates different companies with the same title', () => {
    expect(dedupeKey(ad('Frontend Developer', 'YOOtheme', 'Hamburg'))).not.toBe(
      dedupeKey(ad('Frontend Developer', 'Nordason', 'Hamburg')),
    );
  });

  it('separates the same role in different cities', () => {
    expect(dedupeKey(ad('Frontend Developer', 'ACME', 'Hamburg'))).not.toBe(
      dedupeKey(ad('Frontend Developer', 'ACME', 'Berlin')),
    );
  });

  it('does not depend on fields whose extraction can degrade (I2)', () => {
    const complete = ad('Dev', 'ACME', 'Hamburg');
    const partlyRead: ExtractedAd = { ...complete, pay: fieldSpan('60.000 € - 87.000 €') };
    // A parser fix that starts reading pay must not duplicate every ad.
    expect(dedupeKey(complete)).toBe(dedupeKey(partlyRead));
  });
});
