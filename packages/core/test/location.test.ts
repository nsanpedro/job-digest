import { describe, expect, it } from 'vitest';
import { countriesIn, homeCountry, locationFit } from '../src/location';

const hh = { city: 'Hamburg', remoteOk: true };

describe('countriesIn', () => {
  it('reads cities and country names across English, German and Spanish', () => {
    expect(countriesIn('Köln')).toEqual(['DE']);
    expect(countriesIn('Berlín, Alemania (Híbrido)')).toEqual(['DE']);
    expect(countriesIn('Holanda Septentrional, Países Bajos')).toEqual(['NL']);
    expect(countriesIn('Karlsruhe, Frankfurt, Stuttgart')).toEqual(['DE']);
    expect(countriesIn('US-SF-HQ')).toEqual(['US']);
  });

  it('matches on word boundaries, not substrings', () => {
    // "essen" inside "Messen" and "us" inside "Campus" are not places.
    expect(countriesIn('Messen und Campus')).toEqual([]);
  });

  it('returns nothing it cannot place', () => {
    expect(countriesIn('N/A')).toEqual([]);
  });
});

describe('homeCountry', () => {
  it('places the home cities the product serves', () => {
    expect(homeCountry('hamburg')).toBe('DE');
    expect(homeCountry('Barcelona')).toBe('ES');
    expect(homeCountry('Buenos Aires')).toBe('AR');
  });
});

describe('locationFit', () => {
  it('home city is 1.0, including localised and district spellings', () => {
    expect(locationFit('Hamburg', hh)).toBe(1);
    expect(locationFit('Hamburgo', hh)).toBe(1);
    expect(locationFit('Hamburg-Altona', hh)).toBe(1);
  });

  it('same country 0.6, rest of Europe 0.3, elsewhere 0.1', () => {
    expect(locationFit('Köln', hh)).toBe(0.6);
    expect(locationFit('Zurich', hh)).toBe(0.3);
    expect(locationFit('Ámsterdam (Híbrido)', hh)).toBe(0.3);
    expect(locationFit('San Francisco, CA • New York, NY', hh)).toBe(0.1);
  });

  it('remote the user accepts is 1.0 — unless it is tied to a country far away', () => {
    expect(locationFit('Remote', hh)).toBe(1);
    expect(locationFit('Alemania (En remoto)', hh)).toBe(1);
    expect(locationFit('Remote, EMEA', hh)).toBe(1);
    expect(locationFit('Remote - Netherlands', hh)).toBe(0.6);
    expect(locationFit('Remote in the US', hh)).toBe(0.1);
  });

  it('remote for a user who does not want remote is placed by its country, else 0.3', () => {
    const office = { city: 'Hamburg', remoteOk: false };
    expect(locationFit('Remote', office)).toBe(0.3);
    expect(locationFit('Deutschland (Remote)', office)).toBe(0.6);
  });

  it('null when there is nothing to compare — no signal, not a penalty', () => {
    expect(locationFit(null, hh)).toBeNull();
    expect(locationFit('N/A', hh)).toBeNull();
    expect(locationFit('Hamburg', { city: null, remoteOk: true })).toBeNull();
  });

  it('a home city the lexicon cannot place only credits the city itself and open remote', () => {
    const unknown = { city: 'Kleinstadt', remoteOk: true };
    expect(locationFit('Kleinstadt', unknown)).toBe(1);
    expect(locationFit('Remote', unknown)).toBe(1);
    expect(locationFit('Köln', unknown)).toBeNull();
  });
});
