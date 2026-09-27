/**
 * `readSeniority` — the entry-level end of the ladder (ADR-003 §8.7). Real
 * titles from the ranking eval plus the wording the junior row was extended
 * to cover, and the look-alikes it must not catch.
 */
import { describe, expect, it } from 'vitest';
import { readSeniority } from '../src/title-lexicon';

describe('readSeniority — junior', () => {
  it.each([
    // Dismissed by a lead/senior user in the eval.
    'Junior Software Engineer (m/w/d)',
    'Werkstudent Softwareentwicklung (m/w/d) – Greenfield / KI Fokus, InsurTech',
    'Intern - Front-End Developer (all gender) (Fleet Energy Performance)',
    '(Junior) Software Entwickler:in (m/w/d) | Java / Python / Apex',
    'Junior Frontend Developer / Softwareentwickler:in',
    // English
    'Software Engineering Internship 2027',
    'Frontend Interns (all genders)',
    'Trainee Softwareentwicklung (m/w/d)',
    'IT Trainees – Graduate Programme',
    'Working Student Frontend Development (f/m/d)',
    'Entry Level Web Developer',
    'Entry-level QA Engineer',
    // German
    'Werkstudentin Frontend (m/w/d)',
    'Werkstudierende:r Webentwicklung',
    'Praktikum Softwareentwicklung (m/w/d)',
    'Pflichtpraktikum Frontend Development',
    'Praktikant:in UX Engineering',
    'Praktikantin Webentwicklung',
    'Azubi Fachinformatiker Anwendungsentwicklung',
    'Ausbildung zum Fachinformatiker (m/w/d)',
    'Auszubildender Anwendungsentwicklung',
    // Spanish
    'Becario/a Desarrollo Frontend',
    'Becaria de desarrollo web',
    'Pasante de Desarrollo de Software',
    'Pasantía en Ingeniería de Software',
    'Prácticas Desarrollador Frontend',
    'Practicas en desarrollo web (Barcelona)',
  ])('%s → junior', (title) => {
    expect(readSeniority(title)).toBe('junior');
  });
});

describe('readSeniority — look-alikes that are not entry-level', () => {
  it.each([
    'Internal Tools Engineer',
    'Senior Engineer, Internal Platform',
    'International Frontend Developer (m/w/d)',
    'Internet Software Developer',
    'Frontend Developer – Internationalization (i18n)',
    'Softwareentwickler für interne Systeme (m/w/d)',
    'Technical Trainer Frontend',
    'Ausbildungsbeauftragter IT',
    'DevOps Praktiker (m/w/d)',
    'Frontend Developer (m/w/d) React',
    'Engineering Manager (m/w/d)',
  ])('%s → not junior', (title) => {
    expect(readSeniority(title)).not.toBe('junior');
  });

  it('a senior marker still outranks an entry-level word in the same title', () => {
    // "Senior … mentoring our interns": the rung advertised is the senior one.
    expect(readSeniority('Senior Frontend Engineer – mentoring interns')).toBe('senior');
    expect(readSeniority('Head of Ausbildung IT')).toBe('head');
  });

  it('the rungs above junior read as before', () => {
    expect(readSeniority('Senior Frontend Engineer')).toBe('senior');
    expect(readSeniority('Staff Engineer - Virtual Assembly Line (m/f/d)')).toBe('lead');
    expect(readSeniority('Head of Frontend Development (iGaming)')).toBe('head');
    expect(readSeniority('Team Lead Software Entwicklung')).toBe('lead');
  });
});
