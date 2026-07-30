/**
 * Monotonic fact merging for repeat sightings (design §6.7).
 *
 * A later sighting may fill in nulls — a Xing email missing pay, then a
 * LinkedIn one with it. This is the one write path that mutates an ad, and
 * it is strictly monotonic: null → value, never value → different value.
 *
 * A later sighting that disagrees with a stored value is a *conflict*: it is
 * recorded on the sighting and flagged, never silently overwritten. Which
 * platform is right is not knowable here, and picking one at random would
 * make the ad's provenance a lie.
 */
import type { Facts, Wording } from '@job-digest/core';

export interface FactConflict {
  field: keyof Facts;
  stored: unknown;
  incoming: unknown;
}

export interface MergeResult {
  facts: Facts;
  wording: Partial<Wording>;
  conflicts: FactConflict[];
  /** True when the merge actually filled something in. */
  enriched: boolean;
}

export function mergeFacts(
  stored: { facts: Facts; wording: Partial<Wording> },
  incoming: { facts: Facts; wording: Partial<Wording> },
): MergeResult {
  const facts = { ...stored.facts };
  const wording: Partial<Wording> = { ...stored.wording };
  const conflicts: FactConflict[] = [];
  let enriched = false;

  for (const key of Object.keys(facts) as Array<keyof Facts>) {
    const storedValue = stored.facts[key];
    const incomingValue = incoming.facts[key];
    if (incomingValue === null || incomingValue === undefined) continue;
    if (storedValue === null || storedValue === undefined) {
      // null → value: the only mutation allowed.
      (facts[key] as unknown) = incomingValue;
      enriched = true;
    } else if (storedValue !== incomingValue) {
      conflicts.push({ field: key, stored: storedValue, incoming: incomingValue });
    }
  }

  // Wording follows the same rule: fill gaps, never overwrite a quote that is
  // already grounded in a stored email (I5).
  for (const key of Object.keys(incoming.wording) as Array<keyof Wording>) {
    if (!wording[key] && incoming.wording[key]) {
      wording[key] = incoming.wording[key];
      enriched = true;
    }
  }

  return { facts, wording, conflicts, enriched };
}
