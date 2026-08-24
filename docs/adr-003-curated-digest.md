# ADR-003: A curated Top-10, not a filtered list

**Status:** Proposed
**Date:** 2026-08-23
**Decider:** Nico (single founder)
**Amends:** `docs/system-design.md` §7 (rule engine — verdicts stay, ranking gets a scoring layer on top), §13.1 (score field — currently `null`, gets a definition), screen 1 (digest surface — three tiers, not one flat list)
**Complements:** ADR-001 (directions feed the new scoring), ADR-002 (source quality prior distinguishes API-sourced from email-sourced ads)

---

## 1. Context

The product promises a *highly curated* digest. What it delivers is a filtered one.

A week's ingest is ~800 ads across LinkedIn/Xing/StepStone alerts + Greenhouse/Lever/Ashby/Personio boards. The rule engine drops the hard-blocked, three pre-filters in `getDigest` (location → signal → direction) move the obviously off-target to a side bucket, and whatever survives lands in `visible[]` — sorted by `outcomeRank` (sum of rule states) then recency, capped at nothing.

Two things are wrong with that surface:

1. **No tier.** An ad that passes every rule with room to spare looks the same as one that passes because half its facts are `unknown`. The user reads the list top-to-bottom and cannot tell where the fall-off is.
2. **No cap.** A "quiet" week is 40 ads. A busy week is 200. Neither is a *digest* — the word implies editorial choice, and the current UI makes none.

The failure mode is symmetric: the noisy list makes the good picks invisible, and the absence of a highlighted pick makes the whole surface feel low-confidence. The user learns to skim, not to trust.

**The claim of this ADR:** the digest surface is a **weekly Top 10**, tiered as *Top pick (2) / Worth a read (6) / Stretch (2)*, backed by a per-ad `fitScore` that is a pure function over facts we already have. Everything not in the 10 is reachable through an *Explore* view, but the Top 10 *is* the product. If the week is thin, tiers stay empty rather than being padded.

This is not new ingestion, new schema for facts, or new LLM cost on the hot path. It is a scoring layer between `evaluate()` and the read model, plus a selection step that respects diversity and certainty.

---

## 2. The questions that decide the design

### 2.1 Why not just cap `visible[]` at 10 and call it done?

Because "top 10 by current sort" is still not curated — the current sort is *how cleanly an ad clears the rules*, which the code itself calls a placeholder (§13.1 says `score` is null and the fallback is temporary). Capping without scoring would surface the ten most-certain-to-not-be-blocked ads, which is a different question from *the ten the user should actually read*.

The cap only makes sense once ranking answers the right question. That is the scoring model in §3.

### 2.2 Why tiers instead of a flat Top 10?

A ranked list of ten is a hierarchy the eye has to reconstruct. A tiered list names the hierarchy: *these two are the recommendation*, *these six are worth a look*, *these two need judgment*. The user does not have to guess where the confidence falls off — the tier tells them.

Three tiers, not five, because the user's decision surface is small: *apply this week / read later / think about it*. Any finer taxonomy is over-fitting; any coarser one collapses back to the flat list.

### 2.3 Should the tier boundary be by rank or by score?

By score, gated by tier-specific certainty rules. Rank is relative — the tenth-best ad in a great week is not the same object as the tenth-best in a dead week — and a Top pick that is only Top because the pool was weak is precisely the failure this ADR exists to fix.

Concretely:
- **Top pick** requires `fitScore ≥ 75` **and** certainty (I23 below).
- **Worth a read** requires `fitScore ≥ 55`.
- **Stretch** requires `fitScore ≥ 65` on Direction fit alone, and at least one *preference* rule failed (never a hard block — hard blocks are still gone by this point).

A slot with no qualifying candidate stays empty. The digest says so explicitly: *"no strong pick this week — the week's top scores are below."* That is more curated than filling the slot with a mediocre ad, which is the opposite of the promise.

### 2.4 What goes into `fitScore`?

Five components, each in `[0, 1]`, combined by a fixed weighted sum. The components are chosen to be orthogonal — every one measures something the others cannot.

| Component | Weight | What it measures |
| --- | --- | --- |
| **Rule margin** | 0.30 | Not pass/fail — *how far above the floor*. Pay 4000€ against a 2600€ floor scores 1.0; Pay 2700€ scores 0.15. Averaged over the five rules. An `unknown` verdict contributes 0.5 (neutral), not 0 — see §2.6. |
| **Direction fit** | 0.30 | Currently boolean via `matchesAnyDirection`. Becomes graded: full-phrase match = 1.0, ≥8-char single-word match = 0.6, no match = 0.0. Multiplied by the direction's `distance` (primary=1.0, adjacent=0.7, stretch=0.4 — the column is already on `directions`). |
| **Signal completeness** | 0.15 | Fraction of facts we could read: pay + home + location + contract + german, weighted by which the user's ruleset actually consults. An ad we understood ranks above one we didn't, at equal verdicts. |
| **Freshness** | 0.15 | Linear decay: day 0 = 1.0, day 7 = 0.4. Kills the drift toward recycled reposts. |
| **Source quality prior** | 0.10 | 1.0 for Greenhouse/Lever/Ashby/Personio (curated company, structured feed), 0.6 for LinkedIn/Xing/StepStone (alert noise). Small enough to be a tiebreak, not a policy. |

`fitScore = round(100 * Σ (weight_i × component_i))`. All weights live in one file as named constants; changing them is a code change, versioned like the ruleset (§2.7). The five weights sum to 1.0 by construction — a lint test guards it, so a future edit that breaks the sum cannot ship.

The choice of five, not ten, components is deliberate: fewer than three would smear signal; more than seven would be unauditable when a tier looks wrong. Five is what fits on the debug panel (§6) as one legible row per ad.

### 2.5 Why not learn the weights from user actions?

Because at N=1 user, "learning" is fitting noise. The weights are hand-calibrated to Nico's own profile in v1, sit in code as named constants, and get audited by *reading the top pick and asking whether it looks right*. That is a small enough loop to close in a session.

The feedback-loop machinery (a `scoring_feedback` table, a *"recalibrate my weights"* action in Profile) is deferred to v3, once there is a volume of applied/dismissed/saved actions worth regressing over. Explicit not-doing, in §5.

### 2.6 The `unknown` neutrality: 0.5, not 0, and not 1

An ad whose Pay we cannot read is not evidence *for or against* the ad. Scoring it at 0 would systematically bury API-sourced ads (Greenhouse et al. don't expose salary — that's ADR-002 §2.5's "by design, not a quality signal"). Scoring it at 1 would let a fact-empty LinkedIn ad float to the top.

0.5 is the honest middle: the ad neither gains nor loses on the rule it didn't answer. **Signal completeness** is the component that punishes unread-ness — separately, so the two effects don't compound.

### 2.7 Ranking under a versioned ruleset

`fitScore` is a pure function of `(facts, ruleset, directions, calibration)`. Nothing is stored per week; the score is recomputed on read, exactly like the verdicts (I6). Rule accountability (§7.4) — a replay of past facts under a past ruleset — extends cleanly: replay the score too, since it consults nothing else.

The `calibration` argument (the five weights and the tier thresholds) is a bundle. It gets its own version number, `calibration_version`, that ticks whenever the constants change. The digest header shows both `ruleset@v` and `calibration@v` so a screenshot from last week is legible if either has moved.

`ads.score` — currently a nullable integer used by nothing — is repurposed as the cache slot for the *last computed* score, for debugging and diff-in-time views. The read path does not consult it; recompute is authoritative.

### 2.8 Diversity as a hard cap over ranking

Three caps enforced on the final Top 10:

- **Max 2 ads per company.** A company opening five roles this week gets two slots; the other three surface in Explore. Without this, one hiring spree owns the digest.
- **Max 5 ads per platform.** Prevents a LinkedIn-heavy week from crowding out the API-sourced picks that carry the source-quality prior — the platforms are complementary and both should be visible.
- **Max 6 ads per direction.** The user has multiple directions on purpose (ADR-001); a week that skews to one crowds the exploratory ones out.

Diversity is applied *after* ranking, greedy: take the highest-scored ad; if it violates a cap, skip; continue until the tier is full or the pool is exhausted. Ads culled by diversity go to Explore, not to lower tiers — a Top-pick-quality ad from an over-represented company should not become a Stretch, because Stretch means something specific (§2.3).

### 2.9 No repeat Top picks two weeks running

An ad still open next week is legitimate to re-show; recommending it *again* as a Top pick is not — the user either applied or chose not to, and a second recommendation is either redundant or nagging.

The rule: an ad shown in Top pick in week N is ineligible for Top pick in week N+1, but can appear in Worth a read with the note *"still open"*. Week N+2 it becomes eligible again. Two weeks is empirically the shortest cycle that reads as "we noticed it's still there" rather than "we forgot we already told you".

This needs one new column, `ads_top_pick_history` — one row per (user, ad, week) when an ad was placed in Top pick. Kept for four weeks then pruned; not user-facing state.

### 2.10 Where the LLM sits (v2, not v1)

`ad_narratives` (fit/gap) already exists (`packages/db/src/schema.ts:447`, cached by `profileVersion` + `promptVersion`). It is under-used today — the digest reads `fit`/`gap` if present, does not generate on demand.

Two LLM steps, both v2:

1. **Narrate the top ~20 by deterministic score.** Generate `fit` (one sentence, why the ad matches this user) and `gap` (one sentence, what it lacks). Cached, so a re-view is free.
2. **Champion the Top pick.** Prompt: given the top 5 and the user's profile, which 2 would you recommend applying to first? The LLM's answer is recorded alongside the deterministic answer; the deterministic answer wins ties. Divergence is signal for calibration, not an override.

Neither step runs on the 800-ad pool. Cost bound: 20 × ~500 output tokens × Sonnet ≈ cents per user-week. Explicit not-doing: no LLM in the base score, ever — a score whose provenance is a model call is a score that cannot be replayed under a past ruleset (§7.4) without also pinning the model version, which no one wants to maintain.

### 2.11 Read-path shape

`getDigest` returns `{ topPicks, worthAReading, stretch, explore, ... }` instead of `{ visible, offTarget, dismissed, ... }`. `offTarget` and `dismissed` collapse into `explore` for the UI — the three-way split was a debugging aid that the tiers replace. The underlying `filteredByRule` / `dismissedByUser` / `offTarget` counts stay in `metrics` for the honesty footer.

The three tiers each have a shape identical to today's `DigestAd`, plus a `tier: 'top' | 'read' | 'stretch'` field and a `scoreBreakdown: ScoreBreakdown` field (§6). One flat pass over rows still produces the whole thing; assembly stays in JS at digest-scale (a few hundred ads a week), consistent with the assembly rationale already in `digest.ts:1`.

---

## 3. The scoring module

`packages/core/src/scoring.ts`, alongside `evaluate.ts` and following its shape:

```typescript
export interface ScoreBreakdown {
  ruleMargin: number;       // [0, 1]
  directionFit: number;     // [0, 1]
  signalCompleteness: number; // [0, 1]
  freshness: number;        // [0, 1]
  sourceQuality: number;    // [0, 1]
  total: number;            // [0, 100], rounded
}

export interface Calibration {
  version: number;
  weights: { ruleMargin: number; directionFit: number; signalCompleteness: number; freshness: number; sourceQuality: number };
  tierThresholds: { topPick: number; worthAReading: number; stretch: number };
  sourcePriors: Record<Platform, number>;
  freshnessHalfLifeDays: number;
}

export function scoreAd(
  facts: Facts,
  verdicts: readonly Verdict[],
  ruleset: Ruleset,
  directions: readonly DirectionRow[],
  now: Date,
  receivedAt: Date,
  source: Platform,
  calibration: Calibration,
): ScoreBreakdown;
```

`scoreAd` is pure and side-effect-free, mirroring `evaluate()`. Every component has a dedicated test file that covers the boundary cases (zero pay, unknown facts, no directions, decayed-past-window ad); the composed `scoreAd` has property tests over the shape of the output (weights sum to 1, output ≤ 100, all components in `[0, 1]`).

The tiering step is a separate function — scoring produces a number, selection turns numbers into tiers with diversity caps:

```typescript
export function selectTiers(
  scored: readonly ScoredAd[],
  history: readonly TopPickHistoryRow[],
  calibration: Calibration,
): { topPicks: ScoredAd[]; worthAReading: ScoredAd[]; stretch: ScoredAd[]; explore: ScoredAd[] };
```

Separation matters because selection has policy (diversity caps, empty-slot handling, repeat-suppression) that scoring does not. Testing them together would make the "why did this ad end up in Stretch?" question harder to answer than it needs to be.

---

## 4. Order of implementation

Each step is its own commit. Live verification against Nico's own inbox is the bar for done, not the test suite — that is the same standard ADR-002 §4 sets, for the same reasons.

1. **`scoring.ts` module** — pure functions, exhaustive unit tests, no wiring yet. Weights and thresholds are named constants in one file.
2. **Migration 0014** — `ads_top_pick_history` table (user_id, ad_id, week_start_date, created_at). RLS policy. `calibration_version` column on the row where the current digest state gets persisted, if any (probably nowhere yet — this may drop out).
3. **`getDigest` rewrite** — compute score per ad, call `selectTiers`, return the new shape. Explore bucket absorbs today's offTarget + rule-dismissed + user-dismissed under one heading (the three sub-lists stay for the debug view).
4. **UI: three tiers** — replace the single list in `packages/app/src/app` (digest page). Empty tiers show the honest fallback text, never a placeholder ad. A score breakdown chip is available in an expanded card view for debugging.
5. **Explore bucket collapsed by default** — one line: *"We scored 843 ads this week. 833 didn't make the digest — [Show all]."*
6. **Weekly top-pick history recording** — write-through when the digest is fetched for a fresh week. The presence of a row for `(user, ad, prev_week)` blocks re-promotion (§2.9).
7. **v2: LLM narratives on top-20** — deferred to its own ADR-004 once v1 has been in use long enough to see where the deterministic score misfires.

Cutover: no backfill needed — `fitScore` is computed on read.

---

## 5. What this deliberately doesn't do

- **No learned weights.** Regressing over five features and one user is astrology. The `scoring_feedback` table and Profile recalibration flow are v3, not v1.
- **No cross-user calibration.** Source priors are global constants, not per-segment. Cross-user learning starts making sense at ≥ N users, not at 1.
- **No dropping the rule engine.** Rules stay authoritative for hard blocks — a fitScore of 92 does not un-block an ad the user's Pay floor disqualifies. Scoring rank-orders the *already-eligible* pool.
- **No LLM in v1.** Every scoring input is a fact already on the ad or a rule already declared. The deterministic score has to be defensible on its own before an LLM is asked to refine it.
- **No new fact extraction.** If Pay is `unknown` today because the extractor missed it, the score treats that as neutral (§2.6) — it does not go re-fetch or re-parse. Extraction quality is upstream and out of scope.
- **No time-of-day scoring, no application-deadline scoring, no "hot company" boost.** Every one of those is a plausible v2 signal; none is v1. The five-component score is small on purpose so the surface stays legible.
- **No user-visible score number.** The tier is visible; the score is not. A number invites optimization ("why is this 78 and that 79?") that the model does not deserve at v1 precision. It appears only in the debug view.

---

## 6. Debug surface

One thing every past feature has needed and this one will too: a way to look at a specific ad and see why it landed where it did. The card, in an expanded state, shows:

- The tier and the score.
- The five components as a row of small bars, each labeled with its raw value and its weighted contribution.
- The direction that matched (or "no direction matched" if only the graded-partial score fired).
- The ruleset version and calibration version the score was computed under.

This is the same read-time-transparency posture the rule engine already has (verdicts explain their steps). A user or a debugging Nico must be able to answer *"why is this in Stretch and not Worth a read?"* by looking at the card, not by reading code.

---

## 7. Invariants introduced

**I21 — the digest surface is capped at 10.** The three tiers together hold at most Top:2 + Read:6 + Stretch:2. Everything else is Explore, which is opt-in. An empty tier is preferable to a padded one.

**I22 — `fitScore` is a pure function of `(facts, verdicts, ruleset, directions, source, receivedAt, now, calibration)`.** Never persisted as the source of truth; the `ads.score` slot is a cache for debug views only. Extends I6 from verdicts to ranking.

**I23 — a Top pick requires certainty.** An ad with `unknown` on Pay or Onsite is ineligible for the Top tier regardless of score. The Top tier is the product's strongest claim; it cannot rest on facts we didn't read.

**I24 — diversity is applied after ranking, not before.** Scoring produces the rank; selection culls to respect per-company (≤2), per-platform (≤5), per-direction (≤6) caps. An ad culled by diversity goes to Explore, not to a lower tier — the tiers name a *kind* of match, not a rank.

**I25 — a Top pick is not re-promoted the following week.** Ads shown in Top pick in week N are ineligible for Top pick in week N+1; they may appear in Worth a read with a "still open" note. Prevents the digest from nagging.
