# @job-digest/core

The pure rule engine: `evaluate(facts, ruleset) → Verdict[]`. No I/O, no
dependencies — both the web app and the ingestion worker import this module
(design §5.1), and rule accountability is a replay of it over stored facts
(design §7.4).

Implements, from [docs/system-design.md](../../docs/system-design.md):

- **I4** — an unread fact is `null`, never a default; `unknown` never blocks.
- **I6** — evaluation is a pure function of `(facts, ruleset)`; verdicts are
  never stored.
- **I11** — fixed per-rule precedence: waived → unread → exception → base
  condition.
- **I12** — an undecidable exception degrades a hard `block` to `unknown`.

Each verdict carries a `because: Step[]` explanation tree, rendered as prose in
the digest's expanded panel. Presentation (the chip value and the I5-verified
German quote) joins from the ad's wording at render time — facts feed
evaluation, wording feeds the UI (design §9).

```sh
npm test -w @job-digest/core
```
