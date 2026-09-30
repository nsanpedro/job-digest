/**
 * `adMarket` — which languages a derivation writes search terms in
 * (ADR-003 §8.x "Market-language direction terms"). City first, CV language
 * as fallback, English as the default.
 */
import { describe, expect, it } from 'vitest';
import { adMarket, detectCvLanguage } from '../src/market-language';

const CV_DE = `Ich bin Softwareentwickler mit acht Jahren Erfahrung in der Entwicklung von Webanwendungen.
Kenntnisse in TypeScript und React. Erfahrung mit der Leitung von Teams bei einem Startup und für
einen Konzern. Ausbildung an der Universität Hamburg, Studium der Informatik mit Schwerpunkt auf das Web.`;

const CV_ES = `Desarrollador con ocho años de experiencia en el desarrollo de aplicaciones web para empresas
del sector financiero. Conocimientos en TypeScript y React. Lideré los equipos de frontend y las
migraciones de la plataforma con un equipo de cinco personas en Buenos Aires.`;

const CV_EN = `Software engineer with eight years of experience in building web applications for the
finance industry. Skills in TypeScript and React. Led the frontend team at a startup and the
platform migration with a team of five engineers in London.`;

describe('adMarket — from the account city', () => {
  it('Hamburg → German + English', () => {
    expect(adMarket({ city: 'Hamburg' })).toEqual({ country: 'DE', languages: ['de', 'en'], source: 'city' });
  });

  it('Barcelona → Spanish + English', () => {
    expect(adMarket({ city: 'Barcelona' })).toEqual({ country: 'ES', languages: ['es', 'en'], source: 'city' });
  });

  it('Buenos Aires → Spanish + English', () => {
    expect(adMarket({ city: 'Buenos Aires' })).toEqual({ country: 'AR', languages: ['es', 'en'], source: 'city' });
  });

  it('reads the city through the location lexicon, whatever language or case it is typed in', () => {
    expect(adMarket({ city: 'münchen' }).languages).toEqual(['de', 'en']);
    expect(adMarket({ city: 'Wien' }).languages).toEqual(['de', 'en']);
    expect(adMarket({ city: 'Zürich' }).languages).toEqual(['de', 'en']);
    expect(adMarket({ city: '  Madrid ' }).languages).toEqual(['es', 'en']);
  });

  it('a placeable city in an English-posting country → English only', () => {
    expect(adMarket({ city: 'London' })).toEqual({ country: 'GB', languages: ['en'], source: 'city' });
    expect(adMarket({ city: 'Toronto' }).languages).toEqual(['en']);
  });

  it('the city wins over the CV language — a Spanish CV in Hamburg still searches German ads', () => {
    expect(adMarket({ city: 'Hamburg', cvText: CV_ES })).toEqual({ country: 'DE', languages: ['de', 'en'], source: 'city' });
  });
});

describe('adMarket — fallbacks', () => {
  it('unknown city, no CV → English', () => {
    expect(adMarket({ city: 'Springfield' })).toEqual({ country: null, languages: ['en'], source: 'default' });
  });

  it('no city at all → English', () => {
    expect(adMarket({ city: null })).toEqual({ country: null, languages: ['en'], source: 'default' });
    expect(adMarket({ city: '   ' }).languages).toEqual(['en']);
  });

  it('unknown city with an English CV → English', () => {
    expect(adMarket({ city: 'Springfield', cvText: CV_EN })).toEqual({ country: null, languages: ['en'], source: 'cv' });
  });

  it('unknown city falls back to the CV language, plus English', () => {
    expect(adMarket({ city: null, cvText: CV_ES })).toEqual({ country: null, languages: ['es', 'en'], source: 'cv' });
    expect(adMarket({ city: 'Springfield', cvText: CV_DE })).toEqual({ country: null, languages: ['de', 'en'], source: 'cv' });
  });

  it('always includes English', () => {
    for (const city of ['Hamburg', 'Barcelona', 'Buenos Aires', 'Paris', 'Amsterdam', 'Brussels', 'Springfield', null]) {
      expect(adMarket({ city }).languages).toContain('en');
    }
  });
});

describe('detectCvLanguage', () => {
  it('reads German, Spanish and English CVs', () => {
    expect(detectCvLanguage(CV_DE)).toBe('de');
    expect(detectCvLanguage(CV_ES)).toBe('es');
    expect(detectCvLanguage(CV_EN)).toBe('en');
  });

  it('returns null when the text is too short to tell', () => {
    expect(detectCvLanguage('TypeScript, React, Node.js')).toBeNull();
    expect(detectCvLanguage('')).toBeNull();
  });

  it('returns null for a CV split evenly between two languages rather than picking one', () => {
    expect(detectCvLanguage(`${CV_EN}\n${CV_ES}`)).toBeNull();
  });
});
