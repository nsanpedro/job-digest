/**
 * Workplace normalization: location strings and titles → home-office days.
 *
 * Sources are bilingual because the platforms are: LinkedIn stamps modality
 * in the account's UI language ("(En remoto)", "(Híbrido)", "(Presencial)"),
 * Xing ads carry German ("80 % Remote", "Kein Homeoffice", "2 Tage
 * Homeoffice"). Facts.home is days per week:
 *
 *   fully remote → 5 · fully onsite → 0 · "N Tage Homeoffice" → N
 *   "80 % Remote" → 4 (percentage of a 5-day week)
 *   hybrid without a number → null — the ad says hybrid but not how many
 *   days, and the Onsite rule cannot be decided from that (I4). The wording
 *   keeps "Híbrido" for the UI; the fact stays honest.
 *   "Remote-Optional" / "Remote möglich" → null — an option is not a promise.
 */

export interface WorkplaceFacts {
  home: number | null;
  /** The token that decided it — becomes the wording value. */
  matched: string;
}

interface Pattern {
  re: RegExp;
  home: (m: RegExpMatchArray) => number | null;
}

const PATTERNS: Pattern[] = [
  // Explicit day counts win over everything.
  { re: /(\d)\s*Tage?\s*Homeoffice/i, home: (m) => Number.parseInt(m[1] as string, 10) },
  { re: /kein\s+Homeoffice/i, home: () => 0 },
  // Percentages: share of a 5-day week, rounded.
  { re: /(\d{1,3})\s*%\s*(?:remote|homeoffice)/i, home: (m) => Math.round((Number.parseInt(m[1] as string, 10) / 100) * 5) },
  // An option is not a promise. StepStone's own phrasing ("Homeoffice
  // möglich" in the employment-type field) is the same "possible, not
  // guaranteed" claim as "remote möglich" — same honest null.
  { re: /(?:remote|homeoffice)[-\s]?(?:optional|möglich)/i, home: () => null },
  { re: /100\s*%\s*remote|voll(?:ständig)?\s*remote|\bEn remoto\b|fully\s+remote/i, home: () => 5 },
  { re: /\bHíbrido\b|\bhybrid\b/i, home: () => null },
  { re: /\bPresencial\b|vor[-\s]?Ort|onsite|Präsenz\b/i, home: () => 0 },
];

export function normalizeWorkplace(text: string): WorkplaceFacts | null {
  for (const { re, home } of PATTERNS) {
    const m = text.match(re);
    if (m) return { home: home(m), matched: m[0] };
  }
  return null;
}
