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

## Ranking — `scoreAd` and `selectTiers`

The curated digest (ADR-003) is layered on top of `evaluate`. Two pure functions:

- **`scoreAd(facts, verdicts, ruleset, directions, title, source, receivedAt, now, calibration) → ScoreBreakdown`** — five components in `[0, 1]` (`directionFit`, `ruleMargin`, `freshness`, `sourceQuality`, `signalCompleteness`), combined by a fixed weighted sum. The `total` lives in `[0, 100]`, rounded.
- **`selectTiers(scored, history, calibration) → Tiered<T>`** — greedy pick over the sorted pool, respecting the tier thresholds (I21), the certainty gate (I23), the per-company / per-platform / per-direction diversity caps (I24), and repeat-suppression (I25). Returns `{ topPicks, worthAReading, stretch, stillOpen, explore }`.

Repeats (`ad.repeat === true`, i.e. `firstSeenAt < window.start`) never enter Top / Read / Stretch. They surface in `stillOpen` if they score above the read threshold (capped at 6), otherwise fall to `explore`. This is I25 extended past its original Top-pick scope — see ADR-003 §8.3.

Role synonyms (`engineer ↔ developer ↔ entwickler`) are honored during direction match. See `ROLE_SYNONYMS` in `scoring.ts`.

## `explainDigest` — thin-week diagnostic

When the curated tiers come up short, `explainDigest(input) → Insight[]` returns 1–2 auto-generated observations naming *why* (which rule blocked the most ads, whether the pre-filters ate the corpus, whether ads scored below the thresholds). Pure derivation over the same data `getDigest` already computed. Above the threshold it returns `[]` — a healthy digest speaks for itself.

## Calibration

Weights and tier thresholds live in `DEFAULT_CALIBRATION` (versioned; current: v2). Screenshots from a v1 week stay legible because the digest header records `calibration@v`. ADR-003 §8.1 explains the v1 → v2 rebalance.

```sh
npm test -w @job-digest/core
```
