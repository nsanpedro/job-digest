import { describe, expect, it } from 'vitest';
import { deriveCandidateProfile, statedYears } from '../src/candidate';
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
    expect(deriveCandidateProfile({ skills: [], directions: [] })).toEqual({ seniorities: [], stack: [] });
  });
});
