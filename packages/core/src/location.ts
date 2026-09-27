/**
 * Location as a ranking signal, not a gate (ADR-003 §8.6).
 *
 * The digest used to drop every ad whose location string didn't contain the
 * user's city (or a hard-coded alias of its country) into Explore. The first
 * real-account eval showed that gate hiding 6 of the 9 ads the user had
 * applied to — Köln, Zurich, Amsterdam, San Francisco — and was inconsistent
 * on its own terms: "Berlin, Germany" passed a Hamburg user because the
 * string said "Germany", "Köln" didn't because it didn't.
 *
 * `locationFit` grades instead of filtering:
 *
 *   1.0 — the user's city, or remote the user can take (remote accepted, and
 *         not tied to a country outside the user's own / Europe)
 *   0.6 — elsewhere in the user's country (or remote tied to another
 *         European country)
 *   0.3 — elsewhere in Europe
 *   0.1 — outside Europe
 *   null — no location we can place, or no home city to compare against:
 *          no signal, weight handed back like every other silent component
 *
 * Countries are recognised from a closed lexicon — country names in English,
 * German and Spanish (LinkedIn localises them), and the larger cities of the
 * markets the product serves. A string that names nothing in the lexicon
 * stays null rather than being guessed at; extending coverage means adding
 * a name here, not loosening a rule.
 *
 * Pure. No value imports beyond this file.
 */

export type Region = 'europe' | 'americas' | 'apac' | 'mea';

interface Country {
  region: Region;
  /** Lowercased names and cities, matched on word boundaries. */
  names: readonly string[];
}

const COUNTRIES: Readonly<Record<string, Country>> = {
  DE: {
    region: 'europe',
    names: [
      'germany', 'deutschland', 'alemania', 'berlin', 'berlín', 'hamburg', 'hamburgo', 'münchen', 'munich',
      'múnich', 'munchen', 'köln', 'koln', 'cologne', 'colonia', 'frankfurt', 'stuttgart', 'düsseldorf',
      'dusseldorf', 'leipzig', 'dresden', 'hannover', 'hanover', 'nürnberg', 'nuremberg', 'bremen', 'essen',
      'dortmund', 'duisburg', 'bonn', 'karlsruhe', 'mannheim', 'münster', 'augsburg', 'wiesbaden', 'kiel',
      'lübeck', 'potsdam', 'heidelberg', 'freiburg', 'ulm', 'mainz', 'aachen', 'bielefeld', 'braunschweig',
      'magdeburg', 'norderstedt', 'rostock', 'regensburg', 'ingolstadt', 'darmstadt', 'erlangen',
    ],
  },
  AT: { region: 'europe', names: ['austria', 'österreich', 'osterreich', 'wien', 'vienna', 'viena', 'graz', 'linz', 'salzburg', 'innsbruck'] },
  CH: {
    region: 'europe',
    names: ['switzerland', 'schweiz', 'suiza', 'zurich', 'zürich', 'basel', 'bern', 'berne', 'geneva', 'genf', 'ginebra', 'lausanne', 'zug', 'lucerne', 'luzern'],
  },
  NL: {
    region: 'europe',
    names: ['netherlands', 'niederlande', 'holanda', 'países bajos', 'paises bajos', 'amsterdam', 'ámsterdam', 'rotterdam', 'utrecht', 'eindhoven', 'the hague', 'den haag', 'noord-holland', 'holanda septentrional'],
  },
  ES: {
    region: 'europe',
    names: ['spain', 'españa', 'espana', 'spanien', 'madrid', 'barcelona', 'valencia', 'sevilla', 'seville', 'bilbao', 'málaga', 'malaga', 'zaragoza'],
  },
  FR: { region: 'europe', names: ['france', 'frankreich', 'francia', 'paris', 'parís', 'lyon', 'marseille', 'toulouse'] },
  IT: { region: 'europe', names: ['italy', 'italien', 'italia', 'milan', 'milano', 'rome', 'roma'] },
  PT: { region: 'europe', names: ['portugal', 'lisbon', 'lisboa', 'porto'] },
  IE: { region: 'europe', names: ['ireland', 'irland', 'irlanda', 'dublin'] },
  GB: {
    region: 'europe',
    names: ['united kingdom', 'uk', 'england', 'scotland', 'reino unido', 'großbritannien', 'london', 'londres', 'manchester', 'edinburgh', 'derby'],
  },
  PL: { region: 'europe', names: ['poland', 'polen', 'polonia', 'warsaw', 'warszawa', 'kraków', 'krakow', 'wrocław', 'wroclaw'] },
  CZ: { region: 'europe', names: ['czech republic', 'czechia', 'tschechien', 'prague', 'praha', 'prag'] },
  DK: { region: 'europe', names: ['denmark', 'dänemark', 'dinamarca', 'copenhagen', 'kopenhagen'] },
  SE: { region: 'europe', names: ['sweden', 'schweden', 'suecia', 'stockholm', 'estocolmo'] },
  BE: { region: 'europe', names: ['belgium', 'belgien', 'bélgica', 'brussels', 'brüssel', 'bruselas'] },
  US: {
    region: 'americas',
    names: [
      'united states', 'usa', 'us', 'estados unidos', 'san francisco', 'new york', 'nyc', 'seattle', 'chicago',
      'boston', 'austin', 'los angeles', 'atlanta', 'denver', 'texas', 'california', 'washington', 'miami',
      'us-remote', 'sf', 'sea', 'chi', 'az',
    ],
  },
  CA: { region: 'americas', names: ['canada', 'kanada', 'toronto', 'vancouver', 'montreal', 'calgary', 'ontario', 'alberta', 'mississauga'] },
  MX: { region: 'americas', names: ['mexico', 'méxico', 'mexiko', 'ciudad de méxico', 'guadalajara'] },
  AR: { region: 'americas', names: ['argentina', 'buenos aires', 'córdoba', 'cordoba', 'rosario', 'mendoza'] },
  BR: { region: 'americas', names: ['brazil', 'brasil', 'são paulo', 'sao paulo', 'rio de janeiro'] },
  CO: { region: 'americas', names: ['colombia', 'bogotá', 'bogota', 'medellín', 'medellin'] },
  PE: { region: 'americas', names: ['peru', 'perú', 'lima'] },
  CL: { region: 'americas', names: ['chile', 'santiago'] },
  IN: { region: 'apac', names: ['india', 'bengaluru', 'bangalore', 'mumbai', 'delhi', 'hyderabad', 'pune'] },
  JP: { region: 'apac', names: ['japan', 'japón', 'tokyo', 'tokio'] },
  SG: { region: 'apac', names: ['singapore', 'singapur'] },
  AU: { region: 'apac', names: ['australia', 'australien', 'sydney', 'melbourne', 'new south wales'] },
  NZ: { region: 'apac', names: ['new zealand', 'auckland'] },
  PH: { region: 'apac', names: ['philippines', 'filipinas', 'manila'] },
  TW: { region: 'apac', names: ['taiwan', 'taipei'] },
  AE: { region: 'mea', names: ['united arab emirates', 'uae', 'dubai'] },
};

/** Remote wording across the three languages alert emails arrive in. */
const REMOTE = /\b(?:remote|remoto|en remoto|home\s?office|homeoffice|anywhere|distributed|teletrabajo|fully remote)\b/iu;

/** A remote ad scoped to a region rather than a country — "Remote, EMEA", "Remote (Europe)". */
const EUROPE_SCOPE = /\b(?:europe|european union|eu|emea|europa|cet)\b/iu;

const REGEX_META = /[.*+?^${}()|[\]\\]/g;

// Word-boundary matchers, built once. `\p{L}` lookarounds instead of `\b` so
// "köln" and "zürich" bound correctly on their non-ASCII letters.
const MATCHERS: ReadonlyArray<readonly [string, RegExp]> = Object.entries(COUNTRIES).flatMap(([code, c]) =>
  c.names.map((n) => [code, new RegExp(`(?<![\\p{L}\\p{N}])${n.replace(REGEX_META, '\\$&')}(?![\\p{L}\\p{N}])`, 'iu')] as const),
);

/** Every country the location string names, by ISO code. */
export function countriesIn(locationRaw: string): string[] {
  const found = new Set<string>();
  for (const [code, re] of MATCHERS) if (re.test(locationRaw)) found.add(code);
  return [...found];
}

export function isRemoteLocation(locationRaw: string): boolean {
  return REMOTE.test(locationRaw);
}

/** Country of the user's home city, or null when the lexicon doesn't know it. */
export function homeCountry(city: string): string | null {
  return countriesIn(city)[0] ?? null;
}

function containsCity(loc: string, city: string): boolean {
  const re = new RegExp(`(?<![\\p{L}\\p{N}])${city.replace(REGEX_META, '\\$&')}`, 'iu');
  return re.test(loc);
}

export interface UserLocation {
  /** Home city as the user typed it; null = no location preference given. */
  city: string | null;
  remoteOk: boolean;
}

export function locationFit(locationRaw: string | null, user: UserLocation): number | null {
  if (!user.city || !locationRaw || locationRaw.trim() === '') return null;
  const loc = locationRaw.toLowerCase();
  const city = user.city.trim().toLowerCase();
  const home = homeCountry(city);
  const homeRegion = home ? COUNTRIES[home]!.region : null;

  // Prefix match on the city ("Hamburgo", "Hamburg-Altona") — the city
  // itself is the strongest statement the string can make.
  if (containsCity(loc, city)) return 1;

  const countries = countriesIn(loc);
  const remote = isRemoteLocation(loc);

  // A home city the lexicon can't place gives nothing to measure distance
  // from: only the two statements that don't need a country still count.
  if (home === null) return remote && user.remoteOk && countries.length === 0 ? 1 : null;

  if (remote && user.remoteOk) {
    // Remote with no country attached, or scoped to the user's own country
    // or to Europe as a whole, is remote the user can actually take.
    if (countries.length === 0) return 1;
    if (countries.includes(home)) return 1;
    if (homeRegion === 'europe' && EUROPE_SCOPE.test(loc)) return 1;
    // Remote but tied to another country: the contract usually needs
    // residence there — closer to relocating than to remote.
    if (homeRegion && countries.some((c) => COUNTRIES[c]!.region === homeRegion)) return 0.6;
    return 0.1;
  }

  if (countries.length === 0) {
    // "Remote" for a user who doesn't want remote, or an unplaceable string.
    return remote ? 0.3 : null;
  }
  if (countries.includes(home)) return 0.6;
  if (homeRegion && countries.some((c) => COUNTRIES[c]!.region === homeRegion)) return 0.3;
  return 0.1;
}
