/**
 * Normalization suite (design §6.5). Vocabulary is pinned by two sources:
 * the real fixture corpus (Xing salary bands, employment pills, LinkedIn
 * Spanish modality markers) and the design doc's German ad fixtures (j1–j10,
 * d1–d4), which the ad bodies will bring once full ads are read.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { evaluate, isBlocked, type Ruleset } from '@job-digest/core';
import { describe, expect, it } from 'vitest';
import {
  classify,
  layoutHash,
  normalizeAd,
  normalizeContract,
  normalizeEmployment,
  normalizeGerman,
  normalizePay,
  normalizeShift,
  normalizeWorkplace,
  parseEml,
  extractorFor,
  verifyQuote,
} from '../src/index';

describe('normalizePay', () => {
  it('Xing annual band → monthly, ÷12, original preserved by the caller', () => {
    expect(normalizePay('47.000 € - 69.500 €')).toMatchObject({
      pay: 3917,
      payMax: 5792,
      derivedFromAnnual: true,
    });
  });

  it('explicit monthly marker beats the magnitude heuristic', () => {
    expect(normalizePay('2.900 – 3.300 € brutto/Monat')).toMatchObject({
      pay: 2900,
      payMax: 3300,
      derivedFromAnnual: false,
    });
  });

  it('part-time figure gets an FTE projection — design j3 pins the 40h week', () => {
    expect(normalizePay('2.250 € brutto bei 30 Std.')).toMatchObject({
      pay: 2250,
      payFte: 3000,
      fteNote: 'at 30h',
    });
    expect(normalizePay('1.250 € brutto bei 20 Std.')).toMatchObject({ payFte: 2500 });
  });

  it('"bis X" bands top out there — design j6', () => {
    expect(normalizePay('bis 2.600 € brutto')).toMatchObject({ pay: 2600, payMax: 2600 });
  });

  it('TVöD is a table lookup, not parsing; unknown groups are null, not guesses', () => {
    expect(normalizePay('Vergütung nach TVöD E5')).toMatchObject({ pay: 2930 });
    expect(normalizePay('Vergütung nach TVöD E9')).toBeNull();
    expect(normalizePay('Vergütung nach TVöD E9', { E9: 3560 })).toMatchObject({ pay: 3560 });
  });

  it('base figure survives bonus talk', () => {
    expect(normalizePay('2.750 € zzgl. Bonus')).toMatchObject({ pay: 2750 });
    expect(normalizePay('3.200 € plus 13. Monatsgehalt')).toMatchObject({ pay: 3200 });
  });

  it('an ad with no figure is null — "attraktives Gehalt" is not a number (I4)', () => {
    expect(normalizePay('attraktives Gehalt')).toBeNull();
    expect(normalizePay('')).toBeNull();
  });
});

describe('normalizeWorkplace', () => {
  const cases: Array<[string, number | null]> = [
    ['Alemania (En remoto)', 5],
    ['Berlín, Alemania (Presencial)', 0],
    ['Hamburgo (Híbrido)', null],
    ['100 % remote innerhalb Deutschlands', 5],
    ['2 Tage Homeoffice pro Woche möglich', 2],
    ['Kein Homeoffice – das Büro ist der Ort', 0],
    ['80 % Remote | Hamburg', 4],
    ['Remote-Optional', null],
    ['Präsenz im Büro Winterhude', 0],
  ];
  for (const [text, home] of cases) {
    it(`"${text}" → home: ${home}`, () => {
      const w = normalizeWorkplace(text);
      expect(w).not.toBeNull();
      expect(w?.home).toBe(home);
    });
  }

  it('a bare city says nothing about home office', () => {
    expect(normalizeWorkplace('Hamburg')).toBeNull();
  });

  it('hybrid without a number is null-with-wording, not a guess (I4)', () => {
    const w = normalizeWorkplace('Hamburgo (Híbrido)');
    expect(w?.home).toBeNull();
    expect(w?.matched).toBe('Híbrido');
  });
});

describe('normalizeEmployment', () => {
  it('the three Xing pills', () => {
    expect(normalizeEmployment('Vollzeit')).toMatchObject({ kind: 'fulltime', permanent: null });
    expect(normalizeEmployment('Teilzeit')).toMatchObject({ kind: 'parttime', hours: null });
    expect(normalizeEmployment('Selbstständig')).toMatchObject({
      kind: 'freelance',
      permanent: false,
    });
  });

  it('part-time hours when stated', () => {
    expect(normalizeEmployment('Teilzeit ab 30 Std.')).toMatchObject({ hours: 30 });
  });
});

describe('normalizeGerman — design fixture vocabulary', () => {
  const cases: Array<[string, string]> = [
    ['verhandlungssicheres Deutsch', 'C1'],
    ['gute Deutschkenntnisse in Wort und Schrift', 'B2'],
    ['sehr gute Deutschkenntnisse (C1)', 'C1'],
    ['Deutsch mindestens B2', 'B2'],
    ['Deutsch fließend, B2 ausreichend', 'B2'],
    ['Spanisch auf Muttersprachniveau, Deutsch B2', 'B2'],
    ['Deutschkenntnisse', 'B2'],
    ['verhandlungssicher, technisches Vokabular', 'C1'],
  ];
  for (const [text, level] of cases) {
    it(`"${text}" → ${level}`, () => {
      expect(normalizeGerman(text)?.level).toBe(level);
    });
  }

  it('text not about German is null', () => {
    expect(normalizeGerman('Englisch B2 von Vorteil')).toBeNull();
  });
});

describe('normalizeShift — design fixture vocabulary', () => {
  it('shift systems fire rotating', () => {
    expect(
      normalizeShift('Wechselschicht im Rahmen der Öffnungszeiten, auch Samstag'),
    ).toMatchObject({ rotating: true, weekend: true });
    expect(normalizeShift('Frühdienst ab 05:30, Samstagsarbeit')).toMatchObject({
      rotating: true,
      weekend: true,
    });
    expect(normalizeShift('Früh- und Spätdienst, Wochenenddienst im Wechsel')).toMatchObject({
      rotating: true,
      weekend: true,
    });
  });

  it('fixed weekdays assert the negative', () => {
    expect(normalizeShift('Gleitzeit zwischen 07:00 und 19:00, Mo–Fr')).toMatchObject({
      rotating: false,
      weekend: false,
    });
    expect(normalizeShift('Mo–Fr, 08:00–17:00')).toMatchObject({ rotating: false, weekend: false });
  });

  it('the j4 trap: "im Wechsel" inside weekdays is NOT Schichtdienst', () => {
    expect(normalizeShift('Servicezeiten im Wechsel bis 18:30 Uhr, Mo–Fr')).toMatchObject({
      rotating: false,
      weekend: false,
    });
  });

  it('no marker at all → null, not a guess', () => {
    expect(normalizeShift('Vertrauensarbeitszeit nach Absprache')).toBeNull();
  });
});

describe('normalizeContract', () => {
  it('unbefristet/befristet decide; "Festanstellung" alone is the j2 trap → null', () => {
    expect(normalizeContract('unbefristete Festanstellung')?.permanent).toBe(true);
    expect(normalizeContract('zunächst befristet auf 12 Monate')?.permanent).toBe(false);
    expect(normalizeContract('Festanstellung')).toBeNull();
  });
});

describe('normalizeAd — assembly and the I5 property', () => {
  const fieldSpan = (value: string) => ({ value, start: 0, end: 0, sourceKind: 'html' as const });

  it('a real Xing card becomes facts + wording, quotes verbatim', () => {
    const { facts, wording } = normalizeAd({
      title: fieldSpan('Senior Webentwickler / Programmierer (m/w/d)'),
      company: fieldSpan('Seaside Collection GmbH & Co. KG'),
      location: fieldSpan('Hamburg'),
      pay: fieldSpan('47.000 € - 69.500 €'),
      employmentType: fieldSpan('Vollzeit'),
    });
    expect(facts.pay).toBe(3917);
    expect(facts.payMax).toBe(5792);
    expect(facts.home).toBeNull(); // "Hamburg" says nothing about home office
    expect(facts.permanent).toBeNull(); // Vollzeit says nothing about duration
    expect(wording.Pay?.quote).toBe('47.000 € - 69.500 €');
    // The chip value is the monthly figure the rule evaluates, not the raw
    // annual band — showing "47.000 €" as the chip would misread as monthly.
    expect(wording.Pay?.value).toBe('≈ 3.917 € – 5.792 €/mo');
    expect(wording.Pay?.note).toContain('annual, ÷ 12');
  });

  it('freelance pill decides the contract axis', () => {
    const { facts, wording } = normalizeAd({
      employmentType: fieldSpan('Selbstständig'),
    });
    expect(facts.permanent).toBe(false);
    expect(wording.Contract?.note).toContain('freelance');
  });

  it('modality in the title is the fallback when the location is a bare city', () => {
    const { facts } = normalizeAd({
      title: fieldSpan('Senior Fullstack Entwickler 80 % Remote | Hamburg'),
      location: fieldSpan('Hamburg'),
    });
    expect(facts.home).toBe(4);
  });

  it('every wording quote is a verbatim substring of its source field (I5)', () => {
    const sources = {
      title: 'Java Entwickler 100 % remote',
      location: 'Hamburg',
      pay: '47.000 € - 69.500 €',
      workingTime: 'Gleitzeit zwischen 07:00 und 19:00, Mo–Fr',
      contract: 'unbefristete Festanstellung',
      employmentType: 'Vollzeit',
    };
    const { wording } = normalizeAd({
      title: fieldSpan(sources.title),
      location: fieldSpan(sources.location),
      pay: fieldSpan(sources.pay),
      workingTime: fieldSpan(sources.workingTime),
      contract: fieldSpan(sources.contract),
      employmentType: fieldSpan(sources.employmentType),
    });
    const emailText = Object.values(sources).join('\n');
    for (const entry of Object.values(wording)) {
      expect(verifyQuote(entry.quote, emailText)).toBe(true);
    }
  });
});

describe('end to end: real .eml → extract → normalize → evaluate', () => {
  const ruleset: Ruleset = {
    Shift: { key: 'Shift', severity: 'hard', condition: { noRotating: true, noWeekend: true } },
    German: { key: 'German', severity: 'preference', condition: { maxDemanded: 'B2' } },
    Onsite: { key: 'Onsite', severity: 'preference', condition: { minHomeDays: 2 } },
    Pay: { key: 'Pay', severity: 'hard', condition: { minMonthly: 2600, basis: 'fte' } },
    Contract: { key: 'Contract', severity: 'hard', condition: { permanentOnly: true } },
  };

  it('a Xing salary band flows from email bytes into a Pay verdict', async () => {
    const dir = new URL('./fixtures/xing', import.meta.url).pathname;
    const file = readdirSync(dir).find((f) => f.startsWith('SOMI') && f.endsWith('.eml'));
    expect(file).toBeTruthy();
    const email = await parseEml(readFileSync(join(dir, file as string)));
    const platform = classify(email.fromAddr);
    expect(platform).toBe('Xing');
    const extractor = extractorFor('Xing', layoutHash(email.bodyHtml ?? ''));
    expect(extractor).not.toBeNull();

    const ads = extractor!.extract(email).ads.map((ad) => normalizeAd(ad));

    // "Senior Fullstack Entwickler … 60.000 € - 75.000 €" → 5.000–6.250 €/month
    const first = ads[0]!;
    expect(first.facts.pay).toBe(5000);
    const verdicts = evaluate(first.facts, ruleset);
    expect(verdicts.find((v) => v.key === 'Pay')?.state).toBe('pass');
    // Shift/German were never in the email → unknown, and unknown never blocks (I4)
    expect(verdicts.find((v) => v.key === 'Shift')?.state).toBe('unknown');
    expect(isBlocked(verdicts)).toBe(false);

    // The freelance-card email is the Contract counterexample: Tchibo's
    // "Selbstständig" card must block under permanentOnly — but that card
    // lives in another fixture; here every card is an employment position.
    expect(ads.every((a) => a.facts.permanent === null)).toBe(true);
  });

  it('the Tchibo freelance card blocks on a hard permanent-only rule', async () => {
    const dir = new URL('./fixtures/xing', import.meta.url).pathname;
    const file = readdirSync(dir).find((f) => f.startsWith('Tchibo') && f.endsWith('.eml'));
    const email = await parseEml(readFileSync(join(dir, file as string)));
    const extractor = extractorFor('Xing', layoutHash(email.bodyHtml ?? ''))!;
    const ads = extractor.extract(email).ads.map((ad) => normalizeAd(ad));

    const tchibo = ads.find((a) => a.facts.permanent === false);
    expect(tchibo).toBeTruthy();
    const verdicts = evaluate(tchibo!.facts, ruleset);
    expect(verdicts.find((v) => v.key === 'Contract')?.state).toBe('block');
    expect(isBlocked(verdicts)).toBe(true);
  });
});
