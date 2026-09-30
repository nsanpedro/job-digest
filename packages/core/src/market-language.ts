/**
 * Which languages job ads in the user's market are written in — the input
 * role discovery (`deriveDirections`) receives so its search terms are the
 * words ads in that market actually use (ADR-003 §8.x "Market-language
 * direction terms").
 *
 * Before this, the derivation prompt asked for German search terms for every
 * account. Two of the three production accounts are in Buenos Aires and
 * Barcelona, where ads are posted in Spanish and English; German terms there
 * matched only through the cross-language ROLE_SYNONYMS families in
 * matching.ts, which cover a handful of role words and nothing else.
 *
 * Computed here, not guessed by the model: the city goes through the same
 * closed country lexicon `locationFit` uses (`homeCountry`), and the country
 * maps to languages through the closed table below. The CV's language is a
 * fallback for a city the lexicon cannot place — never an override, because
 * a Spanish CV in Hamburg still has to find German and English ads.
 *
 * Pure. No I/O.
 */
import { homeCountry } from './location';

/** ISO 639-1 codes of the languages the table below can name. */
export type AdLanguage = 'de' | 'en' | 'es' | 'fr' | 'it' | 'nl' | 'pt' | 'pl' | 'cs' | 'da' | 'sv';

export const AD_LANGUAGE_NAME: Readonly<Record<AdLanguage, string>> = {
  de: 'German',
  en: 'English',
  es: 'Spanish',
  fr: 'French',
  it: 'Italian',
  nl: 'Dutch',
  pt: 'Portuguese',
  pl: 'Polish',
  cs: 'Czech',
  da: 'Danish',
  sv: 'Swedish',
};

/**
 * Ad languages by country, local language first. English is listed for
 * every non-English market because tech and management ads there are posted
 * in English as often as in the local language (DACH titles mix "Engineer"
 * and "Entwickler"; AR/ES ads mix "Developer" and "Desarrollador" — the
 * same observation behind ROLE_SYNONYMS). Countries the lexicon knows but
 * this table does not list (US, GB, IE, CA, AU, IN, SG, …) post in English
 * and fall through to the default. Switzerland is listed as German-speaking:
 * the cities the lexicon places there are mostly in the German-speaking part,
 * and English covers the rest well enough for a search term.
 */
const COUNTRY_AD_LANGUAGES: Readonly<Record<string, readonly AdLanguage[]>> = {
  DE: ['de', 'en'],
  AT: ['de', 'en'],
  CH: ['de', 'en'],
  ES: ['es', 'en'],
  AR: ['es', 'en'],
  MX: ['es', 'en'],
  CO: ['es', 'en'],
  PE: ['es', 'en'],
  CL: ['es', 'en'],
  FR: ['fr', 'en'],
  BE: ['fr', 'nl', 'en'],
  IT: ['it', 'en'],
  NL: ['nl', 'en'],
  PT: ['pt', 'en'],
  BR: ['pt', 'en'],
  PL: ['pl', 'en'],
  CZ: ['cs', 'en'],
  DK: ['da', 'en'],
  SE: ['sv', 'en'],
};

const DEFAULT_LANGUAGES: readonly AdLanguage[] = ['en'];

export type AdMarketSource = 'city' | 'cv' | 'default';

export interface AdMarket {
  /** ISO country code the city resolved to, or null when the lexicon could not place it. */
  country: string | null;
  /** Languages to write search terms in, most-used first. Never empty; always includes English. */
  languages: readonly AdLanguage[];
  /** What decided `languages` — shown in the prompt so the model knows how firm it is. */
  source: AdMarketSource;
}

/**
 * Function words that identify the CV's language. Only the three languages
 * the product's CVs arrive in; anything else reads as "unknown" and falls
 * back to English. Words that are the same across the three ("de" is
 * Spanish and a German-English-neutral token in names) are left out.
 */
const CV_LANGUAGE_MARKERS: ReadonlyArray<readonly [AdLanguage, ReadonlySet<string>]> = [
  ['de', new Set(['und', 'mit', 'für', 'der', 'die', 'das', 'bei', 'von', 'ich', 'jahre', 'erfahrung', 'kenntnisse'])],
  ['es', new Set(['y', 'con', 'para', 'del', 'los', 'las', 'en', 'el', 'la', 'años', 'experiencia', 'conocimientos'])],
  ['en', new Set(['and', 'with', 'for', 'the', 'of', 'in', 'years', 'experience', 'skills', 'at'])],
];

/** Fewer marker hits than this and the text is too short or too list-like to call. */
const CV_LANGUAGE_MIN_HITS = 5;

/**
 * The language a CV is written in, by function-word counts — or null when
 * the text is too short to tell or no language clearly leads (the winner
 * needs 1.5× the runner-up, so a bilingual CV reads as unknown rather than
 * being forced into one of its languages).
 */
export function detectCvLanguage(text: string): 'de' | 'es' | 'en' | null {
  const words = text.toLowerCase().split(/[^\p{L}]+/u).filter(Boolean);
  const counts = CV_LANGUAGE_MARKERS.map(([lang, markers]) => ({
    lang,
    hits: words.reduce((n, w) => n + (markers.has(w) ? 1 : 0), 0),
  })).sort((a, b) => b.hits - a.hits);
  const [first, second] = counts;
  if (!first || first.hits < CV_LANGUAGE_MIN_HITS) return null;
  if (second && first.hits < second.hits * 1.5) return null;
  return first.lang as 'de' | 'es' | 'en';
}

/**
 * The market a derivation writes search terms for.
 *
 *   1. The account's city, when the location lexicon places it: the
 *      country's ad languages (Hamburg → de+en, Barcelona / Buenos Aires →
 *      es+en). A country outside the table posts in English.
 *   2. Otherwise the CV's language, plus English (a Spanish CV with no
 *      placeable city → es+en).
 *   3. Otherwise English alone.
 */
export function adMarket(input: { city: string | null | undefined; cvText?: string | null }): AdMarket {
  const city = input.city?.trim();
  const country = city ? homeCountry(city) : null;
  if (country) {
    return { country, languages: COUNTRY_AD_LANGUAGES[country] ?? DEFAULT_LANGUAGES, source: 'city' };
  }
  const cvLang = input.cvText ? detectCvLanguage(input.cvText) : null;
  if (cvLang && cvLang !== 'en') {
    return { country: null, languages: [cvLang, 'en'], source: 'cv' };
  }
  if (cvLang === 'en') return { country: null, languages: DEFAULT_LANGUAGES, source: 'cv' };
  return { country: null, languages: DEFAULT_LANGUAGES, source: 'default' };
}
