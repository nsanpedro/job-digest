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
| **Direction fit** | 0.30 | Currently boolean via `matchesAnyDirection`. Becomes graded: full-phrase match = 1.0, ≥8-char single-word match = 0.6, no match = 0.0. Multiplied by the direction's `distance` (adjacent=1.0, stretch=0.5 — `Distance = 'adjacent' \| 'stretch'` as defined by ADR-001; the three-tier draft from the design session is not implemented). |
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

---

## 8. Post-launch amendments (Aug 2026)

The v1 pass shipped and the first real week's data changed four things. Recording them here rather than editing §2 preserves the reasoning trail — the original design is legible; the revisions are legible; the reader can see what the data forced.

### 8.1 v2 calibration — rebalanced weights and thresholds

Live data (Nico's own corpus, week 34) showed the v1 math made the curated tiers structurally unreachable for the typical email-alert ad:

- Xing/LinkedIn/StepStone almost never quote Pay or Onsite in the alert email → `signalCompleteness = 0`, `ruleMargin ≈ 0.5` (neutral).
- With those fixed, the score depended almost entirely on `directionFit`.
- A long-word direction match (0.6) on an email-platform ad capped total at **54** — below `worthAReading = 55`.
- A full-phrase match on an email-platform ad capped at **66** — well below `topPick = 75`.

v2 shifts weight away from what we rarely read toward what we can measure, and lowers the thresholds to match the resulting distribution:

| Component | v1 weight | v2 weight |
| --- | --- | --- |
| `directionFit` | 0.30 | **0.35** |
| `ruleMargin` | 0.30 | **0.25** |
| `freshness` | 0.15 | **0.20** |
| `sourceQuality` | 0.10 | 0.10 |
| `signalCompleteness` | 0.15 | **0.10** |

| Tier | v1 threshold | v2 threshold |
| --- | --- | --- |
| `topPick` | 75 | **70** |
| `worthAReading` | 55 | **50** |
| `stretch` | 65 | **60** |

Same posture as v1: hand-picked for N=1. `calibration.version` bumped to 2; a screenshot from a v1 week stays legible.

### 8.2 Role synonyms — `engineer ↔ developer ↔ entwickler`

`matchesAnyDirection` and `directionFit` both treated the three as distinct words. In a bilingual (English / German) market where the same role gets titled "Full Stack Developer", "Senior Software Engineer", or "Senior Entwickler" interchangeably, a direction search term "Engineer" would fail to match "Developer" — the same role, different word.

Fix: one small `ROLE_SYNONYMS` map (three keys, `packages/core/src/scoring.ts`), applied at match time. All entries are ≥8 chars, so the long-word gate remains meaningful. Kept minimal on purpose — adding "senior" / "lead" would open false positives ("Senior Nurse" ≠ engineering).

### 8.3 I25 extended: repeats never enter Top / Read / Stretch

v1 blocked Top-pick re-promotion only. Live data showed 93% of a typical week's corpus was `firstSeenAt < window.start` — repeats from earlier weeks — and the read tier filled up with ads the user had already seen last week, defeating the "what's new this week" promise of the weekly digest.

I25 now applies to all three curated tiers. Repeats that would have qualified score-wise surface in a new tier, `stillOpen`, capped at 6. Excess repeats fall into explore alongside the low-scoring new ads. `selectTiers` does the split internally — the caller passes the whole pool and gets `Tiered<T> & { stillOpen }` back.

### 8.4 Self-diagnostic in the header

When the curated tiers come up short (< 3 ads total), the digest header now renders 1–2 auto-generated observations explaining *why* — which rule blocked the most ads, whether pre-filters ate the corpus, whether ads scored below the thresholds. Pure derivation over the same data `getDigest` already returned; no extra query.

The claim: on a thin week, the digest is more useful as a diagnosis of the pipeline than as an empty list. `explainDigest` in `packages/core/src/explain-digest.ts` is the pure function; `DigestDiagnostic` renders it. Above the threshold the block collapses to `null` — a healthy digest speaks for itself.

Ad cards also gained an inline score breakdown (five components × their weights = total), rendered in the expanded panel. The user can trace a low match number to a specific component instead of asking why.

### 8.5 v3 calibration — seniority and stack, plus a number to grade it with (Sep 2026)

v2's only signal about *what the user wants* was `directionFit`: a keyword ladder over the title with a handful of discrete values. Every ad matching a direction's full phrase tied at 1.0, and the order among them came from freshness and source — a "Junior Frontend Developer" and a "Senior Frontend Engineer" ranked the same for a senior. The title facts that would separate them (`ads.title_facts`: seniority on ~39% of titles, stack on ~18%) were shown as chips and never scored.

v3 adds two components, read from the title with the same lexicon the chips use (`packages/core/src/title-lexicon.ts`, now shared by ingest and scoring):

| Component | Weight | What it measures |
| --- | --- | --- |
| `seniorityFit` | 0.10 | The title's rung against the rungs the user targets: same = 1.0, one up = 0.6, one down = 0.4, further = 0. |
| `stackFit` | 0.05 | Share of the title's technologies the user's own text names. |

The v2 five are scaled by 0.85 to make room. A component whose comparison has a silent side (the title names no rung, the profile names no stack) returns `null` and hands its weight back proportionally (`effectiveWeights`, generalised from the no-directions case). So **an ad with neither signal scores exactly as under v2** — pinned by a test — the tier thresholds keep their meaning, and only ads that carry the signal move.

The user side (`deriveCandidateProfile`, `packages/core/src/candidate.ts`) comes from the user's own text only: rungs named in direction labels and search terms, else the CV's stated years at the two ends of the ladder (≥ 5 → senior, ≤ 1 → junior; the middle stays unknown rather than guessed); stack from the CV's verified skills and the directions. Saved / applied / dismissed ads are deliberately *not* an input — they are the eval's labels.

**The eval.** `packages/worker/scripts/eval-ranking.ts` replays the last N weeks under each calibration (read-only, no top-pick history written) and grades the order against the user's actions: applied / saved = positive, dismissed = negative, the rest unlabelled. The headline metric is pairwise accuracy (how often a positive ranks above a negative), with nDCG@k, recall@k and the positives / negatives that land in the curated tiers alongside. The metric definitions are pure (`packages/core/src/ranking-eval.ts`). The labels were collected under the live ranking, so the eval favours the incumbent calibration: a challenger that wins anyway is winning against the current.

The v3 weights are hand-set like v2's. The eval is how they get checked against a real account before any further moves — the same "reading the top pick" loop as §2.5, made countable.

**First real-account run (27 Sep 2026, one account, 11 weeks, 26 positive / 56 negative label-weeks).** v2 vs v3 is a wash on pairwise accuracy (0.686 vs 0.681), with fewer dismissed ads in the top 10 (15 → 12) and in the curated tiers (7 → 5). The run also caught v3 lifting unrelated roles ("Senior Consultant Digitalisierung") on seniority alone, so `seniorityFit` / `stackFit` now only speak when `directionFit > 0`. The run's bigger finding is upstream of scoring: 6 of the 9 ads the user applied to fail the city pre-filter (Köln, Zurich, Amsterdam, …). Replaying without that gate (`--no-location-gate`) moves pairwise 0.69 → 0.80, recall@10 0.19 → 0.58 and nDCG@10 0.10 → 0.30 — an order of magnitude more than any weight change. Treating "software" / "entwicklung" as non-evidence in the long-word tier removes junior/werkstudent false positives but also drops two applied ads, so that fix needs a sharper rule than a blocklist entry.

### 8.6 v4 calibration — location is scored, not gated (Sep 2026)

The city pre-filter in `getDigest` is gone. It sent every ad whose location string didn't contain the user's city (or a hard-coded alias of its country) to Explore before scoring; on the one account with labels, that hid 6 of the 9 ads the user had applied to, and it was inconsistent on its own terms ("Berlin, Germany" passed a Hamburg user, "Köln" didn't).

Location is now `locationFit` (`packages/core/src/location.ts`): home city or acceptable remote = 1.0, same country 0.6, rest of Europe 0.3, elsewhere 0.1, null when the string can't be placed or the user set no city. Countries come from a closed lexicon of names (EN/DE/ES) and major cities; remote tied to a far-away country ("Remote in the US") is not treated as remote the user can take. The only pre-filter left is the direction match.

Weight 0.05, with v3 scaled to make room (so an unplaceable location scores exactly as under v3). The weight is a tiebreak on purpose — swept on that account, every step up cost ranking quality:

| `locationFit` weight | pairwise | nDCG@10 | recall@10 |
| --- | --- | --- | --- |
| v2 / v3 (city gate) | 0.686 / 0.681 | 0.108 / 0.103 | 0.192 |
| 0 (no gate, no signal) | 0.795 | 0.289 | 0.577 |
| **0.05 (shipped)** | **0.762** | **0.274** | **0.538** |
| 0.10 | 0.743 | 0.248 | 0.462 |
| 0.15 | 0.738 | 0.223 | 0.423 |

This user applies well beyond the stated city, so any location preference costs on this account. 0.05 keeps the stated city first among equal matches for a user whose preference is real, rather than making the Location setting decorative. The next measurable lever is the matcher: with the gate gone, its false positives ("Category Manager – Engineering" matching "Engineering Manager", "Junior Software Engineer" matching via the long word "software") are what fills the top of the list.

### 8.7 Level gate — entry-level titles go to Explore for a senior target (Sep 2026)

With the city gate gone, the eval account (targets lead + senior) kept dismissing entry-level ads that reached the tiers: "Junior Software Engineer", "Werkstudent Softwareentwicklung", "Intern - Front-End Developer", "(Junior) Software Entwickler:in". They pass the direction gate on a long word ("software" out of the search term "Team Lead Software Entwicklung"), and `seniorityFit` = 0 only costs them that component's weight (≈ 0.1) — not enough to keep them below ads the user wants.

`getDigest` pass 2 now has a second gate after the direction match: `isBelowTargetLevel(title, candidate)` (`packages/core/src/candidate.ts`) is true when the title states the junior rung and every rung the user targets is senior or above. Those ads go to Explore unscored. It stays off when the user targets junior (alone or alongside a senior rung), targets nothing, or the title states no rung — "Frontend Developer (m/w/d)" is not junior for lack of a "Senior". Only the entry-level end is gated: a "Senior" ad for a lead is one rung down, a reachable step that `seniorityFit` already scores.

The junior row of the lexicon (`title-lexicon.ts`) grew to the entry-level wording the alerts arrive in, still as a closed list of whole words: intern / internship, trainee, working student, entry level; Werkstudent(in), Werkstudierende, Praktikum / Praktikant(in) (spelled out — the bare `praktik` prefix also read "Praktiker"), Azubi, Ausbildung, Auszubildende; becario/a, pasante / pasantía, prácticas. "Internal", "International" and "Internet" do not read as intern (tested). The gate reads the title live, so it applies to stored ads at once; the stored `title_facts` chip picks up the new words on ingest or via `backfill-title-facts.ts`.

Counted apart from direction misses: `DigestMetrics.explore.belowTargetLevel` next to `preFilterMisses` (still direction-only, so the "didn't match your directions" copy stays true), and the Explore page names it. `metrics.explore` is now non-null when either gate ran. The eval replays it as a separate variant, `v4+level`, beside `v4` without it, and prints how many labelled ads the gate removes — a positive among them is the gate's cost.

### 8.8 Matcher round, measured (27 Sep 2026)

The three matcher changes — spelling pre-pass (`normalizeRoleSpelling`), word-order-aware full phrase, level gate (§8.7) — replayed on the same account and weeks as §8.6. The matcher change applies to every variant's replay, so the "before" column is the eval at `4eb5702`:

| | pairwise | nDCG@10 | recall@10 | dismissed in top 10 | curated (+/−) |
| --- | --- | --- | --- | --- | --- |
| v4, matcher before | 0.762 | 0.274 | 0.538 | 10 | 6 / 7 |
| v4, matcher after | 0.857 | 0.315 | 0.538 | 3 | 6 / 5 |
| v4 + level gate | 0.857 | 0.315 | 0.538 | 3 | 6 / 3 |

The level gate removed 15 direction-matched ads across the weeks — 8 of them dismissed, none positive — so it only changes the curated tiers (their juniors already ranked below the positives). The one week still weak (0.167) has a single positive, "Staff Engineer - Virtual Assembly Line", that matches none of the user's directions: a direction-coverage gap, not a matcher error.

### 8.9 Top pick eligibility — v5 calibration (Sep 2026)

I23 asked for Pay **and** Onsite to be read before an ad could be a Top pick. In practice the tier came up empty in most weeks. When the tier is empty the digest holds at most 8 ads (Read 6 + Stretch 2), not 10, and the week's two strongest ads compete for Read slots.

**Measured without production data.** `packages/ingest/test/top-pick-eligibility.test.ts` runs the real alert fixtures through the real pipeline (extractor → `normalizeAd` → facts). Board ads are synthesised the way the providers build them: no salary except on about half of Ashby postings, and home office read from the location string. It then replays 200 seeded weeks of 20–49 new ads each through evaluate → gates → `scoreAd` → `selectTiers`, under the Engineering ruleset (Pay hard at 3500 €, Onsite a preference at 3 days):

| scenario | empty Top weeks, v4 | empty Top weeks, v5 | Top size v4 → v5 | curated size v4 → v5 |
| --- | --- | --- | --- | --- |
| fixture mix (LinkedIn 25 / Xing 55 / StepStone 10 / boards 10 %) | 67 % | **0 %** | 0.38 → 1.99 | 7.3 → 8.7 |
| LinkedIn-heavy (70 % LinkedIn) | 84 % | **10 %** | 0.16 → 1.57 | 7.3 → 8.4 |
| board-heavy (40 % boards) | 61 % | **3 %** | 0.49 → 1.88 | 7.5 → 8.8 |
| no pay-bearing source (LinkedIn + Greenhouse/Lever/Personio) | 100 % | 100 % | 0 → 0 | 7.6 → 7.6 |

The fixtures showed that the missing fact was usually not Pay. Xing and StepStone cards quote a salary band on more than 80 % of cards (90 % in the fixtures). They almost never give a home-office day count: "Hybrid" and "Homeoffice möglich" both read as `null`, on purpose (`normalizeWorkplace`). Pay is missing on every LinkedIn alert, on Greenhouse, Lever and Personio, and on about half of Ashby postings. LinkedIn gives a usable home-office value on about a third of its cards ("Presencial", "En remoto"). So under I23 as written, the fact that emptied the tier on the pay-bearing platforms was Onsite. Onsite is a preference in `DEFAULT_RULESET` and in every `rulesetForCategory` ruleset.

**The rule.** An ad is Top-pick eligible when it scores at least `tierThresholds.topPick`, is new this week, was not a Top pick last week (I25), and has no `unknown` verdict on a Pay or Onsite rule **that the user's ruleset makes hard**. An unread preference is allowed through.

Why severity is the line:

- An unread hard rule could hide a dealbreaker. Had we read the salary, the ad might be blocked. The Top tier cannot vouch for that ad.
- An unread preference cannot hide a dealbreaker. A preference never blocks (I4), so the worst the missing fact could turn out to be is a `warn`. That is the "one gap" an ad may carry into Worth a read or Stretch anyway.
- The user's own ruleset says which facts are dealbreakers, and the gate asks for exactly those. The unread preference stays on the card as "not read".
- An `unknown` from an undecidable exception (I12) means the base condition was read and failed, and only the escape hatch could not be checked. That only happens on hard rules, so such an ad stays out of Top pick.

**I23, as amended:** *a Top pick cannot rest on an unread dealbreaker.* An ad whose Pay or Onsite rule is hard and whose verdict on it is `unknown` is ineligible for the Top tier regardless of score. An unread Pay or Onsite *preference* does not disqualify the ad, and is shown on the card as not read.

Deliberately not changed:

- **The set of facts stays Pay and Onsite.** Widening I23 to every hard rule would empty the tier for everyone: Shift is hard by default, and no alert or board states shift facts.
- **No role-strength clause.** A second clause was considered: a full-phrase direction match, `directionFit ≥ 1`. It changed no week in the simulation, because at `topPick = 70` every eligible ad there already had a full-phrase match. It would only add a second reason to explain.
- **The honest limit stays.** For a user whose sources never state pay and whose Pay rule is hard, the tier stays empty (last row above). Relaxing the rule further would mean recommending an ad whose dealbreaker we never read. The levers for that user are the ruleset (Pay as a preference: 0 % empty weeks in the same scenario) or a pay-bearing source, not the tier rule.

**Versioned as calibration v5.** The rule lives in `Calibration.topPickCertainty` (`'all'` for v1–v4, `'hard'` for v5). It is not a weight, but it changes which ads reach the Top slots, and those slots are recorded in `ads_top_pick_history`. So it gets the same treatment as the tier thresholds it sits beside (§2.7): a screenshot that says `calibration@v4` should mean the v4 Top-pick rule. Weights and thresholds are v4's unchanged, so every score is identical and a test pins that. `CALIBRATION_V4` stays exported for the replay.

**The eval.** `eval-ranking.ts` now prints a Top pick block for each variant: weeks with an empty tier, mean tier size, and positives / negatives in the tier. It also has a `v5+level` row next to `v4+level`. The two rows share every ranking metric, since the scores are the same, and differ only in the Top pick block and the curated column. That block is where a real account will show whether the relaxed gate lets dismissed ads into the strongest tier.

### 8.10 Descriptions in matching

`computeMatch` always had a description window — tier 0.8 for a full phrase, 0.4 for a long domain word, both read from the first `DESCRIPTION_MATCH_CHARS` (400) of the description — but every caller passed `null`: the providers didn't carry a description, and nothing stored one. A generic title ("Software Engineer (m/w/d)") whose lede says "Engineering Manager for our frontend team" matched nothing.

**Carried and stored.** `NormalizedJob.description` (plain text) comes from the response each adapter already fetches — no extra call per job:

| Provider | Field | Cost |
| --- | --- | --- |
| Greenhouse | `content` (entity-escaped HTML) | needs `?content=true` on the list call: same request count, payload ~5–15 KB per job (several MB for a 500-job board; the onboarding-cache refresh pays it too). Accepted — one request per job would be worse on every axis. |
| Lever | `descriptionPlain` + `lists[]` + `additionalPlain` | none, already in `mode=json` |
| Ashby | `descriptionPlain` (fallback `descriptionHtml`) | none |
| Personio | `<jobDescriptions>` (CDATA / escaped HTML), stored as "section\ntext" | none |

One HTML → text pass (`packages/worker/src/providers/description.ts`) for all of them and for enrichment: block tags become newlines (the matcher splits phrases on `\n`, so a heading line stays its own segment), inline tags vanish, entities decode once. Stored in `ads.description` (migration `0018_ads_description.sql`, nullable text, no backfill), capped at **4 000 chars**: the matcher reads 400, but the cap covers the 3 500-char LLM extraction window with slack, so a re-extraction or a re-tuned window can run from the stored text, and bounds a row at ~4 KB. API ingest writes it (and refreshes it on every fetch; a fetch without one never erases it). Enrichment of Greenhouse/Lever-linked email ads fills it when null. Email-alert ads stay null → title-only, exactly as before.

**Read by every caller.** The ingest gate (`directionFitStrength(job.title, job.description, …)`), the digest read gate and the explanations (`classifyDirections` → `explainMatch`), and ranking (`ScoreAdArgs.description` → `directionFit`). With a null or omitted description every number is the title-only one (pinned by tests).

**Guards — prose is not a title.** The 400-char window stays the anti-boilerplate guard (company intro and EEO text past it cannot match). Two more, in `computeMatch`'s 0.8 tier only (title tiers unchanged):

- *Tight phrase.* In a title "both words, in order, in one segment" is already tight; a prose sentence is long, and "…with our engineering team and the product manager…" would read as "Engineering Manager". The description phrase test is one contiguous run (any order), or term order with at most one token between words ("Join our Front-End team as an engineer" still reads as "frontend engineer"). No "Role, Qualifier" inversion in prose — its "qualifier anywhere" rule is a title idiom.
- *No one-word phrases.* A one-word term in prose is word evidence and falls to the 0.4 long-word tier, keeping its ≥ 8-char floor and role-suffix blocklist ("engineer" in a lede grants nothing).

**Gate policy.** A description full phrase (0.8) passes the digest read gate on its own — that is the point. A lone description long-word (0.4) does not (`isDirectionHit` in `explain-match.ts`): one domain word in 400 chars of prose ("…our distributed team…") is usually company context, not the role. The focused ingest gate (0.7) already refuses it; discovery mode (0.3) ingests it and the digest puts it in Explore. Its explanation stays `matched` (a true statement about the text) and `directionFit` still scores it when the ad got in on other evidence. At ingest, 0.8 × stretch (0.5) = 0.4 clears discovery only, like any stretch evidence.

**Excludes now see the description too.** `directionFitStrength` and `explainMatch` already checked `excludeTerms` against the description window; with descriptions stored that path goes live. Kept as designed and tested — an industry exclude ("insurance", "gambling") is usually evidenced in the lede, not the title — but it is the one place this change can *remove* an ad a title-only gate kept ("junior" as an exclude hits "you will mentor junior engineers"). Watch for it in the next eval run.

**Deploy order.** The digest selects whole `ads` rows, so migration 0018 must be applied before this code runs. Not yet measured: the eval (`eval-ranking.ts`, now reading `ads.description`) is only informative once API-sourced ads have been re-fetched with descriptions.

### 8.11 Dismiss reasons as explicit feedback (Sep 2026)

Saved, dismissed and applied ads did not affect the ranking; they were only the eval's labels. Dismiss now takes an optional *why*, and some answers turn into an effect the user can see and undo.

**Capture.** Dismiss still takes one click. The card becomes a one-line "Dismissed" row in its own place in the list, with Undo and an optional "Why?" and five chips: Wrong role, Wrong level, Location, Company, Other. Picking one is never needed. The reason is stored in `ad_user_state.dismiss_reason`, a nullable Postgres enum `dismiss_reason` (migration 0019). It is a closed set for the same reason as `application_status`: each value has written copy and a defined effect. Changing the reason undoes the previous reason's effect. Undo on the dismissal clears the reason and removes every effect that dismissal produced. The Dismissed list shows the reason ("Dismissed by you — wrong role").

**Effects.** They are pure functions in `packages/core/src/feedback.ts`, dispatched by `planDismissFeedback`:

| Reason | Effect | Where it applies | Undo |
| --- | --- | --- | --- |
| `company` | Mute the company. Its ads go to Explore, unscored. The card says "Muted company — in Explore, unscored" and has an Unmute button. | `getDigest` pass 2: `applyPreFilters` runs a mute gate before the direction gate (`isMutedCompany`), counted in `metrics.explore.mutedCompany` | Unmute on the card, in the follow-up, or in Profile → "From your dismissals" |
| `wrong_role` | Propose up to three title words to exclude from every direction the title matched (`suggestExcludeTerms`). **Nothing is saved until the user picks a word.** The server recomputes the proposal and saves only a word it still contains. | The existing per-direction `exclude_terms`, which the matcher already reads at read time and at the ingest gate | Remove, in the follow-up or in Profile |
| `wrong_level` | No new mechanism. The follow-up states what the level gate (§8.7) does: entry-level titles already go to Explore for a senior-or-above target; with no rung named the gate is off; otherwise the reason is only recorded. | — | — |
| `location`, `other` | Recorded only. They are eval labels, and the follow-up says "nothing is filtered". | — | — |

A company is matched on `companyKey`: lowercase, diacritics folded, punctuation removed, and trailing legal forms dropped (GmbH, AG, & Co. KG, Inc, S.L.U., …). So "Acme GmbH" mutes "ACME GmbH & Co. KG", but not "Acme Group" or "Acmetech".

An exclude is proposed only for a word that passes all of these checks:

- It is **not covered by the user's directions**. It must not appear, at a word boundary (the exclude gate's own rule), in any direction's label or search terms. Excluding a word a direction searches for would remove that direction's own matches.
- It is not a seniority word (level has its own reason), not a word from the company or location line, and not title boilerplate ("m/w/d", "all gender", "Vollzeit", "remote", …).
- It actually fires: with the word added, every matched direction reads `excluded` for this title.

"Most specific first" means longer words first, with ties broken by title order. There is no corpus frequency, so the proposal can be explained from the title alone. The word goes to every matched direction, because excluding it from only one would leave the ad in through another. The API ingest gate (`directionFitStrength`) combines the excludes of all directions, so a word saved on one direction also filters at ingest the ads another direction matched. Checking coverage across *all* directions keeps that from removing any direction's own search phrases.

**Storage.** Each saved effect is a row in `feedback_effects`: `kind` (`mute_company` | `exclude_term`), `value`, `value_key`, `direction_id` for an exclude, the source `ad_id`, and `created_at`. The table has partial unique indexes (one mute per company key, one term per direction), a CHECK that only an exclude has a direction, RLS with the tenant policy, and `SELECT, INSERT, DELETE` for `app_user` and `SELECT` for `worker`. An exclude's term also goes into `directions.exclude_terms`, where the matcher reads it; the row records where it came from and when. Rows are deleted to undo, never edited.

**Eval honesty.** `eval-ranking.ts` grades the ranking against dismissals. Once dismissals change the ranking, the eval could end up checking the ranking against its own answer key. Three rules prevent that:

1. The +fb variant applies only effects saved strictly before the replayed week's start (`effectsBefore(effects, window.start)`). A dismissal made during a week is a label for that week and never an input to it.
2. Every other variant runs with the feedback excludes removed from the stored directions (`withoutExcludeEffects`). The baseline is therefore the pipeline without this feature, not the current directions with the feedback already included.
3. An ad already dismissed before a week started is unlabelled in that week, for every variant (`dismissedBefore`). The product had already moved it aside, and with feedback on, the dismissal that created a mute would otherwise grade that mute in every later week. This changes the earlier variants' numbers slightly when an ad is seen again after its dismissal.

The report adds a `v4+level+fb` row, the dismiss-reason counts, and how many direction-matched ads the prior effects sent to Explore. A positive among those ads is a cost of the feedback.

**Why this is not the learned weights §2.5 rejected.** §2.5 refused to fit the five score weights to applied/saved/dismissed actions, because at N=1 that is fitting noise. None of that happens here:

- **No weight moves.** Calibration, components and thresholds are unchanged. A reason changes a *gate* the user already has (their direction excludes) or adds a new *explicit* one (a muted company). No number is fitted.
- **One statement, one effect, one undo.** The user says "not this company", and that company is muted. Nothing is inferred from a pattern of clicks. An unexplained dismissal still changes nothing.
- **The user confirms the one effect that generalises.** An exclude word can affect ads the user has not seen, so it is only proposed and saved after the user picks it.
- **It is visible and reversible.** The follow-up names each effect when it happens. A muted ad carries a line on its card, and every standing effect is listed in Profile → "From your dismissals" with its undo. The proposal is deterministic in (reason, title, directions): the same inputs always give the same words.
- **Wrong level and location stay labels.** Where the product already has a mechanism (the level gate, `locationFit`), a reason does not add a second one that would compete with it.

Candidate.ts still keeps saved, dismissed and applied out of `CandidateProfile`. Feedback enters only as explicit gates, with its own temporal split in the eval, as that file's note required.

### 8.12 §8.9–§8.11 measured on the real account (27 Sep 2026)

Same account as §8.6/§8.8, 13 weeks, now with the eval's temporal split (§8.11): an ad dismissed before a week began is unlabelled in that week, so the label counts (30 positive / 37 dismissed label-weeks) and the absolute numbers are not comparable with §8.8's table — compare rows within this run.

| variant | pairwise | nDCG@10 | recall@10 | dismissed in top 10 | Top pick: empty weeks | Top pick (+/−) |
| --- | --- | --- | --- | --- | --- | --- |
| v2 | 0.637 | 0.124 | 0.167 | 15 | 11 / 11 | 0 / 0 |
| v4 + level | 0.825 | 0.351 | 0.600 | 3 | 10 / 11 | 0 / 0 |
| **v5 + level** (§8.9) | 0.825 | 0.351 | 0.600 | 3 | **1 / 11** | **3 / 0** |
| v5 + level + feedback (§8.11) | 0.825 | 0.351 | 0.600 | 3 | 1 / 11 | 3 / 0 |

- **Top pick (§8.9)** is the measurable change: the tier was empty 10 of 11 weeks, now 1 of 11, and the 3 ads it picked across those weeks are ads the user applied to or saved — none dismissed. Ranking metrics are unchanged by construction (v5 scores exactly as v4).
- **Descriptions (§8.10)** and **dismiss reasons (§8.11)** show no effect yet, correctly: production has no stored descriptions (the column arrives with migration 0018 and fills as API ads are re-fetched) and no dismiss reasons (0019). Re-measure after a few weeks of both.

---

## 9. Placement is a cut on the displayed score (Oct 2026)

**Supersedes I21, I23, I24, I25 and the Top / Read / Stretch / Still-open structure of §2.3 and §8.3. Scoring (§2.1–§2.6, calibration v4) is unchanged.**

### 9.1 What was wrong

The number on a card (`score.total`) and the section the card landed in were decided by different rules. `selectTiers` put several things between them: slot caps (2 Top, 6 Read, 2 Stretch), per-company / per-platform / per-direction caps that sent a capped ad to Explore, a Stretch tier gated on `directionFit` instead of the total, a repeat split, and a Top-pick certainty gate. The UI then flattened Top, Read, Stretch and Still-open into one list sorted by score, and promoted the first three Explore entries as "Worth a look".

Reported on the real account: two Figma ads, same title and company, both 74%, in different sections; and 60% ads in "Matches this week" while 75% ads sat in the other sections. Each was the system doing what the code said — an ad that hit a company cap went to Explore at full score, and Stretch admitted ads on `directionFit ≥ 60` with a total of 45. Nothing on the screen said which rule had fired, so every such placement read as a bug, and every calibration round (§8.1–§8.12) added another rule between the number and the section.

### 9.2 Decision

**I29 — placement is a monotone function of the displayed score.** An ad with a higher score is never in a lower section than an ad with a lower score. `selectMatches` splits the scored pool at `Calibration.matchThreshold` (50, the old Worth-a-read cut) and sorts each side by score desc, id asc. Nothing else.

- Matches: every scored ad with `total ≥ 50`, new or repeat, no cap. `repeat` is a flag on the card, not a section.
- Worth a look: the top 3 *scored* ads below the threshold — by construction all of them below every match.
- Hidden: everything else below the bar, plus the pre-filter misses (direction, level, muted company). Those carry no score, so they are never ranked against scored ads and never promoted.
- Removed: slot caps, diversity caps, Stretch, Still-open, Top pick and its certainty gate (`isCertain`, `TopPickCertainty`, calibration v5), Top-pick history (`getTopPickHistory`, `recordTopPicks`). `getDigest` no longer writes.

### 9.3 Cost, stated

- **No cap means the list can be long.** On the real account this week: 15 matches from 40 ads. A user with a broad direction set and a busy inbox gets a longer list; the order is still by score, so the head of it is the same ads the old tiers would have shown. If length becomes a problem, the fix is rendering (collapse after N), not a second placement rule.
- **No diversity.** Four Figma "Manager, Software Engineering" ads at 74% now appear as four cards. That is what the score says; grouping them is a presentation change that does not move any ad between sections.
- **Top-pick certainty is gone.** Under v5 it made the top tier non-empty in 10 of 11 weeks instead of 1 of 11 (§8.12) — but the UI never showed a "Top pick" label, so the distinction was not visible to the user. The score still carries Pay/Onsite margin and signal completeness.
- `ads_top_pick_history` is now unused. It stays in the schema until a hand-written drop migration is applied to Supabase.

### 9.4 Measured on the real account (3 Oct 2026)

`getDigest` against the live account, read-only: 40 ads this week → 15 matches (scores 54–79), 18 in Explore, 7 dismissed by the user. The lowest match scores 54; no scored ad is in Explore (`belowThreshold: 0`), so I29 holds. All four Figma ads (74) are in Matches together.

The same run showed where the remaining misses come from, and it is not scoring: 17 of the 18 Explore ads are pre-filter misses (no score), including "Senior Full Stack Developer", "Senior Fullstack Developer" and "Senior Backend Engineer". The account's active directions are *Engineering Manager / Team Lead* and *Lead / Senior Frontend Engineer*; no direction covers fullstack or backend, so those titles are gated out before scoring. Fixing that is a Profile change (add a direction), not a calibration change.
