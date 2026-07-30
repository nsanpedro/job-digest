/**
 * Normalization assembly (design §6.5): one extracted ad → Facts for the rule
 * engine plus Wording for the UI, produced together but never conflated —
 * facts feed evaluate() (I6), wording feeds the expanded panel, and every
 * wording quote is a literal substring of email text (I5).
 *
 * Anything no normalizer recognizes stays null and surfaces as `unknown`
 * (I4). German level and commute never come from alert emails today: level
 * vocabulary waits for ad bodies (lexicon.ts is ready), commute is enrichment
 * (§6.6), not normalization.
 */
import type { Facts, Wording, WordingEntry } from '@job-digest/core';
import { eur } from '@job-digest/core';
import type { ExtractedAd } from '../extract/types';
import { normalizeContract, normalizeGerman, normalizeShift } from './lexicon';
import { normalizeEmployment } from './employment';
import { normalizePay } from './pay';
import { normalizeWorkplace } from './workplace';

export { normalizeContract, normalizeEmployment, normalizeGerman, normalizePay, normalizeShift, normalizeWorkplace };
export type { EmploymentFacts } from './employment';
export type { PayFacts } from './pay';
export type { WorkplaceFacts } from './workplace';

export interface NormalizedAd {
  facts: Facts;
  wording: Partial<Wording>;
}

const entry = (value: string, quote: string, note: string): WordingEntry => ({ value, quote, note });

export function normalizeAd(
  extracted: ExtractedAd,
  tvoed?: Record<string, number>,
): NormalizedAd {
  const facts: Facts = {
    rotating: null,
    weekend: null,
    german: null,
    home: null,
    pay: null,
    payMax: null,
    payFte: null,
    fteNote: null,
    permanent: null,
    commuteMin: null,
  };
  const wording: Partial<Wording> = {};

  // ── Pay ──
  if (extracted.pay) {
    const src = extracted.pay.value;
    const p = normalizePay(src, tvoed);
    if (p) {
      facts.pay = p.pay;
      facts.payMax = p.payMax;
      facts.payFte = p.payFte;
      facts.fteNote = p.fteNote;
      const monthly =
        p.payMax !== null && p.payMax !== p.pay ? `${eur(p.pay)} – ${eur(p.payMax)}` : eur(p.pay);
      // The chip value is always the monthly figure the Pay rule actually
      // evaluates — never the raw annual band. Showing "60.000 € - 75.000 €"
      // as the chip would read as a monthly floor of 60k and misrepresent
      // what the rule tested. The literal source stays in the I5-verified
      // quote, and the derivation is spelled out in the note.
      wording.Pay = p.derivedFromAnnual
        ? entry(`≈ ${monthly}/mo`, src, `${src} annual, ÷ 12 — no 13th salary assumed`)
        : entry(monthly, src, '');
    }
  }

  // ── Onsite: the location line first, the title as fallback ──
  for (const source of [extracted.location, extracted.title]) {
    if (!source || wording.Onsite) continue;
    const w = normalizeWorkplace(source.value);
    if (!w) continue;
    facts.home = w.home;
    const note =
      w.home === null
        ? 'the ad says how it works, not how many days — check before counting on it'
        : w.home >= 5
          ? 'fully remote'
          : w.home === 0
            ? 'no home office'
            : `${w.home} home-office day${w.home === 1 ? '' : 's'} a week`;
    wording.Onsite = entry(w.matched, source.value, note);
  }

  // ── Shift, from the working-time line when ad bodies provide one ──
  if (extracted.workingTime) {
    const s = normalizeShift(extracted.workingTime.value);
    if (s) {
      facts.rotating = s.rotating;
      facts.weekend = s.weekend;
      wording.Shift = entry(s.matched, extracted.workingTime.value, '');
    }
  }

  // ── Contract: explicit wording wins; the employment-type pill can only
  //    decide the freelance case (employment form ≠ contract duration) ──
  if (extracted.contract) {
    const c = normalizeContract(extracted.contract.value);
    if (c) {
      facts.permanent = c.permanent;
      wording.Contract = entry(c.matched, extracted.contract.value, c.permanent ? 'permanent' : 'fixed-term');
    }
  }
  if (facts.permanent === null && extracted.employmentType) {
    const e = normalizeEmployment(extracted.employmentType.value);
    if (e?.permanent === false) {
      facts.permanent = false;
      wording.Contract = entry(
        extracted.employmentType.value,
        extracted.employmentType.value,
        'freelance — not a permanent employment contract',
      );
    }
  }

  return { facts, wording };
}
