/**
 * `parseDerivation` — the gates from docs/adr-001-role-discovery.md §3, one
 * case per gate. Model output is simulated as plain objects; nothing here
 * touches the network (that's derive-directions.ts in @job-digest/worker).
 */
import { describe, expect, it } from 'vitest';
import { MAX_DIRECTIONS, MIN_BRIDGE_SKILLS, parseDerivation } from '../src/discovery';

const CV = `Jane Doe. Five years of audit preparation and quality documentation in a
hospital laboratory. Fluent in German and English. Managed a team of three
lab technicians. Certified in ISO 9001 internal auditing.`;

const KNOWN_TITLES = ['Qualitätsbeauftragte (m/w/d)', 'Fachkraft für Arbeitssicherheit'];

function skill(text: string, quote: string) {
  return { text, quote };
}

function direction(over: Partial<Record<string, unknown>> = {}) {
  return {
    label: 'Qualitätsmanagement',
    bridge: ['audit prep', 'ISO 9001'],
    rationale: 'Your audit and documentation background maps directly onto QM.',
    searchTerms: ['Qualitätsmanagement Gesundheitswesen'],
    distance: 'adjacent',
    seenTitles: [],
    ...over,
  };
}

describe('skills — I17, gate 1', () => {
  it('keeps a skill whose quote is a verbatim span of the CV', () => {
    const raw = { skills: [skill('audit prep', 'audit preparation')], directions: [] };
    const result = parseDerivation(raw, CV, KNOWN_TITLES);
    expect(result.skills).toEqual([{ text: 'audit prep', quote: 'audit preparation' }]);
  });

  it('drops a skill whose quote does not appear in the CV, and records why', () => {
    const raw = { skills: [skill('Python expert', 'ten years of Python')], directions: [] };
    const result = parseDerivation(raw, CV, KNOWN_TITLES);
    expect(result.skills).toEqual([]);
    expect(result.dropped).toContainEqual(
      expect.objectContaining({ kind: 'skill', label: 'Python expert' }),
    );
  });

  it('tolerates whitespace differences the way verifyQuote already does', () => {
    const raw = { skills: [skill('team lead', 'Managed  a team \n of three')] };
    const result = parseDerivation(raw, CV, KNOWN_TITLES);
    expect(result.skills).toHaveLength(1);
  });

  it('drops a malformed skill entry without throwing', () => {
    const raw = { skills: [{ text: 'no quote field' }, 'not even an object'], directions: [] };
    const result = parseDerivation(raw, CV, KNOWN_TITLES);
    expect(result.skills).toEqual([]);
    expect(result.dropped.length).toBe(2);
  });
});

describe('directions — I17, gate 2 (bridge needs >= MIN_BRIDGE_SKILLS survivors)', () => {
  it('keeps a direction with exactly the minimum number of verified bridges', () => {
    const raw = {
      skills: [skill('audit prep', 'audit preparation'), skill('ISO 9001', 'ISO 9001 internal auditing')],
      directions: [direction({ bridge: ['audit prep', 'ISO 9001'] })],
    };
    const result = parseDerivation(raw, CV, KNOWN_TITLES);
    expect(result.directions).toHaveLength(1);
    expect(result.directions[0]!.bridge).toEqual(['audit prep', 'ISO 9001']);
  });

  it('drops a direction whose bridge references a skill that was itself dropped', () => {
    const raw = {
      skills: [skill('audit prep', 'audit preparation'), skill('fabricated', 'not in the CV at all')],
      directions: [direction({ bridge: ['audit prep', 'fabricated'] })],
    };
    const result = parseDerivation(raw, CV, KNOWN_TITLES);
    // Only one of the two bridge entries survives (the other skill was
    // dropped for an unverifiable quote), which is below MIN_BRIDGE_SKILLS.
    expect(result.directions).toEqual([]);
    expect(result.dropped).toContainEqual(
      expect.objectContaining({ kind: 'direction', reason: expect.stringContaining('bridging skills') }),
    );
  });

  it('drops a direction with only one bridging skill even if both are verified', () => {
    const raw = {
      skills: [skill('audit prep', 'audit preparation')],
      directions: [direction({ bridge: ['audit prep'] })],
    };
    const result = parseDerivation(raw, CV, KNOWN_TITLES);
    expect(result.directions).toEqual([]);
  });

  it(`MIN_BRIDGE_SKILLS is ${MIN_BRIDGE_SKILLS} — the constant, not a hardcoded number, drives the gate`, () => {
    expect(MIN_BRIDGE_SKILLS).toBe(2);
  });
});

describe('seenTitles — I18 enforcement point', () => {
  it('keeps a seenTitle that matches one of the titles actually passed in', () => {
    const raw = {
      skills: [skill('audit prep', 'audit preparation'), skill('ISO 9001', 'ISO 9001 internal auditing')],
      directions: [direction({ seenTitles: ['Qualitätsbeauftragte (m/w/d)'] })],
    };
    const result = parseDerivation(raw, CV, KNOWN_TITLES);
    expect(result.directions[0]!.seenTitles).toEqual(['Qualitätsbeauftragte (m/w/d)']);
  });

  it('drops a hallucinated seenTitle without dropping the whole direction', () => {
    const raw = {
      skills: [skill('audit prep', 'audit preparation'), skill('ISO 9001', 'ISO 9001 internal auditing')],
      directions: [direction({ seenTitles: ['A title that was never in the inbox'] })],
    };
    const result = parseDerivation(raw, CV, KNOWN_TITLES);
    expect(result.directions).toHaveLength(1);
    expect(result.directions[0]!.seenTitles).toEqual([]);
  });
});

describe('direction cap — at most MAX_DIRECTIONS, zero is valid', () => {
  it(`truncates to ${MAX_DIRECTIONS} and records the rest as dropped`, () => {
    const skills = [skill('audit prep', 'audit preparation'), skill('ISO 9001', 'ISO 9001 internal auditing')];
    const bridge = ['audit prep', 'ISO 9001'];
    const raw = {
      skills,
      directions: [
        direction({ label: 'A', bridge }),
        direction({ label: 'B', bridge }),
        direction({ label: 'C', bridge }),
        direction({ label: 'D', bridge }),
      ],
    };
    const result = parseDerivation(raw, CV, KNOWN_TITLES);
    expect(result.directions).toHaveLength(MAX_DIRECTIONS);
    expect(result.directions.map((d) => d.label)).toEqual(['A', 'B', 'C']);
    expect(result.dropped).toContainEqual(expect.objectContaining({ label: 'D' }));
  });

  it('zero directions is a valid result, not an error', () => {
    const result = parseDerivation({ skills: [], directions: [] }, CV, KNOWN_TITLES);
    expect(result).toMatchObject({ skills: [], directions: [], dropped: [] });
  });
});

describe('malformed top-level response', () => {
  it('never throws on a non-object response', () => {
    expect(() => parseDerivation(null, CV, KNOWN_TITLES)).not.toThrow();
    expect(() => parseDerivation('a string', CV, KNOWN_TITLES)).not.toThrow();
    expect(() => parseDerivation(42, CV, KNOWN_TITLES)).not.toThrow();
  });

  it('degrades to empty rather than throwing when skills/directions are missing entirely', () => {
    const result = parseDerivation({}, CV, KNOWN_TITLES);
    expect(result.skills).toEqual([]);
    expect(result.directions).toEqual([]);
  });

  it('rejects a distance value outside the closed union rather than defaulting it', () => {
    const raw = {
      skills: [skill('audit prep', 'audit preparation'), skill('ISO 9001', 'ISO 9001 internal auditing')],
      directions: [direction({ distance: 'very close' })],
    };
    const result = parseDerivation(raw, CV, KNOWN_TITLES);
    expect(result.directions).toEqual([]);
  });

  it('rejects a direction with empty searchTerms — nothing actionable to offer', () => {
    const raw = {
      skills: [skill('audit prep', 'audit preparation'), skill('ISO 9001', 'ISO 9001 internal auditing')],
      directions: [direction({ searchTerms: [] })],
    };
    const result = parseDerivation(raw, CV, KNOWN_TITLES);
    expect(result.directions).toEqual([]);
  });
});
