# ADR-002: Public job-board APIs as a parallel source

**Status:** Proposed
**Date:** 2026-08-20
**Decider:** Nico (single founder)
**Amends:** `docs/system-design.md` §4 (acquisition — currently email-only), §6.1 (fetch loop), §9 (schema)

---

## 1. Context

The product ingests one thing today: emails from job-board alerts. That path is what makes
StepStone/LinkedIn/Xing coverage possible at all (their APIs are closed or scraping-only), and
it stays — it is the moat.

But it forces a specific onboarding: the user has to already have alerts configured on each
platform, or set forwarding up. Someone landing on Job Digest with a CV and no alerts has
nothing to show for it until they go do that work elsewhere.

Public job-board APIs (Greenhouse, Lever, Ashby, Personio) close that gap. They are keyless,
per-company endpoints returning open positions as structured JSON. The user picks companies to
watch; we fetch, normalize, and feed the same rule engine that email-sourced ads already flow
through.

**This is a coverage feature, not a differentiator.** Aggregators like Employable already do
this. Job Digest's differentiators (the explicit rule engine, CV-driven role discovery, curated
push over browse) are unchanged. APIs are table stakes so the product is not conspicuously
thin on day one.

---

## 2. The questions that decide the design

### 2.1 What is a "source"?

Every API in scope is **per-company**: you give it a company slug and get all their open
positions. There is no cross-company search. So the user model is *"follow this company"*, not
*"search for this role"* — the same rule engine narrows it down after fetch.

A **source** is one (user, provider, company-slug) tuple. Sources are user-scoped just like
mailboxes; the same tenant policy applies.

### 2.2 How does the user add one?

Free-text slug entry ("stripe") is unfriendly and easy to typo. Pasting a URL is not:
`https://boards.greenhouse.io/stripe` tells us both provider and slug. Each provider adapter
exposes `parseSlugFromUrl` — the form accepts a URL, dispatches to the adapters, and picks
whichever parses.

Validation happens on add: we call the API once with the parsed slug. A 404 fails the add
loudly rather than silently sitting there returning nothing forever.

### 2.3 One `ads` row shape for both paths

Emails and API responses produce the same downstream artifact: an `Ad` the rule engine reads.
Different table would double every query. Same table with a new provenance column is one join
that never has to happen.

**Schema changes:**
- Extend `platformEnum` with `Greenhouse | Lever | Ashby | Personio`.
- Add `ads.source_id` (nullable FK to `sources`). Email-sourced ads leave it null; API-sourced
  ads leave `ad_sightings.raw_email_id` null.

Rules eval, dedup by `(user, dedupe_key)`, and the read-time transformation the search-mode
uses (I6) all keep working unchanged. This is the invariant we get to keep by not forking the
model: **rules don't care where an ad came from.**

### 2.4 Dedup across providers

Within a provider: `(platform, external_id)` — every API returns a stable id.

Cross-provider (same job posted on Greenhouse *and* LinkedIn): the existing `dedupe_key`
(hash over title/company/city) already catches it. Extractors just need to normalize
company/title consistently — the same normalization the email extractors already do.

No new dedup layer. If two providers disagree on a field, `ad_sightings.conflicts` records it
the same way §6.7 already handles email conflicts.

### 2.5 Caching

The obvious knob is *"don't re-fetch a source if we just fetched it."* `sources.last_fetched_at`
is the cache; a "5 min" freshness window means "Update now" is a cheap no-op if pressed twice
in a row, without any Redis or HTTP-cache infrastructure.

**Not doing:**
- **HTTP ETag / If-None-Match**: some ATS APIs support it, some don't. Not worth the
  adapter-by-adapter complexity for a bandwidth we're not paying for.
- **Storing raw responses**: the APIs are public and free — re-fetching for debug is free too.
  If a normalization bug shows up, we re-fetch. If this hurts later, add a
  `raw_api_snapshots` table then, not now.

### 2.6 Parallelism

Same shape as `gmail.ts`: `Promise.all` with a concurrency cap (5). A user with 20 sources
finishes in ~4 rounds, which is fast enough for on-demand "Update now" without a queue.

### 2.7 Where the fetch lives

`packages/worker/src/fetch-apis.ts`, next to `gmail.ts` — same role, "talks to an external
service, produces `Ad`s". Adapters live in `packages/worker/src/providers/{greenhouse,lever,ashby,personio}.ts`.

The web process never touches the APIs directly (no secret is at stake, but the
architectural rule — I13's spirit — stays: side-effectful outbound calls in the worker only).

### 2.8 How this ties into "Update now"

`startRefresh` today creates one `runs` row per mailbox. It will now also create one per
source, kick both off in parallel via `after()`, and return an array of run ids. The
`RefreshButton` polls all of them and aggregates progress.

**Schema change to `runs`:** `mailbox_id` becomes nullable; a new `source_id` (nullable FK)
is added. A run row has exactly one of the two set (or neither, for the dev fallback path).
`emails_total`/`emails_processed` are reused as `items_total`/`items_processed` in spirit —
we do not rename the columns (invasive; not worth the churn), we just accept the label
mismatch for source runs.

### 2.9 Errors

Per-source, not per-run: a Personio 500 does not kill the LinkedIn run. `sources.last_error`
captures the last failure for UI display. Same pattern as `mailboxes.status` for auth failures.

### 2.10 Rate limiting

Documented limits: Ashby 200 req/min. Greenhouse/Lever/Personio: none published. A user is
bounded to a small number of sources in practice (say, 20). The concurrency cap of 5 keeps
us under any plausible per-provider ceiling without a token-bucket.

**Not doing** a rate limiter. If a provider starts 429ing us, we back off then; today it
would be dead code.

---

## 3. Adapter interface

```typescript
export interface JobBoardProvider {
  readonly name: 'Greenhouse' | 'Lever' | 'Ashby' | 'Personio';
  parseSlugFromUrl(url: string): string | null;
  fetchJobs(slug: string): Promise<NormalizedJob[]>;
}

export interface NormalizedJob {
  externalId: string;
  externalUrl: string;
  title: string;
  company: string;
  locationRaw: string | null;
  facts: Partial<Facts>;
  wording: Partial<Wording>;
  postedAt: Date | null;
}
```

Same output shape as an email extractor, minus the raw-email bookkeeping. The mapping into
`ads` is one function, shared across providers.

---

## 4. Order of implementation

1. **Migration 0011** — `sources` table, `ads.source_id`, `runs.source_id`,
   `runs.mailbox_id` nullable, `platformEnum` extended.
2. **Provider interface + Greenhouse adapter** — simplest, best-documented API. Real fetch
   against a real company (Stripe, probably — 500+ jobs is a good load test).
3. **`fetch-apis.ts` in the worker** — mirrors `gmail.ts`, one function per source with
   `Promise.all` concurrency.
4. **Server actions** — `addSource(url)` (parses, validates, inserts) and `removeSource(id)`.
5. **UI in Profile** — new "Companies to watch" section next to mailboxes; add-by-URL form,
   list with remove/last-error.
6. **`startRefresh` extended** to run mailboxes + sources in parallel, return `runIds[]`.
   `RefreshButton` aggregates progress.
7. **Lever, Ashby, Personio adapters** — one per commit, each verified live against a real
   company's board before merging.

Each step is its own commit. Live verification (not just unit tests) is the bar for calling
any step done — same pattern as the StepStone extractor was built against real fixtures, not
guessed formats.

---

## 5. What this deliberately doesn't do

- **No cross-company keyword search across ATS APIs.** No public API supports it; simulating
  it by fanning out over a crawled directory of ATS-using companies is a different product.
- **No Arbeitsagentur.** Deferred — high value for DACH but different auth (public API key
  header) and different response shape. Its own adapter later, same interface.
- **No cron / scheduled fetching.** On-demand only for MVP; scheduling is the §13.7
  cadence work already deferred in the design doc.
- **No paid enrichment** (Proxycurl-style). The whole point of this ADR is the *keyless*
  APIs — the moment we add a paid dependency, we've become the thing we're competing with.

---

## 6. Invariants introduced

**I19 — an ad's source is its provenance, not its identity.** The rule engine, dedup, and
read-time transformations are all source-agnostic. Adding a provider adds an adapter and an
enum value; it does not add a code path in evaluation.

**I20 — a source is validated on add or it is not added.** A stored source that never
successfully returned a job is a UI mystery; failing the add is a UI answer. Adapters return
`[]` for a valid empty company and throw for a missing one; only the throw fails the add.
