/**
 * Helpers for computing and merging per-rule fact provenance (ADR-003).
 * Pure — no I/O, no DB dependencies.
 */
import type { AdFieldProvenance, Facts, FieldProvenance, RuleKey } from './types';

/** Which Facts fields feed each rule (for provenance mapping). */
const RULE_FACT_KEYS: Record<RuleKey, (keyof Facts)[]> = {
  Shift: ['rotating', 'weekend'],
  German: ['german'],
  Onsite: ['home'],
  Pay: ['pay', 'payMax'],
  Contract: ['permanent'],
};

function ruleKnown(facts: Facts, key: RuleKey): boolean {
  return RULE_FACT_KEYS[key].some((f) => facts[f] !== null);
}

/**
 * Compute initial provenance from facts just written at ingest time.
 * For email-sourced ads, null facts are left unset (null) — enrichment
 * will fill them in as 'from_ad' or 'unknown_after_fetch' later.
 * For API-sourced ads (isApiSource=true), null facts are 'unknown_after_fetch'
 * because the API is already the authoritative source.
 */
export function provenanceFromFacts(
  facts: Facts,
  source: 'from_email' | 'from_ad',
  isApiSource = false,
): AdFieldProvenance {
  const provenance: AdFieldProvenance = {};
  const nullFallback: FieldProvenance = isApiSource ? 'unknown_after_fetch' : 'not_checked';

  for (const key of ['Shift', 'German', 'Onsite', 'Pay', 'Contract'] as RuleKey[]) {
    if (ruleKnown(facts, key)) {
      provenance[key] = source;
    } else if (isApiSource) {
      provenance[key] = nullFallback;
    }
    // email-sourced null facts: leave unset — enrichment will mark them
  }

  return provenance;
}

/**
 * After a Tier 1/2 enrichment fetch, merge new facts into the email-sourced
 * facts (filling nulls only — email is authoritative when it has a value)
 * and update provenance accordingly.
 *
 * Returns the merged Facts and the updated provenance.
 */
export function mergeEnrichedFacts(
  emailFacts: Facts,
  enrichedFacts: Partial<Facts>,
  existingProvenance: AdFieldProvenance,
): { facts: Facts; provenance: AdFieldProvenance } {
  const facts: Facts = { ...emailFacts };

  for (const k of Object.keys(enrichedFacts) as (keyof Facts)[]) {
    const val = enrichedFacts[k];
    if (facts[k] === null && val !== null && val !== undefined) {
      (facts as unknown as Record<string, unknown>)[k] = val;
    }
  }

  const provenance: AdFieldProvenance = { ...existingProvenance };
  for (const key of ['Shift', 'German', 'Onsite', 'Pay', 'Contract'] as RuleKey[]) {
    if (provenance[key]) continue; // already set (e.g. from_email)
    const wasNull = !ruleKnown(emailFacts, key);
    if (!wasNull) continue; // had email data, provenance already set at ingest
    provenance[key] = ruleKnown(facts, key) ? 'from_ad' : 'unknown_after_fetch';
  }

  return { facts, provenance };
}
