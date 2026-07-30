/**
 * Employment-type normalization: the Xing card pill ("Vollzeit", "Teilzeit",
 * "Selbstständig") and free text.
 *
 * Selbstständig maps to permanent: false — freelance work is not a permanent
 * employment contract, and a "permanent only" rule must exclude it. Vollzeit/
 * Teilzeit say nothing about contract duration, so they leave permanent null.
 */

export interface EmploymentFacts {
  kind: 'fulltime' | 'parttime' | 'freelance';
  /** Weekly hours when stated ("Teilzeit ab 30 Std."). */
  hours: number | null;
  /** Only freelance decides this axis; employment form ≠ contract duration. */
  permanent: false | null;
}

export function normalizeEmployment(text: string): EmploymentFacts | null {
  const t = text.trim();
  if (!t) return null;
  if (/selbstst[äa]ndig|freelance|freiberuflich/i.test(t)) {
    return { kind: 'freelance', hours: null, permanent: false };
  }
  const hours = t.match(/(\d{1,2})\s*Std/i)?.[1];
  if (/teilzeit|part[-\s]?time/i.test(t)) {
    return { kind: 'parttime', hours: hours ? Number.parseInt(hours, 10) : null, permanent: null };
  }
  if (/vollzeit|full[-\s]?time/i.test(t)) {
    return { kind: 'fulltime', hours: null, permanent: null };
  }
  return null;
}
