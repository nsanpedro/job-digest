/**
 * Pay normalization (design §6.5). Extraction gives strings; the Pay rule
 * needs comparable gross-monthly numbers.
 *
 * Period decision, in order:
 *  1. Explicit markers win: "/Monat", "monatlich" → monthly; "/Jahr", "p.a.",
 *     "jährlich", "Jahresgehalt" → annual.
 *  2. Otherwise magnitude decides: German gross salaries below ~20.000 € are
 *     monthly figures, above are annual. Xing bands ("47.000 € - 69.500 €")
 *     carry no marker and are annual by platform convention — the threshold
 *     encodes that without special-casing the platform.
 *
 * Annual figures are divided by 12 (no 13th salary assumed) and rounded; the
 * original band survives verbatim in the wording quote (I5) — the fact is
 * derived, the words are the ad's.
 *
 * "bei 20 Std." part-time figures get an FTE projection against an assumed
 * 40-hour week — the design's j3 fixture (2.250 € at 30h → 3.000 € FTE)
 * pins that constant.
 */

export interface PayFacts {
  /** Gross monthly, lower bound of a band. */
  pay: number;
  payMax: number | null;
  payFte: number | null;
  /** e.g. "at 20h" — shown, never computed from. */
  fteNote: string | null;
  /** True when the figure was annual and divided by 12. */
  derivedFromAnnual: boolean;
}

const ASSUMED_FULLTIME_HOURS = 40;
const ANNUAL_THRESHOLD = 20_000;

/**
 * Seed value from the design fixture (Klinik am Stadtpark, TVöD E5 ≈ 2.930 €).
 * The authoritative, versioned table lives in db.tvoed_rates; callers inject
 * it. This snapshot only keeps the pure function usable in tests.
 */
const TVOED_SNAPSHOT: Record<string, number> = { E5: 2930 };

/** "2.900", "47.000" → number. German thousands-dot format. */
function parseGermanNumber(s: string): number {
  return Number.parseInt(s.replace(/\./g, ''), 10);
}

// A band may carry € only after the second figure: "2.900 – 3.300 € …".
const RANGE = /(\d{1,3}(?:\.\d{3})+|\d{3,})\s*(?:€\s*)?[–-]\s*(\d{1,3}(?:\.\d{3})+|\d{3,})\s*€/;
const AMOUNT = /(\d{1,3}(?:\.\d{3})*)\s*€/g;
const MONTHLY_MARKER = /\/\s*monat|monatlich|brutto\s*\/\s*monat|mtl\./i;
const ANNUAL_MARKER = /\/\s*jahr|jährlich|p\.\s*a\.|jahresgehalt|jahresbrutto/i;
const HOURS = /bei\s+(\d{1,2})\s*std/i;

export function normalizePay(
  text: string,
  tvoed: Record<string, number> = TVOED_SNAPSHOT,
): PayFacts | null {
  const cleaned = text.trim();
  if (!cleaned) return null;

  // Tariff reference: a lookup, not parsing (§6.5).
  const tvoedMatch = cleaned.match(/tv[öo]d\s*([ES]\s?\d{1,2})/i);
  if (tvoedMatch?.[1]) {
    const group = tvoedMatch[1].replace(/\s/, '').toUpperCase();
    const monthly = tvoed[group];
    if (monthly === undefined) return null; // unknown group: null, not a guess (I4)
    return { pay: monthly, payMax: null, payFte: null, fteNote: null, derivedFromAnnual: false };
  }

  let low: number;
  let high: number | null;
  const range = cleaned.match(RANGE);
  if (range) {
    low = parseGermanNumber(range[1] as string);
    high = parseGermanNumber(range[2] as string);
  } else {
    const amounts = [...cleaned.matchAll(AMOUNT)].map((m) => parseGermanNumber(m[1] as string));
    if (amounts.length === 0) return null; // "attraktives Gehalt" → the ad gives no figure
    [low, high] = [amounts[0] as number, null];
  }
  if (high !== null && high < low) [low, high] = [high, low];

  const annual =
    !MONTHLY_MARKER.test(cleaned) && (ANNUAL_MARKER.test(cleaned) || low >= ANNUAL_THRESHOLD);
  if (annual) {
    low = Math.round(low / 12);
    high = high === null ? null : Math.round(high / 12);
  }

  const hours = cleaned.match(HOURS)?.[1];
  let payFte: number | null = null;
  let fteNote: string | null = null;
  if (hours) {
    const h = Number.parseInt(hours, 10);
    if (h > 0 && h < ASSUMED_FULLTIME_HOURS) {
      payFte = Math.round((low / h) * ASSUMED_FULLTIME_HOURS);
      fteNote = `at ${h}h`;
    }
  }

  // "bis 2.600 €": the band tops out there — the top is the honest figure.
  if (high === null && /\bbis\b/i.test(cleaned)) high = low;

  return { pay: low, payMax: high, payFte, fteNote, derivedFromAnnual: annual };
}
