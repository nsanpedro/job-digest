import { describe, expect, it } from 'vitest';
import { deriveCandidateProfile, isBelowTargetLevel, statedYears, targetsSeniorOnly } from '../src/candidate';
import type { Skill } from '../src/discovery';

const skill = (text: string, quote = text): Skill => ({ text, quote });

describe('statedYears', () => {
  it('reads the largest "N years" figure across English, Spanish and German', () => {
    expect(statedYears([skill('3 years of React'), skill('8 años liderando equipos')])).toBe(8);
    expect(statedYears([skill('Frontend', '6 Jahren Erfahrung mit Vue')])).toBe(6);
    expect(statedYears([skill('5+ years TypeScript')])).toBe(5);
  });

  it('null when no skill states a duration', () => {
    expect(statedYears([skill('Figma'), skill('Design systems')])).toBeNull();
  });
});

describe('deriveCandidateProfile', () => {
  it('reads target rungs from direction labels and search terms', () => {
    const p = deriveCandidateProfile({
      skills: [],
      directions: [
        { label: 'Senior Frontend Engineer', searchTerms: ['Frontend Entwickler'] },
        { label: 'Tech Lead Web', searchTerms: ['Lead Frontend'] },
      ],
    });
    expect([...p.seniorities].sort()).toEqual(['lead', 'senior']);
  });

  it('directions win over stated years — what the user aims at, not what they did', () => {
    const p = deriveCandidateProfile({
      skills: [skill('10 years of Java')],
      directions: [{ label: 'Lead Engineer', searchTerms: [] }],
    });
    expect(p.seniorities).toEqual(['lead']);
  });

  it('falls back to stated years only at the two ends of the ladder', () => {
    const at = (years: number) =>
      deriveCandidateProfile({
        skills: [skill(`${years} years of React`)],
        directions: [{ label: 'Frontend Engineer', searchTerms: ['Frontend Entwickler'] }],
      }).seniorities;
    expect(at(7)).toEqual(['senior']);
    expect(at(1)).toEqual(['junior']);
    // The unlabelled middle stays silent rather than guessing a rung.
    expect(at(3)).toEqual([]);
  });

  it('reads the stack from skills and directions through the title lexicon', () => {
    const p = deriveCandidateProfile({
      skills: [skill('React + TypeScript apps', '4 years building React and TypeScript apps')],
      directions: [{ label: 'Frontend Engineer', searchTerms: ['Vue.js Entwickler'] }],
    });
    expect([...p.stack].sort()).toEqual(['React', 'TypeScript', 'Vue']);
  });

  it('an empty profile yields no signal at all', () => {
    expect(deriveCandidateProfile({ skills: [], directions: [] })).toEqual({
      seniorities: [],
      stack: [],
      location: { city: null, remoteOk: false },
    });
  });
});

describe('isBelowTargetLevel (ADR-003 §8.7)', () => {
  // The real account from the ranking eval: directions name lead + senior.
  const leadSenior = deriveCandidateProfile({
    skills: [],
    directions: [
      { label: 'Team Lead Frontend', searchTerms: ['Team Lead Software Entwicklung'] },
      { label: 'Senior Frontend Engineer', searchTerms: ['Senior Frontend Engineer'] },
    ],
  });

  it('the eval account targets lead + senior', () => {
    expect([...leadSenior.seniorities].sort()).toEqual(['lead', 'senior']);
    expect(targetsSeniorOnly(leadSenior)).toBe(true);
  });

  it.each([
    'Junior Software Engineer (m/w/d)',
    'Werkstudent Softwareentwicklung (m/w/d) – Greenfield / KI Fokus, InsurTech',
    'Intern - Front-End Developer (all gender) (Fleet Energy Performance)',
    '(Junior) Software Entwickler:in (m/w/d) | Java / Python / Apex',
    'Junior Frontend Developer / Softwareentwickler:in',
  ])('gates the entry-level ads the user dismissed: %s', (title) => {
    expect(isBelowTargetLevel(title, leadSenior)).toBe(true);
  });

  it.each([
    'Senior Frontend Engineer',
    'Engineering Manager (m/w/d)',
    'Frontend Developer (m/w/d) React',
    'Staff Engineer - Virtual Assembly Line (m/f/d)',
    'Head of Frontend Development (iGaming)',
  ])('keeps passing for the same user: %s', (title) => {
    expect(isBelowTargetLevel(title, leadSenior)).toBe(false);
  });

  it('a title that states no rung is never gated — no "Senior" is not "Junior"', () => {
    expect(isBelowTargetLevel('Frontend Developer (m/w/d) React', { seniorities: ['head'] })).toBe(false);
  });

  it('off when the user targets junior, alone or next to a senior rung', () => {
    expect(isBelowTargetLevel('Junior Software Engineer', { seniorities: ['junior'] })).toBe(false);
    expect(isBelowTargetLevel('Junior Software Engineer', { seniorities: ['junior', 'senior'] })).toBe(false);
    expect(targetsSeniorOnly({ seniorities: ['junior', 'senior'] })).toBe(false);
  });

  it('off when the user targets nothing — no signal is not a preference', () => {
    expect(isBelowTargetLevel('Junior Software Engineer', { seniorities: [] })).toBe(false);
    expect(targetsSeniorOnly({ seniorities: [] })).toBe(false);
  });

  it('a CV-derived senior target (≥ 5 stated years) turns it on too', () => {
    const fromYears = deriveCandidateProfile({
      skills: [{ text: '8 years of React', quote: '8 years of React' }],
      directions: [{ label: 'Frontend Engineer', searchTerms: ['Frontend Entwickler'] }],
    });
    expect(isBelowTargetLevel('Praktikum Frontend (m/w/d)', fromYears)).toBe(true);
  });

  it('a user whose own direction is entry-level reads as a junior target, so the gate stays off', () => {
    const student = deriveCandidateProfile({
      skills: [],
      directions: [{ label: 'Werkstudent Frontend', searchTerms: ['Working Student Frontend'] }],
    });
    expect(student.seniorities).toEqual(['junior']);
    expect(isBelowTargetLevel('Werkstudent Softwareentwicklung (m/w/d)', student)).toBe(false);
  });
});
