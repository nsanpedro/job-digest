# Synthetic CV fixtures

These are hand-written CV texts used to validate the role-discovery matcher: given each CV, `derive-directions` should produce a top direction that clearly matches the rubro, and downstream matching should reject obviously off-rubro ads (e.g. a "Sales Manager" listing for `graphic-designer.txt`, or a "Frontend Developer" listing for `data-analyst.txt`). None of these are real people; employers, cities, and dates are fabricated.

Expected top direction per fixture:

- [ ] `graphic-designer.txt` — Graphic Designer / Brand Designer (visual identity, typography, print)
- [ ] `project-manager.txt` — Technical Project Manager / Program Manager (delivery, OKRs, stakeholders)
- [ ] `backend-developer.txt` — Senior Backend Engineer (Go / Node.js, distributed systems)
- [ ] `ux-designer.txt` — Senior UX / Product Designer (research, Figma, usability)
- [ ] `data-analyst.txt` — Senior Data Analyst / Analytics Engineer (SQL, dbt, BI)

These files are inputs to `packages/worker/scripts/validate-matcher.ts` (being added in a sibling task on this branch). That script loads each fixture, runs it through the role-discovery pipeline, and asserts that the produced directions look sensible and that a small pool of intentionally off-rubro ads gets rejected.
