/**
 * Matcher regression suite — pins the ladder against KNOWN false-positive
 * patterns that surfaced in production for two test CVs (a graphic designer
 * and a project manager both started seeing off-rubro ads like "Sales
 * Manager" and "Finanzas / Finance Manager" in their digests).
 *
 * Cases are grouped by the persona whose CV they simulate. Each block mixes:
 *
 *   - Negatives — ad titles the persona should NEVER see. Each asserts that
 *     `computeMatch(...).tier === 0` for a direct match, or that
 *     `directionFitStrength(...)` collapses to 0 when the ad is meant to be
 *     ruled out by an ad-level exclude.
 *   - Positive controls — ~3 ads per persona that MUST keep matching so a
 *     future tightening of the ladder can't regress the happy path.
 *
 * Some tests are expected to fail against current main — those cases are
 * flagged with `// TODO: currently fails — will pass after fix in A3`. They
 * are intentionally NOT `test.skip`'d: we want the suite red until the
 * matcher fix lands. Every other test is a regression guard on already-
 * correct behavior — it exists so a well-meaning refactor doesn't silently
 * bring the false positives back.
 *
 * Only the matcher primitives are exercised here (`computeMatch`,
 * `directionFitStrength`). scoreAd/directionFit compose these plus scoring
 * policy and belong in their own suites — this file pins the bedrock.
 */
import { describe, expect, test } from 'vitest';
import { directionFitStrength, type CurationDirection } from './curation';
import { computeMatch } from './matching';

// ── Persona fixtures ─────────────────────────────────────────────────────────
// Search-term sets modelled on the two CVs that hit the false-positive class,
// plus a backend-developer CV as a third contrast (different role family,
// different exclude shape) so the suite catches leaks in both directions.

const GRAPHIC_DESIGNER_TERMS = [
  'graphic designer',
  'brand designer',
  'visual designer',
  'art director',
] as const;
const GRAPHIC_DESIGNER_EXCLUDES = ['sales', 'engineer'] as const;
const GRAPHIC_DESIGNER_DIR: CurationDirection = {
  distance: 'adjacent',
  searchTerms: GRAPHIC_DESIGNER_TERMS,
  excludeTerms: GRAPHIC_DESIGNER_EXCLUDES,
};

const PROJECT_MANAGER_TERMS = ['project manager', 'program manager', 'PMO'] as const;
const PROJECT_MANAGER_EXCLUDES = ['sales', 'engineer'] as const;
const PROJECT_MANAGER_DIR: CurationDirection = {
  distance: 'adjacent',
  searchTerms: PROJECT_MANAGER_TERMS,
  excludeTerms: PROJECT_MANAGER_EXCLUDES,
};

const BACKEND_DEVELOPER_TERMS = [
  'backend developer',
  'backend engineer',
  'software engineer',
] as const;
const BACKEND_DEVELOPER_EXCLUDES = ['sales', 'designer'] as const;
const BACKEND_DEVELOPER_DIR: CurationDirection = {
  distance: 'adjacent',
  searchTerms: BACKEND_DEVELOPER_TERMS,
  excludeTerms: BACKEND_DEVELOPER_EXCLUDES,
};

// ── graphic designer CV ──────────────────────────────────────────────────────

describe('graphic designer CV', () => {
  // Negatives — off-rubro titles the CV owner reported seeing in their digest.
  // These pin the matcher's direct behavior: no role-suffix word ("designer",
  // "director") can carry a match on its own, and no short token ("art", 3
  // chars) can carry a match via substring hits in unrelated words.

  test('"Sales Manager" does not synonym-match "designer" via the word "manager"', () => {
    // The reported case. `manager` (7 chars, below the long-word floor)
    // must not be enough to hop the ladder toward "graphic designer".
    expect(computeMatch('Sales Manager', null, GRAPHIC_DESIGNER_TERMS).tier).toBe(0);
  });

  test('"Finanzas / Finance Manager" does not leak in', () => {
    // Second reported case. No searchTerm token appears in the title, and
    // the role-suffix filter has to reject "manager"/"director" alone.
    expect(computeMatch('Finanzas / Finance Manager', null, GRAPHIC_DESIGNER_TERMS).tier).toBe(0);
  });

  test('"Account Executive" — no evidence, no match', () => {
    expect(computeMatch('Account Executive', null, GRAPHIC_DESIGNER_TERMS).tier).toBe(0);
  });

  test('"Marketing Coordinator" — no evidence, no match', () => {
    expect(computeMatch('Marketing Coordinator', null, GRAPHIC_DESIGNER_TERMS).tier).toBe(0);
  });

  test('"Sales Solutions Engineer" is ruled out ad-level by the "sales" exclude', () => {
    // The direct match would already be 0 (no term hits); the assertion is
    // that the ad-level exclude fires even so, so directionFitStrength = 0
    // even if a later change relaxes the tier ladder.
    expect(directionFitStrength('Sales Solutions Engineer', null, [GRAPHIC_DESIGNER_DIR])).toBe(0);
  });

  test('"Machine Learning Engineer" is ruled out ad-level by the "engineer" exclude', () => {
    expect(directionFitStrength('Machine Learning Engineer', null, [GRAPHIC_DESIGNER_DIR])).toBe(0);
  });

  // TODO: currently fails — will pass after fix in A3
  test('"Startup Director" does not full-phrase-match "art director" via "art" inside "startup"', () => {
    // The short-token substring bug: `art` is 3 chars, above MIN_TOKEN_LEN,
    // so full-phrase matching accepts it via `includes("art")` — which is
    // true for "startup", "chart", "smart", "part", … Combined with
    // "director" (a role suffix that DOES contribute at the full-phrase
    // tier), any "* Director" title where any other word contains "art"
    // as a substring gets promoted to tier 1.0. Off-rubro leak vector for
    // any CV that lists "art director" as a searchTerm.
    expect(computeMatch('Startup Director', null, GRAPHIC_DESIGNER_TERMS).tier).toBe(0);
  });

  // TODO: currently fails — will pass after fix in A3
  test('"Chart Director" does not full-phrase-match "art director" via "art" inside "chart"', () => {
    // Same class as "Startup Director", named separately so the fix is
    // clearly proven against >1 realistic host word.
    expect(computeMatch('Chart Director', null, GRAPHIC_DESIGNER_TERMS).tier).toBe(0);
  });

  // Positive controls — the ladder must keep firing on real graphic-designer ads.

  test('"Senior Graphic Designer" matches at the full-phrase tier', () => {
    expect(computeMatch('Senior Graphic Designer', null, GRAPHIC_DESIGNER_TERMS).tier).toBeGreaterThanOrEqual(0.6);
  });

  test('"Brand Designer" matches at the full-phrase tier', () => {
    expect(computeMatch('Brand Designer', null, GRAPHIC_DESIGNER_TERMS).tier).toBeGreaterThanOrEqual(0.6);
  });

  test('"Art Director, Digital" matches at the full-phrase tier', () => {
    expect(computeMatch('Art Director, Digital', null, GRAPHIC_DESIGNER_TERMS).tier).toBeGreaterThanOrEqual(0.6);
  });
});

// ── project manager CV ───────────────────────────────────────────────────────

describe('project manager CV', () => {
  // Every searchTerm token here is below the long-word floor
  // (project/program/manager are all 7 chars; PMO is 3). So the ONLY tier
  // that can legitimately fire for this persona is the full-phrase tier —
  // long-word evidence should be impossible. These tests pin that.

  test('"Sales Manager" — "manager" alone must not carry a match to "project manager"', () => {
    // The reported failure mode: shared trailing word ("manager") tempts a
    // buggy matcher into a hit. Full-phrase needs both "project" AND
    // "manager"; long-word tier is closed to both (7 chars each).
    expect(computeMatch('Sales Manager', null, PROJECT_MANAGER_TERMS).tier).toBe(0);
  });

  test('"Finanzas / Finance Manager" does not leak into a PM digest', () => {
    // The second reported case, re-checked under a different searchTerm set.
    expect(computeMatch('Finanzas / Finance Manager', null, PROJECT_MANAGER_TERMS).tier).toBe(0);
  });

  test('"General Manager" — shared "manager" is not enough', () => {
    expect(computeMatch('General Manager', null, PROJECT_MANAGER_TERMS).tier).toBe(0);
  });

  test('"Account Manager" — shared "manager" is not enough', () => {
    expect(computeMatch('Account Manager', null, PROJECT_MANAGER_TERMS).tier).toBe(0);
  });

  test('"Marketing Manager" — shared "manager" is not enough', () => {
    expect(computeMatch('Marketing Manager', null, PROJECT_MANAGER_TERMS).tier).toBe(0);
  });

  test('"Sales Development Representative" is ruled out ad-level by "sales"', () => {
    // Ad-level exclude fires at directionFitStrength — the primary reason
    // this ad never reaches a PM digest even if some searchTerm did hit.
    expect(directionFitStrength('Sales Development Representative', null, [PROJECT_MANAGER_DIR])).toBe(0);
  });

  test('"Software Engineer" is ruled out ad-level by "engineer"', () => {
    expect(directionFitStrength('Software Engineer', null, [PROJECT_MANAGER_DIR])).toBe(0);
  });

  // Positive controls.

  test('"Project Manager, Operations" matches at the full-phrase tier', () => {
    expect(computeMatch('Project Manager, Operations', null, PROJECT_MANAGER_TERMS).tier).toBeGreaterThanOrEqual(0.6);
  });

  test('"Senior Program Manager" matches at the full-phrase tier', () => {
    expect(computeMatch('Senior Program Manager', null, PROJECT_MANAGER_TERMS).tier).toBeGreaterThanOrEqual(0.6);
  });

  test('"PMO Lead" matches on the single-token searchTerm "PMO"', () => {
    expect(computeMatch('PMO Lead', null, PROJECT_MANAGER_TERMS).tier).toBeGreaterThanOrEqual(0.6);
  });
});

// ── backend developer CV ────────────────────────────────────────────────────

describe('backend developer CV', () => {
  // The engineering-family searchTerms have "software" (8 chars) as a legit
  // long-word candidate. Everything else is either a role suffix
  // (developer/engineer) or below the long-word floor (backend, 7 chars).
  // These tests pin: no role-suffix carries a match; ad-level "designer"
  // and "sales" excludes fire cleanly.

  test('"Sales Solutions Engineer" is ruled out ad-level by "sales"', () => {
    // The classic case from the excludes-live-at-the-ad-level doc: even
    // though "software engineer" is in the searchTerms, the shared
    // "sales" exclude drops the whole ad.
    expect(directionFitStrength('Sales Solutions Engineer', null, [BACKEND_DEVELOPER_DIR])).toBe(0);
  });

  test('"Sales Engineer" is ruled out ad-level by "sales"', () => {
    expect(directionFitStrength('Sales Engineer', null, [BACKEND_DEVELOPER_DIR])).toBe(0);
  });

  test('"Product Designer" is ruled out ad-level by "designer"', () => {
    // Word-boundary exclude — "designer" here matches "Designer" and not
    // (accidentally) "designers"/"designed" in unrelated ad copy.
    expect(directionFitStrength('Product Designer', null, [BACKEND_DEVELOPER_DIR])).toBe(0);
  });

  test('"UX Designer" is ruled out ad-level by "designer"', () => {
    expect(directionFitStrength('UX Designer', null, [BACKEND_DEVELOPER_DIR])).toBe(0);
  });

  test('"Financial Analyst" — no evidence, no exclude, no match', () => {
    expect(computeMatch('Financial Analyst', null, BACKEND_DEVELOPER_TERMS).tier).toBe(0);
  });

  test('"Marketing Coordinator" — no evidence, no match', () => {
    expect(computeMatch('Marketing Coordinator', null, BACKEND_DEVELOPER_TERMS).tier).toBe(0);
  });

  test('"Finance Manager" — no evidence, no match', () => {
    expect(computeMatch('Finance Manager', null, BACKEND_DEVELOPER_TERMS).tier).toBe(0);
  });

  // Positive controls.

  test('"Backend Engineer, Payments" matches at the full-phrase tier', () => {
    expect(computeMatch('Backend Engineer, Payments', null, BACKEND_DEVELOPER_TERMS).tier).toBeGreaterThanOrEqual(0.6);
  });

  test('"Senior Software Engineer" matches at the full-phrase tier', () => {
    expect(computeMatch('Senior Software Engineer', null, BACKEND_DEVELOPER_TERMS).tier).toBeGreaterThanOrEqual(0.6);
  });

  test('"Backend Developer" matches at the full-phrase tier via role synonyms', () => {
    // "developer" ↔ "engineer" via ROLE_SYNONYMS — the CV owner writes
    // "backend developer" or "backend engineer" and either flavor of ad
    // title reaches them.
    expect(computeMatch('Backend Developer', null, BACKEND_DEVELOPER_TERMS).tier).toBeGreaterThanOrEqual(0.6);
  });
});
