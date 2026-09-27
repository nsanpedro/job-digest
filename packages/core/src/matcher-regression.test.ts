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

// ── spelling variants of the same role word ─────────────────────────────────

describe('spelling variants (Sep 2026 ranking eval)', () => {
  // Recall misses the ranking eval surfaced: the same role word spelled
  // joined, hyphenated or spaced ("frontend" / "Front-End" / "Front End"),
  // and German compounds vs their split forms ("Softwareentwickler" vs
  // "Software Entwickler"). `normalizeRoleSpelling` rewrites both sides to
  // one canonical form before the ladder runs. Every positive here is a
  // title-side full phrase, so it must land on tier 1.0 — not merely
  // squeak through the long-word tier.

  test.each([
    ['frontend engineer', 'Senior Front End Engineer'],
    ['frontend engineer', 'Senior Front-end Engineer (Libra - Legal AI Assistant) (m/f/d)'],
    ['frontend engineer', 'Frontend Engineer'],
    ['frontend engineer', 'Intern - Front-End Developer'],
    ['Senior Frontend Entwickler React', 'Senior Front-End Entwickler (React)'],
    ['fullstack developer', 'Full Stack Developer (m/w/d)'],
    ['fullstack developer', 'Full-Stack Developer'],
    ['fullstack developer', 'Fullstack Developer'],
    ['fullstack developer', 'Fullstack-Entwickler (m/w/d)'],
    ['full stack engineer', 'Fullstack Engineer (m/f/d) - Berlin / Vienna'],
    ['backend engineer', 'Back End Engineer'],
    ['backend engineer', 'Back-End Engineer'],
    ['back-end engineer', 'Backend Engineer'],
    ['software entwickler', 'Softwareentwickler (m/w/d) React'],
    ['software entwickler', 'Software-Entwickler'],
    ['Softwareentwickler', 'Software Entwickler'],
    ['Softwareentwickler', 'Software Engineer'],
    ['web entwickler', 'Webentwickler (m/w/d)'],
    ['webentwickler', 'Web-Entwickler'],
    ['webentwickler', 'Web Entwickler'],
  ])('term "%s" matches "%s" at the full-phrase tier', (term, title) => {
    const r = computeMatch(title, null, [term]);
    expect(r.tier).toBe(1.0);
    // Provenance stays the user's own wording, not the canonical form.
    expect(r.matchedTerm).toBe(term);
  });

  // Negatives — the halves of a joined English compound are generic words.
  // Canonicalising to the joined form (not the split one) is what keeps
  // "front" + "end" or "back" from being assembled out of unrelated words.
  test.each([
    ['frontend engineer', 'Front Desk Engineer'],
    ['frontend engineer', 'End User Support Engineer'],
    ['frontend engineer', 'Front Office Engineer, End-of-Line Testing'],
    ['backend engineer', 'Back Office Manager'],
    ['fullstack developer', 'Full-time Stack Operations Clerk'],
  ])('term "%s" does NOT match "%s"', (term, title) => {
    expect(computeMatch(title, null, [term]).tier).toBe(0);
  });

  test('the spelling pass reaches ad-level excludes too', () => {
    // A user who excludes "front end" must not see "Frontend Engineer" slip
    // through the gate just because the positive match spells it joined.
    const dir: CurationDirection = {
      distance: 'adjacent',
      searchTerms: ['software engineer'],
      excludeTerms: ['front end'],
    };
    expect(directionFitStrength('Senior Frontend Software Engineer', null, [dir])).toBe(0);
    expect(directionFitStrength('Senior Backend Software Engineer', null, [dir])).toBe(1);
  });
});

// ── engineering manager (Sep 2026 ranking eval) ─────────────────────────────

describe('engineering manager — full phrase needs role structure, not a bag of words', () => {
  // From the Sep 2026 ranking eval against a real account. The user had
  // "Engineering Manager" as a searchTerm. The full-phrase tier used to fire
  // whenever both words appeared ANYWHERE in the title, so roles the user
  // had dismissed scored 1.0 next to the ones they applied to / saved.
  const TERMS = ['Engineering Manager'] as const;

  // Negatives — dismissed by the user. Both fall all the way to 0, not to
  // the long-word tier: "engineering" is in NON_DISCRIMINATIVE_ROLE_WORDS
  // and "manager" is 7 chars, so this term has no long-word evidence to
  // give. (A term with a domain long word would still land 0.6 — the ladder
  // below full-phrase is unchanged.)
  test.each([
    // A different noun ("Category") qualifies the role head; "Engineering"
    // after the dash is the category, not the role.
    'Category Manager - Engineering & Professional Services',
    // Head first with something else in between — no order, no inversion.
    'Manager Operations Engineering Performance',
  ])('dismissed "%s" does not reach the full-phrase tier', (title) => {
    const r = computeMatch(title, null, TERMS);
    expect(r.viaFullPhrase).toBe(false);
    expect(r.tier).toBe(0);
  });

  // Positive controls — the user applied to or saved every one of these.
  test.each([
    'Engineering Manager (m/w/d)',
    'Engineering Manager (f/m/x)',
    'Senior Engineering Manager',
    'Engineering Manager, Infrastructure - Infrastructure Platform',
    'Engineering Manager Software Engineering',
    // "Role, Qualifier" inversion: the segment before the comma is the bare
    // role head, the qualifier names the rest of the term.
    'Manager, Software Engineering - Growth Platform',
    'Engineering Manager - Fintech',
    'Engineering Manager, Cloud Infrastructure (all genders)',
  ])('applied/saved "%s" matches at 1.0', (title) => {
    const r = computeMatch(title, null, TERMS);
    expect(r.tier).toBe(1.0);
    expect(r.viaFullPhrase).toBe(true);
  });

  test('mirror image of the inversion — "Engineering - Office Manager" — is not a match', () => {
    // The bare segment must hold the term's head ("manager"), not just any
    // term word, or a department prefix would invert into a false hit.
    expect(computeMatch('Engineering - Office Manager', null, TERMS).tier).toBe(0);
  });

  test('a domain long word still carries 0.6 when the phrase structure fails', () => {
    // The order rule only gates the full-phrase tiers; the long-word tier
    // below is untouched. "platform" is 8 chars and not a role suffix.
    const r = computeMatch('Category Manager - Platform Engineering', null, ['Platform Engineering Manager']);
    expect(r.viaFullPhrase).toBe(false);
    expect(r.tier).toBe(0.6);
    expect(r.viaLongWord).toBe('platform');
  });

  test('head-first "Director of Engineering" still matches "engineering director"', () => {
    // "of" is dropped by tokenize, so the two words form a contiguous run.
    expect(computeMatch('Director of Engineering', null, ['engineering director']).tier).toBe(1.0);
  });

  test('description tier follows the same rule', () => {
    expect(
      computeMatch('Growth Lead', 'Our manager of operations engineering performance reports to the COO.', TERMS).tier,
    ).toBe(0);
    expect(
      computeMatch('Growth Lead', 'You will join as Engineering Manager for the payments team.', TERMS).tier,
    ).toBe(0.8);
  });
});

describe('frontend engineer — synonyms and "Role, Qualifier" titles survive the order rule', () => {
  const TERMS = ['Frontend Engineer'] as const;

  test.each([
    'Senior Frontend Developer',
    'Senior Frontend Entwickler',
    // Greenhouse/Lever inversion with a generic discipline word ("Software")
    // before the head — allowed via GENERIC_ROLE_MODIFIERS.
    'Software Engineer, Frontend (React, NextJS)',
  ])('"%s" matches at 1.0', (title) => {
    expect(computeMatch(title, null, TERMS).tier).toBe(1.0);
  });

  test('"Sales Engineer, Frontend" is not an inversion — "sales" qualifies the head', () => {
    // Drops out of the full-phrase tier and lands on long-word evidence:
    // "frontend" is a domain word (8 chars, not a role suffix), so 0.6 —
    // below the focused threshold, still visible in discovery.
    const r = computeMatch('Sales Engineer, Frontend', null, TERMS);
    expect(r.viaFullPhrase).toBe(false);
    expect(r.tier).toBe(0.6);
    expect(r.viaLongWord).toBe('frontend');
  });
});

describe('team lead software entwicklung — unchanged by the order rule', () => {
  test('"Team Lead Frontend Development" still misses: "software" is absent', () => {
    // Not an ordering question: the term's "software" is missing, and
    // "entwicklung"/"development" are not ROLE_SYNONYMS. Pinned so the
    // order rule is not mistaken for the reason.
    const terms = ['Team Lead Software Entwicklung'];
    expect(computeMatch('Team Lead Frontend Development (m/w/d)', null, terms).tier).toBe(0);
    expect(computeMatch('Team Lead Software Entwicklung (m/w/d)', null, terms).tier).toBe(1.0);
  });
});
