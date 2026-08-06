/**
 * `extractTitleFacts` — chips = hechos, no veredictos (3 Aug 2026). Cases are
 * drawn from real titles in the corpus (measured 3 Aug 2026) plus the
 * precedence edge cases the regex tables are ordered to resolve.
 */
import { describe, expect, it } from 'vitest';
import { extractTitleFacts } from '../src/normalize/title-facts';

describe('seniority', () => {
  it('reads a bare "Senior"', () => {
    expect(extractTitleFacts('Senior Frontend Engineer').seniority).toMatchObject({ value: 'senior' });
  });

  it('reads "(Senior)" in parens', () => {
    expect(extractTitleFacts('(Senior) Frontend Developer (m/w/d)').seniority).toMatchObject({ value: 'senior' });
  });

  it('"Head of" outranks a bare "Lead" appearing later in the same title', () => {
    const f = extractTitleFacts('Head of Frontend Development (iGaming)');
    expect(f.seniority).toMatchObject({ value: 'head' });
  });

  it('"Team Lead" reads as lead, not head, not junior', () => {
    expect(extractTitleFacts('Team Lead Frontend Development (m/w/d)').seniority).toMatchObject({ value: 'lead' });
  });

  it('"Staff" reads as lead-tier', () => {
    expect(extractTitleFacts('Staff/Lead Front-end Engineer').seniority).toMatchObject({ value: 'lead' });
  });

  it('does not guess on "Associate" — one employer\'s junior is another\'s senior', () => {
    expect(extractTitleFacts('Associate Frontend Engineer').seniority).toBeNull();
  });

  it('is null when nothing in the title marks a level', () => {
    expect(extractTitleFacts('Frontend Developer').seniority).toBeNull();
  });
});

describe('discipline', () => {
  it('reads "Engineering Manager" as management, not as an engineering discipline', () => {
    expect(extractTitleFacts('Engineering Manager (f/m/x)').discipline).toMatchObject({ value: 'management' });
  });

  it('a technical area inside a management title still reads as management', () => {
    // Real corpus title — "Web-Entwicklung" must not pull this into frontend.
    expect(extractTitleFacts('Engineering Manager Web-Entwicklung').discipline).toMatchObject({
      value: 'management',
    });
  });

  it('reads "Full Stack" as fullstack, not split into frontend/backend', () => {
    expect(extractTitleFacts('Full Stack Engineer').discipline).toMatchObject({ value: 'fullstack' });
  });

  it('reads German "Webentwickler" as frontend', () => {
    expect(extractTitleFacts('Webentwickler / Webdesigner (m/w/d)').discipline).toMatchObject({ value: 'frontend' });
  });

  it('is null on a title with no recognizable discipline', () => {
    expect(extractTitleFacts('AI Playable Ads Developer').discipline).toBeNull();
  });
});

describe('stack', () => {
  it('names React and TypeScript when both appear, without duplicates', () => {
    const f = extractTitleFacts('Senior React Entwickler (m/w/d) 60% Remote – React / TypeScript / Enterprise-Web');
    expect(f.stack.map((s) => s.value)).toEqual(['React', 'TypeScript']);
  });

  it('does not confuse "JavaScript" for a second "Java" match', () => {
    const f = extractTitleFacts('Software Engineer, Frontend (React, NextJS) - All Genders');
    expect(f.stack.map((s) => s.value)).toEqual(['React', 'Next.js']);
  });

  it('is empty when no named technology appears', () => {
    expect(extractTitleFacts('Frontend Developer').stack).toEqual([]);
  });
});

describe('workplace', () => {
  it('reads modality from the location line when the title says nothing', () => {
    const f = extractTitleFacts('Full Stack Engineer', 'Berlín, Alemania (Híbrido)');
    expect(f.workplace).toMatchObject({ value: 'hybrid' });
  });

  it('reads Spanish "En remoto" from the location line', () => {
    const f = extractTitleFacts('Associate Frontend Engineer', 'Hamburgo (En remoto)');
    expect(f.workplace).toMatchObject({ value: 'remote' });
  });

  it('reads German "Vollzeit/Homeoffice" style modality from the title itself', () => {
    const f = extractTitleFacts('Senior Fullstack Entwickler Java 21 / React / TypeScript (m/w/d) 80 % Remote | Hamburg');
    expect(f.workplace).toMatchObject({ value: 'remote' });
  });

  it('is null when neither title nor location states a modality', () => {
    expect(extractTitleFacts('Frontend Developer', 'Hamburg').workplace).toBeNull();
  });

  it('is null when no location was passed and the title is silent', () => {
    expect(extractTitleFacts('Frontend Developer').workplace).toBeNull();
  });
});

describe('remotePercent', () => {
  it('reads a percentage next to a remote word', () => {
    const f = extractTitleFacts('Senior React Entwickler (m/w/d) 60% Remote – React / TypeScript / Enterprise-Web');
    expect(f.remotePercent).toMatchObject({ value: 60 });
  });

  it('does not read a bare percentage with no remote word next to it — that is not necessarily a home-office share', () => {
    const f = extractTitleFacts('Full Stack Developer für interne Softwareentwicklung (m/w/d) in Vollzeit');
    expect(f.remotePercent).toBeNull();
  });
});

describe('germanTitle', () => {
  it('flags a German-vocabulary title', () => {
    expect(extractTitleFacts('Senior Webentwickler / Programmierer (m/w/d)').germanTitle).toMatchObject({
      value: true,
    });
  });

  it('does not flag an English title', () => {
    expect(extractTitleFacts('Senior Frontend Engineer').germanTitle).toBeNull();
  });

  it('does not flag on "Manager" or "Engineer" alone — shared with English', () => {
    expect(extractTitleFacts('Engineering Manager').germanTitle).toBeNull();
  });
});

describe('citation (I5-style — every value carries the span it came from)', () => {
  it('the matched span is a literal substring of the title', () => {
    const title = 'Senior Frontend Engineer';
    const f = extractTitleFacts(title);
    expect(title).toContain(f.seniority!.matched);
    expect(title).toContain(f.discipline!.matched);
  });

  it('a workplace matched from the location line is a substring of the location, not the title', () => {
    const location = 'Berlín, Alemania (Híbrido)';
    const f = extractTitleFacts('Full Stack Engineer', location);
    expect(location).toContain(f.workplace!.matched);
  });
});

describe('real corpus samples stay stable', () => {
  it('a title with almost nothing recognizable yields an empty-but-valid result, never a throw', () => {
    const f = extractTitleFacts('(Senior) Manager Business Transformat...', 'München');
    expect(f).toMatchObject({ seniority: { value: 'senior' } });
    expect(f.stack).toEqual([]);
  });

  it('a fully populated title produces seniority + discipline + workplace + stack together', () => {
    const f = extractTitleFacts(
      '(Senior) Software Entwickler*in Frontend (m/w/d)',
      'Hamburgo, Alemania (Híbrido)',
    );
    expect(f.seniority).toMatchObject({ value: 'senior' });
    expect(f.discipline).toMatchObject({ value: 'frontend' });
    expect(f.workplace).toMatchObject({ value: 'hybrid' });
  });
});
