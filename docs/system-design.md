# Job Digest — System Design

Status: draft v3 for review · 1 August 2026
Input: `job_digest.zip` handoff bundle (Claude Design), prototype `Job Digest.dc.html` (4 screens)

Changes from v1: multi-tenant web service from day one (§2), credential handling promoted to a
first-class concern (§4), the rule engine rewritten as a real engine (§7), layout
fingerprinting and cross-tenant regression detection added (§5.3).

Changes from v2: application tracking (§9, I15/I16) — the first extension past triage, and one
whose shape is dictated by what I14 makes unknowable; search modes as a pure ruleset transform
(§7.7); mobile layout built (§12).

---

## 1. What this is

A web service that reads the job-alert emails LinkedIn, Xing, Indeed and StepStone already
send to a user's mailbox, extracts the vacancies, evaluates each one against rules the user
authors, and renders the result as a dashboard.

The product problem is not discovery. The user already receives the ads; she does not open
them. The problem is **deciding fast and trusting the filter** — fifteen minutes a week,
5–10 ads, yes/no.

That framing sets the engineering agenda. A discovery product optimizes recall and ranking.
This one optimizes three things:

1. **Explainability.** Every value on screen is traceable to a byte in a stored email. The
   UI shows the ad's literal German wording next to every rule verdict.
2. **Legible failure.** When extraction breaks, the user sees what broke, why, and what it
   cost her. *Emails we couldn't read* is observability shipped as a product surface.
3. **Rules that are worth authoring.** A threshold filter is a checkbox. The engine in §7
   is the part of the product that justifies a subscription.

### Explicit non-goals

No scraping. No automated applications. No email digest (the whole point is that email does
not get read).

### Where the scope has since moved

The framing above is about triage, and triage is where the product started. Application
tracking (§9, I15/I16) extends it one step down the funnel: the same ad, after the decision.
That is a deliberate widening — deciding fast is worth fifteen minutes a week, but the
spreadsheet everyone maintains by hand alongside it is worth more, and the system already holds
the ad it would refer to. It is not a widening into acting on the user's behalf: §12's line
about auto-apply and recruiter replies stands, and I15 is what keeps it standing.

### Scale

Per active user: ~12 alert emails/week, ~63 ads extracted/week (~3.3k/year), 5–10 passing
the rules. One scheduled ingestion run per user per day, plus manual runs.

The read path is trivial at any plausible user count — per-user corpora stay small for
years. The load that actually grows with users is **ingestion**: N concurrent IMAP
sessions, N credential decryptions, N LLM narration batches. §10 sizes that.

---

## 2. Tenancy

Multi-tenant from the first migration. Retrofitting isolation is the single most expensive
thing a service can defer, and it costs almost nothing now:

- `user_id` on every table, non-null, part of every unique constraint.
- Postgres **row-level security**, enforced by connecting as a role that cannot bypass it.
  Application bugs then cannot leak across tenants; the database refuses.
- The worker is the one component that runs with elevated access, because it processes many
  tenants in one process. It sets `SET LOCAL app.user_id` per unit of work and every query
  it issues is still filtered by policy. Isolation is not a `WHERE` clause anyone can forget.

What is **not** built yet, and is fine to defer: roles within an account, teams, invitations.
There is one user per account.

### Billing

Metering hooks, not a pricing model. The natural unit is **connected mailboxes** plus
**history retention**, both of which are direct costs. Stripe subscriptions with idempotent
webhook handling; subscription state is a column on `accounts`, and every ingestion run
checks entitlement before it spends money on LLM calls. Free tier: one mailbox, current week
only. That is a proposal, not a decision.

---

## 3. Invariants

Numbered because the code implements them, the tests verify them, and the README explains
them.

**I1 — Raw email bytes are immutable, and deleted only by retention or user request.**
Everything downstream (ads, facts, quotes, verdicts, prose) is derived and rebuildable.
This is what makes I2 possible; without it a parser fix cannot recover previously missed ads.
Nothing ever mutates a stored body. But "never deleted" is not defensible for other people's
mail: raw bodies expire on a retention window (proposal: 90 days, enough for several
parser-fix cycles), and account deletion destroys them immediately by destroying the key
(§4.2). Derived ads and facts outlive the raw bodies; after expiry an ad can no longer be
re-parsed, only re-evaluated (I6).

**I2 — Extraction is versioned, and re-parsing is idempotent.**
Every parse records `parser_version`. Re-parsing inserts a new parse record rather than
mutating the old one, so the history of what we could read when stays intact. Ads dedupe on
a key that does not depend on parser output quality (§6.3), so a better parser enriches an
existing ad instead of creating a twin.

**I3 — The ad count declared by the email is the yardstick for extraction success.**
Alert emails announce their own payload — *"Ihr Job-Alarm: 4 neue Stellen in Hamburg"*.
We extract that declaration in a step independent of extracting the ads; coverage is
`extracted / declared`. This is the one mechanism that turns a silent failure into a visible
one. Where no declaration exists, that absence is recorded (`declared_count: null`) and
coverage is reported as unverifiable — never as 100%.

**I4 — A fact that was not read is `null`, never a default. `unknown` never blocks.**
Missing pay is not "pay = 0". A `null` fact produces `unknown`, and `unknown` on a hard rule
keeps the ad in the list, flagged, pushing the user to open the original. A false negative
(never seeing a good job) costs far more than a false positive.

**I5 — Every German quote rendered in the UI is a verified substring of the stored source.**
A quote not found byte-for-byte (after whitespace normalization) in the stored body is
discarded and the field degrades to `unknown`. This is the hard constraint on LLM
involvement: a model may point at text, never author it.

**I6 — Rule evaluation is a pure function of `(facts, ruleset)`, computed at read time.**
Verdicts are never stored. Changing a rule re-reads nothing and re-parses nothing. This is
what makes the Profile delta preview a diff between two calls instead of a feature, and it
is what makes rule accountability a replay instead of a log (§7.4).

**I7 — The LLM never decides.**
Two jobs: propose facts when deterministic extraction fails (bounded by I5), and write the
`fit`/`gap` prose. Rule states and the match score are deterministic.

**I8 — The system never mutates a mailbox, and the code can prove it.**
`BODY.PEEK` only; no `STORE`, `EXPUNGE`, `APPEND`, `MOVE`, no flag changes — enforced at the
client wrapper, not by convention, and asserted by a test that diffs message flags before and
after a run. The login screen makes four promises; three are negative and this is where they
live.

**I9 — A failed run never empties the screen.**
Ingestion writes new rows; the digest reads the last successful state. Auth failure renders
as a banner above an intact digest.

**I10 — User state and rule outcomes are orthogonal axes.**
`dismissed by user`, `blocked by rule` and `overridden by user` are three different things
that share one UI section. They never collapse into a boolean.

**I11 — Verdict precedence is fixed: waived → unread → exception → base condition.**
A waived rule is not evaluated at all, so an unread field on a rule that does not apply
never produces a spurious `unknown`. Full ordering in §7.3.

**I12 — An undecidable exception degrades a `block` to `unknown`.**
If a rule would block, but its exception could not be evaluated because the fact it depends
on was not read, the system does not know whether the escape hatch applied. It must not
claim to. This is I4 applied one level deeper, and it is the invariant that keeps the rule
engine honest as it gains expressiveness.

**I13 — Credential plaintext exists only inside the worker process.**
The web process can create and delete credentials but has no key material to decrypt them.
No credential is ever logged, returned by an API, or included in an error payload.

**I14 — We only ever fetch messages matching a code-fixed sender allowlist, and the match is
performed by the user's own mail server.**
`FETCH` is only ever called with UIDs returned by a `SEARCH` built from the allowlist. Mail
outside it is not downloaded and discarded — it is never requested, so it never crosses the
network. The allowlist lives in code, not in a database column someone can edit. Enforced in
the IMAP wrapper alongside I8 and asserted by the same class of test.

**I15 — Application state is asserted by the user, never inferred.**
The system does not know whether you applied, and does not know whether an employer replied.
It cannot: I14 confines fetching to alert senders, and a rejection letter is not one of them —
it is never requested. Every application event therefore carries an author, and that author is
always the user. This is what keeps the login screen's second promise (*"never applies to a job
or answers a recruiter on your behalf"*) true while still tracking a search, and it constrains
the copy the same way I4 constrains facts: the follow-up nudge says *"you marked this applied
12 days ago and have not updated it"*, never *"they have not replied"*. We do not get to say
the second sentence, so we do not write it.

**I16 — An application record is never filtered.**
Rule verdicts and dismissal govern the digest. They never govern the applications view. Because
evaluation happens at read time (I6), a tightened rule would otherwise erase an ad the user had
already applied to — editing a filter would silently destroy their own history. Once an ad has
one application event it is permanently addressable, whatever the current ruleset says about it.

---

## 4. Mailbox access and credentials

### 4.1 Why IMAP + app password is the MVP path

The designed login screen offers OAuth for Gmail/Outlook and app passwords for
GMX/web.de/iCloud. For the MVP, **every provider takes the app-password path**, including
Gmail.

Reason: Gmail's `gmail.readonly` is a *restricted* scope. An app in Testing status may have
up to 100 test users without verification, but refresh tokens issued in that mode **expire
after seven days**. For a product with weekly cadence, that means reconnecting before every
digest — unusable. Publishing to production with restricted scopes requires a third-party
security assessment (CASA), which is a real cost and a months-long process, not a form.

App passwords require the user to have 2FA enabled and to paste a generated string. That is
worse onboarding than OAuth and better than a product that logs itself out weekly. OAuth
becomes an additional method once verification is done — the login screen already has the
shape for both, so this is a configuration change, not a redesign.

The trade this accepts: we hold credentials that grant full mailbox read access, and their
compromise is severe. §4.2 through §4.5 are the cost of that trade.

### 4.2 Credential handling

Envelope encryption:

- A per-user **data encryption key (DEK)**, generated on mailbox connect.
- The DEK is wrapped by a **key encryption key (KEK)** held in a KMS (or, for self-hosted
  deployments, a key supplied by environment and never written to disk).
- `mailboxes.credentials_enc` stores the ciphertext plus the wrapped DEK and key version.
- Unwrapping happens **only in the worker** (I13). The web process holds no KEK reference.
- Key rotation rewraps DEKs without touching ciphertext.
- Deleting a mailbox destroys the DEK, which makes the ciphertext unrecoverable — deletion
  is real, not a flag.

Verification on connect: attempt a real IMAP login before persisting anything. A credential
that never worked is never stored.

`credential_expires_at` is stored where the provider exposes it. This is what makes the
designed error copy possible — *"The app password for `buscar@…` expired on 27 Jul"* is a
stored date, not a guess.

### 4.3 What can and cannot be promised

This is the adoption blocker, so it needs a precise answer rather than a reassuring one.

**IMAP has no scopes.** There is no permission for "only mail from linkedin.com" — not a
difficult one, a nonexistent one. An app password grants the whole mailbox. **OAuth does not
fix this either**: `gmail.readonly` and Microsoft Graph `Mail.Read` are both whole-mailbox.
Neither provider offers sender-scoped mail access. OAuth improves *credential hygiene*
(revocable, expiring, no password); it does not provide data minimization. Conflating the two
is the most common dishonesty in this product category.

So the accurate claim is not "we can only read your job alerts." It is:

> We have the capability to read the mailbox. We constrain the exercise of it to a fixed list
> of senders, the constraint is applied by your mail server before anything reaches us, and
> here is the log of exactly what we asked for.

Capability, exercise, and verification are three different statements. Any copy that blurs
them will be caught by exactly the users who ask this question.

### 4.4 Data minimization

- **The filtering happens on the user's server** (I14). `SEARCH FROM "linkedin.com" SINCE …`,
  then `FETCH` only the matching UIDs. Non-matching mail is never requested. This is
  materially different from syncing a mailbox and filtering locally, which is what most mail
  integrations do and what the sceptical user is picturing.
- **Attachments are never stored.** Alert emails carry none worth keeping; they are dropped
  at fetch.
- **Retention window on raw bodies** (I1), with derived ads outliving them.
- **Account deletion destroys the DEK** (§4.2), making ciphertext unrecoverable. Deletion is
  real, not a flag.
- **No mail outside the allowlist ever reaches a model**, trivially, because it was never
  stored (§8).

One correctness note: `SEARCH FROM` is a substring match, so `linkedin.com` would also match
`linkedin.com.example.ru`. The sender domain is re-verified after fetch. That is a
content-trust concern rather than a privacy one, but it should not be left loose.

### 4.5 Verifiability, and the two ingestion paths

Constraints the user cannot check are worth little, so they are made checkable.

**Access log as a product surface.** Every IMAP session records the query issued, how many
messages matched, how many were downloaded, how many stored — and the user can read it:

> *30 July, 06:40 — searched for mail from linkedin.com, xing.com, indeed.com, stepstone.de
> since 23 July. 12 matched. 12 downloaded. No other messages were requested.*

This product already exposes its own failures to earn trust (*Emails we couldn't read*).
Extending that principle to "what we touched in your mailbox" is the same design argument,
not a new feature.

**The worker is open source.** It is the only component that touches a mailbox. The allowlist
and the PEEK-only wrapper are readable by anyone. "Trust our code" is a much cheaper promise
to accept when the code can be read.

**Revocation is one click, on their side.** App passwords are revocable from the provider's
account settings without changing the main password. This belongs on the connect screen, not
in the terms.

**Two acquisition paths, one pipeline.** Forwarding — a unique high-entropy inbound address
per user, with the user's own filter deciding what we ever see — is the only option whose
guarantee is *structural*: we never hold mailbox access at all, and the user can inspect and
revoke the arrangement without asking us. It costs onboarding friction and gives no backfill.

Both paths **converge at `raw_emails`**; only acquisition differs. Forwarding is an HTTP
webhook that writes `raw_emails`; IMAP is the worker that writes `raw_emails`. Every stage
below — classify, declare, extract, normalize, dedupe — is shared. This is one extra ingress
adapter, not a second pipeline.

The two map onto the trust the user already has:

| Path | For | Guarantee |
| --- | --- | --- |
| **Forwarding** | Strangers; public signup | Structural — no mailbox access exists |
| **IMAP + app password** | People who know the operator; self-hosted | Policy, enforced by I8/I14 and made checkable by the access log |

Forwarding also sidesteps OAuth verification entirely (§4.1), since public signups never need
provider credentials.

Anti-abuse on the forwarding path: a unique address is guessable or leakable, so only mail
whose *embedded original sender* is on the allowlist is accepted; everything else is dropped
without being stored. Forwarding breaks SPF on the outer envelope, so verification runs
against the embedded original headers.

### 4.6 GDPR

The user base is in the EU, so this is operational, not decorative: right of access (the
access log and an export cover most of it), right to erasure (DEK destruction makes it real
rather than a soft delete), and **subprocessor disclosure** — the extraction fallback sends
ad HTML to a model provider, and that must be stated. A DPA with each subprocessor, and data
residency considered when choosing them.

---

## 5. Architecture

```
┌──────────────┐   IMAP, read-only (PEEK)   ┌─────────────────────────────────┐
│  Mailboxes   │◄───────────────────────────│      Ingestion worker           │
│ Gmail/GMX/…  │   app password (§4)        │  (long-running, multi-tenant)   │
└──────────────┘                            │                                 │
                                            │  per user, per run:             │
                                            │   1. fetch new UIDs   ──► I1    │
                                            │   2. fingerprint layout (§5.3)  │
                                            │   3. classify sender/subject    │
                                            │   4. declare count    ──► I3    │
                                            │   5. extract ─┬ deterministic   │
                                            │               └ LLM fallback    │
                                            │   6. normalize facts (§6.5)     │
                                            │   7. enrich (commute, market)   │
                                            │   8. dedupe + sightings         │
                                            │   9. score (deterministic)      │
                                            │  10. narrate fit/gap (cached)   │
                                            └────────────────┬────────────────┘
        ┌──────────────┐                                     │
        │ Job queue    │◄────── schedules per-user runs ──────┤
        │ (per tenant) │                                      │ writes
        └──────────────┘                            ┌─────────▼──────────┐
                                                    │    PostgreSQL      │
                                                    │  + row-level       │
                                                    │    security (§2)   │
                                                    └─────────┬──────────┘
                                                              │ reads (RLS)
                                            ┌─────────────────▼───────────────┐
                                            │   Next.js 15 app (RSC)          │
                                            │                                 │
                                            │   evaluate(facts, ruleset) (I6) │
                                            │    ── pure, shared module ──    │
                                            │                                 │
                                            │  /digest /unread /profile       │
                                            │  /connect /billing              │
                                            └─────────────────────────────────┘
```

### 5.1 The shared core

The worker and the app share one module: **`evaluate(facts, ruleset) → Verdict[]`**. The
worker uses it for weekly stats; the app uses it to render every card, to preview rule
edits, and to replay history (§7.4). One implementation, one test suite. It is pure, has no
I/O, and does not import the database.

### 5.2 Why a queue now

v1 argued against a queue at 12 emails/week for one user. Multi-tenancy flips that
immediately, exactly as v1 predicted it would: ingestion becomes N scheduled jobs, each
holding a network connection for tens of seconds, each able to fail independently, each
needing retry with backoff and a guarantee that one user's stuck mailbox does not stall
everyone else's digest.

That is a queue's job description. BullMQ + Redis, reusing the operational patterns from
`webhook-engine`: one job per `(user, mailbox)`, concurrency capped well below the Postgres
connection pool, per-job attempt budget, and dead-letter with the failure reason surfaced to
the *user* rather than only to logs — a permanently failing mailbox is a product state
(reconnect), not an ops secret.

### 5.3 Layout fingerprinting and cross-tenant regression detection

This capability does not exist in a single-user tool and is one of the strongest arguments
for the service shape.

Each incoming email gets a **`layout_hash`**: a hash of its structural skeleton — the set of
tag and class paths, with all text content stripped. Parsers register against
`(platform, layout_hash)`.

Three consequences:

1. **An unknown hash means we know we are blind before parsing**, not after. The email is
   recorded as `unknown_layout` rather than producing a confidently wrong extraction.
2. **Coverage aggregates across tenants.** When Xing changes its template, the same new hash
   appears in many mailboxes on the same day and its coverage (I3) is near zero.
   *"Xing changed its alert layout on 24 July"* stops being something we learn from a
   complaint and becomes an automatic alert. This is the extraction analogue of
   `webhook-engine`'s per-endpoint circuit breaker: a health signal computed over a
   population, not a single event.
3. **One fix repairs everyone, retroactively.** Write the parser for the new hash, bump
   `parser_version`, re-parse (I2) — every affected user recovers the ads they missed.

Privacy: what aggregates is **metrics per `(platform, layout_hash)`** — counts, coverage
ratios, field-level success rates. Never content, never across-tenant ad data. The hash is
computed from structure with text removed, so it does not encode anyone's mail.

---

## 6. Ingestion pipeline

### 6.1 Fetch

Track `last_uid_seen` and `uid_validity` per mailbox. `UID FETCH (last+1):*` with PEEK.
Store full RFC822 bytes, the decoded `text/plain` and `text/html` parts, and **which MIME
parts existed** — that last field is how the image-only email case gets diagnosed rather
than guessed at.

`uid_validity` changing means UIDs were invalidated server-side and `last_uid_seen` is
meaningless; the mailbox needs a full re-scan. Continuing silently would drop emails
permanently.

Insert on `(user_id, message_id)` with `ON CONFLICT DO NOTHING`. Re-running is safe (I1, I2).

### 6.2 Classify

Route by sender domain + subject shape to a platform adapter, or to `not_an_alert`.

`not_an_alert` is a **first-class successful outcome**. The prototype's fifth failure case is
a Xing profile-tips newsletter that matched on sender: *"Nothing to extract and nothing
missing. Shown here only so the count of 12 emails adds up."* Conflating that with a parse
failure would make the failure count dishonest.

### 6.3 Declare (I3)

Per-platform: pull the ad count the email announces — subject numerals for StepStone and
LinkedIn, the listing header for Indeed. Store `declared_count`, or `null` with a reason.

### 6.4 Extract

Deterministic, per-platform, per-`layout_hash`, per-block-type. Indeed's normal rows and its
sponsored-listing block are **different extractors** — the prototype's third failure case is
precisely that only one is implemented ("3 of 7 ads read").

Each field yields value, source offset range, and the extractor that produced it. Offsets
are what make I5 checkable.

If `extracted < declared`, or a field feeding a hard rule is empty, the LLM fallback runs on
the residual HTML (§8.1).

### 6.5 Normalize — where the domain complexity lives

Extraction gets strings; rules need comparable facts. This stage will consume the most
engineering time.

| Ad wording | Normalized fact |
| --- | --- |
| `Wechselschicht … auch Samstag` | `rotating: true, weekend: true` |
| `Gleitzeit zwischen 07:00 und 19:00, Mo–Fr` | `rotating: false, weekend: false` |
| `verhandlungssicheres Deutsch` | `german: 'C1'` |
| `gute Deutschkenntnisse in Wort und Schrift` | `german: 'B2'` |
| `2.900 – 3.300 € brutto/Monat` | `pay: 2900, payMax: 3300` |
| `1.250 € brutto bei 20 Std.` | `pay: 1250, payFte: 2500, fteNote: 'at 20h'` |
| `Vergütung nach TVöD E5` | `pay: 2930` — via a TVöD rate table |
| `2 Tage Homeoffice pro Woche möglich` | `home: 2` |
| `zunächst befristet auf 12 Monate` | `permanent: false` |

Three observations:

- This is a **closed vocabulary**. German job ads are formulaic; a curated, versioned lexicon
  covers the large majority. That is why deterministic extraction is viable and why the LLM
  stays a fallback.
- `TVöD E5 → ~2.930 €` is a **reference table lookup**, not parsing. Same for FTE scaling.
  These are versioned configuration, and when a table changes, stored facts must be
  recomputed — another consumer of I1/I2.
- Every normalization keeps its source quote. The fact drives the verdict; the quote is what
  the user sees. A fact whose quote fails I5 is dropped.

Unmapped wording produces `null`, which under I4 surfaces as `unknown` — visibly — rather
than as a wrong verdict.

### 6.6 Enrich

Facts that are not in the email and require an external source:

- **Commute** — user address → ad location, public-transit minutes. The prototype already
  assumes this (`commuteMax: 40`, and fixtures reading *"38 min door to door"*).
- **Pay vs. market** — the ad's band against a regional reference for the job family.
- **Company size** — where cheaply available.

Enriched facts are marked `origin: 'enriched'` and carry the source and timestamp. They can
feed rule conditions and exceptions, but they have **no quote**, so the expanded panel must
present them differently from extracted facts — the user should always be able to tell what
came from the ad and what the system inferred. Cached per `(location, address)`, refreshed
rarely.

### 6.7 Dedupe

The same ad arrives across platforms and weeks; `already seen: 18` is a headline metric.

Dedupe key, in priority order:

1. The platform's ad id parsed out of `external_url` — stable, exact.
2. Failing that, `sha256(normalize(title) ‖ normalize(company) ‖ city)`.

Deliberately **excludes** any field whose extraction can degrade. Otherwise a partly-read
email creates a duplicate of an ad we already have, and worse, a parser fix (I2) would
duplicate everything it improved. Cross-platform collisions on the fallback key are treated
as the same ad — the same vacancy on Xing and LinkedIn is one decision for the user.

Later sightings write an `ad_sightings` row and may **fill in nulls** (a Xing email missing
pay, then a LinkedIn one with it). This is the one write path that mutates an ad and it is
monotonic: `null → value`, never `value → different value`. A conflict is recorded on the
sighting and flagged, not overwritten.

### 6.8 Score, then narrate

**Score is deterministic** — a weighted function of facts against the profile, 0–100. Not an
LLM call: the list is sorted by it, and a number the user cannot reproduce should not decide
ordering. The design already relegates it to grey secondary type.

**`fit`/`gap` prose is generated**, and has to be — *"the closest thing to your retail service
work without shifts"* requires the CV. One call per ad, cached on
`(ad_id, profile_version, prompt_version)`. Generated during ingestion for ads that pass the
rules; lazily on expand for filtered-out ones.

---

## 7. The rule engine

The prototype has five thresholds and a hard/preference toggle. That is a filter. This is the
part of the product that earns a subscription, so it gets a real design.

### 7.1 Why thresholds are not enough

Real preferences are **not independent**. "I'd take 2.400 € if it's fully remote." "I'd
accept C1 German if it pays over 3.000." "Permanent only — except public sector, where
fixed-term is normal." A per-rule gate cannot express any of these, and they are how the
decision is actually made.

### 7.2 Shape

A rule has three parts. Applicability turns out to be a special case of exception — an
exception whose relaxed condition is *always pass* — so we implement three concepts and get
four behaviours.

```ts
interface Rule {
  key: RuleKey;                    // Shift | German | Onsite | Pay | Contract
  severity: 'hard' | 'preference'; // block vs warn
  condition: Condition;            // the threshold
  exception?: {
    when: Predicate;               // over Facts, incl. enriched (§6.6)
    mode: 'relax' | 'waive';
    condition?: Condition;         // required for 'relax'
  };
}
```

`Condition` and `Predicate` are a **closed, typed union per rule key**, not a general
expression language. Two reasons: every rule must render as one sentence of English
(*"2.600 € — or 2.300 € if fully remote"*), and an open DSL is a project of its own.

Exactly one exception per rule, deliberately. The second exception is where this becomes
unexplainable, and explainability is the product.

### 7.3 Evaluation and the explanation tree

`evaluate` no longer returns a state; it returns a state **and the reasoning that produced
it**, because the expanded panel now has to say *"…except your remote exception applied."*

```ts
interface Verdict {
  key: RuleKey;
  state: 'pass' | 'warn' | 'block' | 'unknown';
  value: string;   // chip text, from the ad's wording
  quote: string;   // I5-verified, or '—'
  because: Step[]; // ordered, rendered as prose
}

type Step =
  | { kind: 'waived';      when: string }
  | { kind: 'unread';      field: string }
  | { kind: 'exception';   when: string; relaxedTo: string }
  | { kind: 'undecidable'; when: string; missing: string }   // I12
  | { kind: 'compared';    fact: string; against: string; met: boolean }
  | { kind: 'severity';    severity: 'hard' | 'preference' };
```

Order of evaluation is fixed (I11):

1. **Waiver.** If `exception.mode === 'waive'` and its predicate holds → `pass`, with
   `waived`. The rule is not evaluated further, so an unread field on a rule that does not
   apply never produces a spurious `unknown`.
2. **Unread.** If the fact the condition needs is `null` → `unknown` (I4). Never blocks.
3. **Exception.** If `mode === 'relax'` and the predicate holds → evaluate the relaxed
   condition instead, recording `exception`.
   If the predicate **cannot be evaluated** because its own fact is `null`:
   - the base condition passes → `pass` (the exception was not needed);
   - the base condition fails on a *preference* → `warn`;
   - the base condition fails on a *hard* rule → **`unknown`, not `block`** (I12), with
     `undecidable`. We could not check the escape hatch, so we do not get to claim the ad is
     disqualified.
4. **Base condition**, with severity deciding `block` vs `warn`.

I12 is the load-bearing detail. Without it, adding exceptions makes the filter *less*
trustworthy than the plain threshold version — it would silently discard ads whose escape
hatch we simply failed to read. That would invert the product's core trade (§I4).

### 7.4 Accountability: rules have a record

Every rule can show what it has cost. The interesting number is not "how many ads did this
rule fail" but **"for how many ads was this rule the *sole* blocker"** — an ad that failed
only the pay floor is a near miss; one that failed four rules was never a candidate. The
fixtures plant this case deliberately: Kontor Nord, 57%, *"everything else about it passed"*.

This needs no new storage. Facts are immutable (I1), rulesets are versioned, evaluation is
pure (I6) — so **a rule's record is a replay, not a log**. Re-evaluate the stored ads of the
last N weeks under ruleset version V and count. The separation of facts from evaluation,
introduced in v1 for a different reason, pays for this feature entirely.

### 7.5 Self-revision with evidence

Three signals, all counted, none learned:

- **Overrides.** "Show anyway" on a rule-blocked ad, with the margin by which it failed.
- **Dismissals of passing ads.** The rule is too loose.
- **Sole-blocker clusters near the threshold.** The rule is too tight.

At three or more overrides of one rule within a margin band, propose the edit with its
evidence *and its cost*: *"You've overridden the 2.600 € floor three times, all between
2.400 and 2.600. Lower it to 2.400? That would also let in 6 ads you haven't seen."*

Proposals are never applied automatically. A filter that edits itself is exactly the thing
the user stopped trusting when she stopped opening the emails.

### 7.6 Commute stays off the lane

The knockout lane is designed as five fixed positions in a fixed order, and its value comes
from that stability. Commute is a sixth *fact*, not a sixth lane cell — it powers exception
predicates (*"accept no home office if the commute is under 20 minutes"*), the prose, and
the score, without touching a designed grid. Promoting it to a sixth lane needs a design
pass first.

### 7.7 Search modes

A job search has two registers. Someone with two months of runway wants coverage and tolerates
noise; someone employed and curious wants silence unless something is genuinely worth the
interruption. The same ruleset should serve both, because they are the same person at different
times — often the same week.

A mode is **a pure transform on the ruleset, applied at read time**:

```ts
type Mode = 'urgent' | 'steady';
declare function applyMode(saved: Ruleset, mode: Mode): Ruleset;
```

Everything downstream is unchanged, because I6 already says evaluation is a pure function of
`(facts, ruleset)` computed on read. Switching modes re-parses nothing, migrates nothing, and
is reversible in one click. The Profile delta preview (§10, `/api/ruleset/preview`) is a diff
between two rulesets, so it shows exactly what a mode would let in *before* it is switched on —
that comes free rather than as a feature.

**The transform changes severity, never thresholds.** In `urgent`, every `hard` rule becomes a
`preference`: nothing is filtered out, everything is listed, and what does not fit is flagged
with the reason it does not fit. In `steady`, the saved severities apply as authored.

Widening the numbers instead was rejected. A 10% haircut on a €2.600 floor is an invented
number, and the system has no basis for inventing it — that floor is the user's. It does have a
basis for the severity change, and it renders as one sentence of English, which is §7.2's test
for whether a rule concept is admissible: *"In urgent mode, missing your pay floor flags the ad
instead of hiding it."* It is also I4's trade — a false negative costs more than a false
positive — pushed further along the axis it already points down, rather than a second mechanism
with its own failure modes.

Mode is stored as a column on `rulesets`, so switching it creates a version. That is honest
(the behaviour of your rules did change) and it preserves the property §7.4's replay rests on:
**a ruleset version fully determines evaluation.** Recording mode anywhere else would make a
replay under version V ambiguous.

Cadence — daily runs, immediate notification — is *not* part of this. It reads as one feature
with mode, but it needs scheduled ingestion and outbound mail, neither of which exists (§4.5
wires Postmark for inbound only), and it is bounded by whatever cron frequency the host allows.
Splitting them keeps the cheap, pure half shippable now. §13.7.

---

## 8. LLM boundary

Two call sites, both fenced (I7).

### 8.1 Extraction fallback

Trigger: `extracted < declared`, or a field feeding a hard rule is empty on an otherwise
parsed ad. Input: the residual HTML. Output: candidate values, each with the exact source
span it came from.

Then the gate (I5): every span must be found in the stored body. Fails → field dropped →
`unknown`. A cheap deterministic check that removes hallucination from the trust path, and
the reason a model is usable here at all. Anything so extracted is marked
`extraction.method = 'llm'` and shows the same literal quote a deterministic parse would.

Not used for the image-only case. OCR is out of scope; that email is reported as the one real
hole, which is what the design asks for.

### 8.2 Narration

`fit` and `gap`, per §6.8. Grounded in stored facts and the profile. Prose only — never a
rule state, never the score.

### 8.3 Why not LLM-first extraction

It would be more robust to layout changes and would gut the product. Screen 2's value comes
from *"Xing changed its alert layout on 24 July: location and working time now sit inside the
header image."* That sentence exists because a named selector on a known layout stopped
matching. A model that quietly succeeds most of the time cannot tell the user what broke, or
when it silently got something wrong. Deterministic extraction fails loudly and legibly,
which here is a feature.

---

## 9. Data model

```
accounts ──┬──< mailboxes ──< raw_emails ──┬──< email_parses
           │                               │
           │                               └──< ad_sightings >── ads ──┬──< ad_narratives
           │                                                          ├──< ad_user_state
           ├──< rulesets (versioned)                                  └──< application_events
           ├──< profiles (versioned)
           └──< runs

platform_capabilities · layouts · tvoed_rates   (global, not per-tenant)
```

Every per-tenant table carries `user_id` with an RLS policy (§2).

**`mailboxes`** — `provider`, `auth_kind`, `credentials_enc` (§4.2), `last_uid_seen`,
`uid_validity`, `status`, `credential_expires_at`.

**`raw_emails`** — immutable (I1). `message_id` unique per user, `uid`, `from`, `subject`,
`received_at`, `raw_bytes`, `body_text`, `body_html`, `mime_parts JSONB`, **`layout_hash`**.

**`layouts`** — global. `(platform, layout_hash)`, `first_seen_at`, `parser_id`,
`coverage_7d`. The regression detector (§5.3) reads this.

**`runs`** — `status`, `emails_total`, `emails_processed`, `parser_version`, `error_kind`,
`error_detail JSONB`. `emails_processed`/`emails_total` is literally the
*"Reading the inbox… 4 of 12"* label.

**`email_parses`** — one row per `(raw_email_id, parser_version)`; re-parse inserts (I2).
`outcome` (`ok`|`partial`|`none`|`not_an_alert`|`unknown_layout`), `declared_count`,
`extracted_count`, `cause_code`, `field_report JSONB`.

Screen 2 is a direct read of this table. `cause_code` is a closed enum, because the copy rule
is "explain the mechanism, never apologize" and that requires an authored explanation per
cause:

| `cause_code` | Meaning | Fixture |
| --- | --- | --- |
| `layout_changed` | Known selectors stopped matching | Xing, 24 July |
| `unknown_layout` | Never-seen `layout_hash` | — (new, from §5.3) |
| `no_text_part` | Body was image-only | StepStone |
| `unknown_block` | Block type with no extractor | Indeed sponsored |
| `field_not_provided_by_platform` | Not a failure — never sent | LinkedIn salary |
| `not_an_alert` | Not a failure — no vacancies | Xing newsletter |

**`platform_capabilities`** — global config: which fields each platform's alerts ever
contain. Without it the system cannot distinguish *"we failed to read the salary"* from
*"LinkedIn does not send one"* — and the UI makes exactly that distinction, in its own words:
*"This is not a failure of the reader — the number simply is not in the email."* Absent this
table, that sentence is unwritable.

**`ads`** — `dedupe_key` unique per user, `external_url`, `title`, `company`, `location_raw`,
`source`, `facts JSONB`, `wording JSONB`, `enriched JSONB`, `score`, `first_seen_at`,
`last_seen_at`, `incomplete`, `extraction JSONB`.

`facts` and `wording` are separate columns on purpose, mirroring the prototype's `f` and `r`.
`facts` feeds I6; `wording` feeds the UI. Collapsing them couples the rule engine to
presentation and breaks re-evaluation.

**`ad_sightings`** — `ad_id`, `raw_email_id`, `alert_name`, `received_at`, `conflicts JSONB`.

**`ad_narratives`** — `(ad_id, profile_version, prompt_version)` unique. Cache keyed by
version, not TTL.

**`rulesets`** — `version`, `rules JSONB` (§7.2), `mode` (§7.7), `saved_at`, `is_active`.
Versioned because Profile diffs draft against saved, and because §7.4 replays history under a
named version. `mode` lives here rather than on `accounts` so that a version keeps fully
determining evaluation — the property the replay depends on.

**`ad_user_state`** — `saved`, `seen`, `dismissed_at`, `overridden_at`,
`override_ruleset_version`, `override_rule_key`. Separate from `ads` because of I10: the
worker owns `ads`, the user owns this. The override columns feed §7.5.

**`application_events`** — `ad_id`, `status`, `at`, `note`. Append-only: the current status of
an application is its latest event, derived, never stored as a column. This follows I1 and I2's
shape — insert, do not mutate — for the same reason they do: the history is the interesting
artifact. It buys three things at once. The timeline renders itself. The follow-up nudge gets
its clock (days since the last event) without a second field to keep in sync. And *"how long
does my pipeline actually take"* becomes answerable by aggregation rather than by new storage,
the same trick §7.4 pulls with replay.

`status` is a closed enum, for the same reason `cause_code` is: each value needs authored copy,
and an open set means unauthored copy.

| `status` | Meaning |
| --- | --- |
| `applied` | The user sent an application. Asserted, not detected (I15). |
| `interviewing` | Any live conversation — screen, technical, on-site. Deliberately not split. |
| `offer` | An offer exists. |
| `rejected` | The employer ended it. |
| `withdrawn` | The user ended it. |

The last three are terminal for the nudge: they stop the clock rather than deleting anything.
Nothing here is ever deleted, because I16 means a record survives any later change to the rules
that surfaced the ad in the first place.

### 9.1 `Facts`

```ts
type Level = 'A2' | 'B1' | 'B2' | 'C1' | 'C2';

interface Facts {
  rotating:  boolean | null;   // null ⇒ unknown (I4)
  weekend:   boolean | null;
  german:    Level | null;
  home:      number | null;    // home-office days per week
  pay:       number | null;    // gross monthly, as stated
  payMax:    number | null;
  payFte:    number | null;    // scaled to full time
  fteNote:   string | null;    // "at 30h" — shown, not computed from
  permanent: boolean | null;
  commuteMin: number | null;   // enriched (§6.6), no quote
}
```

Every field nullable, by design. Nullability is the honesty mechanism.

---

## 10. API

Thin — RSC reads Postgres directly for page loads. These exist for mutations and polling.

| Method | Path | Notes |
| --- | --- | --- |
| `POST` | `/api/runs` | 202 + `run_id`. Idempotent: an active run returns the existing one. |
| `GET` | `/api/runs/:id` | SSE progress; poll fallback at 1 s. Feeds *"4 of 12"*. |
| `GET`/`PUT` | `/api/ruleset` | `PUT` creates a version; never mutates. |
| `POST` | `/api/ruleset/preview` | Draft config → `{ gained[], lost[] }`. Pure I6, no writes. |
| `GET` | `/api/rules/:key/record` | §7.4 replay: ads this rule blocked, sole-blocker first. |
| `GET` | `/api/rules/proposals` | §7.5, with evidence and cost. |
| `PATCH` | `/api/ads/:id/state` | `saved`\|`seen`\|`dismissed`\|`overridden`. Optimistic client. |
| `POST` | `/api/ads/:id/applications` | Appends an event (I15). Never updates — the latest event is the status. |
| `PUT` | `/api/ruleset/mode` | §7.7. Creates a version, like any other rule change. |
| `POST`/`DELETE` | `/api/mailboxes` | Verifies by connecting before storing (§4.2). |
| `POST` | `/api/reparse` | Re-run current `parser_version` over stored emails (I2). Ops. |
| `POST` | `/api/stripe/webhook` | Idempotent on Stripe event id. |

Pages: `/digest`, `/unread`, `/applications`, `/profile`, `/connect`, `/billing`.

### Failure surfaces the backend must produce

The UI has designed states for each, so they are contract:

- **Auth expired** → `error_kind: 'auth'` + address + stored `credential_expires_at`. Digest
  intact (I9).
- **Connection failed** → `error_kind: 'network'`, retry offered, digest intact.
- **UID validity changed** → full re-scan, reported not silent.
- **Partial parse** → `outcome: 'partial'` + `cause_code`; affected ads carry
  `incomplete: true` and still enter the digest (I4).
- **Total parse failure** → `outcome: 'none'`; declared-but-unread count surfaced as the gap.
- **Unknown layout** → `outcome: 'unknown_layout'`; the user is told a template changed and
  that a fix is pending, because §5.3 already knows it.

---

## 11. Scaling path — what breaks first, in order

Per-user volume is small and stays small. What grows is tenants.

1. **Ingestion concurrency**, at a few hundred active mailboxes. Each run holds an IMAP
   connection for tens of seconds. Fix: cap worker concurrency below the Postgres pool, shard
   the schedule across the day rather than running everyone at 06:40.
2. **Narration cost**, immediately proportional to users × ads. Already lazy for filtered-out
   ads (§6.8); the next lever is generating on first expand for everything, trading a spinner
   for cost. This is the first line item that makes free tiers expensive.
3. **Enrichment API quotas** (commute). Cache aggressively by `(address, location)`; these
   repeat heavily within a city.
4. **`evaluate` over the corpus per render**, around 100k ads *for one user* — far away.
   Then: push evaluation into SQL over `facts`, or materialize verdicts per ruleset version
   and pay invalidation. This is the one place I6 would have to bend.
5. **Postgres as a single instance.** Read replicas for the app, primary for the worker, long
   before sharding is worth discussing.

## 12. Deliberately absent, and why

| Not built | Why |
| --- | --- |
| ~~Forwarding-based ingestion~~ | **Now built** — see §4.5. Both paths converge at `raw_emails`, so it is an ingress adapter rather than a second pipeline. Forwarding is the default for public signup; IMAP is for users who know the operator. |
| OAuth for Gmail/Outlook | Blocked on CASA verification (§4.1). Added as a method, not a migration, once cleared. |
| OCR for image-only emails | One email per week per user; the design chose to report the hole honestly. |
| Auto-apply, recruiter replies | Product non-goal and a promise on the login screen. |
| Detecting that a user applied, or that an employer answered | Not a deferral — unbuildable without breaking I14, which is why I15 makes application state user-asserted instead. |
| Platform scraping | Same. |
| Roles, teams, invitations | One user per account. RLS is in place; the rest is not needed. |
| ~~Mobile layout~~ | **Now built** — the nav scrolls within its own bounds and both fixed-width detail grids collapse to one column under 640px. Verified 320–1280px. |
| More than one exception per rule | §7.2 — the second exception is where rules stop being explainable. |

## 13. Open decisions

1. **Score weighting.** Deterministic (I7) but unspecified. Proposal: derive from rule
   outcomes plus profile-target proximity, and show the breakdown in the expanded panel so
   the number is auditable.
2. **Week boundary.** Fixed Mon–Sun or rolling 7 days from the last run? Affects
   `already seen` and the stats. Proposal: fixed Mon–Sun, matching the user's habit.
3. **Ingestion cadence.** The prototype implies weekly, but daily runs with a weekly view are
   cheaper to recover from and make *"last run today, 06:40"* honest. Proposal: daily.
4. **Rule authoring UI for exceptions.** §7.2 is designed as a data model; the Profile screen
   as drawn has no affordance for *"— or 2.300 € if fully remote"*. Needs a design pass.
5. **Knockout treatment and density** — the handoff recommends `lane` + `cards`. Accepting it
   resolves both to constants and deletes the variant code.
6. **Free-tier boundary** (§2). Proposal is one mailbox, current week only. Needs a call. One
   line is ruled out already: `urgent` mode (§7.7) does not go behind the paywall. The user in
   the urgent register is the one with the most need and the least ability to pay, and metering
   their mode is the wrong trade both ethically and commercially. Meter mailboxes, history
   depth, or active applications instead.
7. **Ingestion cadence and notification** — the half of §7.7 that was split off. Needs
   scheduled runs and outbound mail, and is capped by the host's cron frequency. Unresolved
   until that limit is measured rather than assumed.

## 14. Test strategy

The five parse failures in the prototype are described in the handoff as a suite to preserve,
and they should be taken literally: **a fixture corpus of real alert emails, one per platform
per known `layout_hash`**, in the repo, with the expected
`(declared_count, extracted_count, cause_code, field_report)` for each. That corpus is what
makes I2 meaningful — a parser fix is trustworthy only if re-running it over every stored
layout still produces the right answers for the old ones.

Rule engine: a table-driven suite over `(facts, ruleset) → Verdict[]`, with explicit cases
for every branch of §7.3. **I12 gets its own dedicated cases** — a hard rule failing its base
condition with an exception predicate whose fact is `null` must yield `unknown`, never
`block`. That is the invariant most likely to be broken by a well-meaning refactor.

Integration tests against real Postgres via Testcontainers and a real IMAP server (Greenmail
or Dovecot in a container), including:

- **I8**: message flags are byte-identical before and after a run.
- **I9**: auth fails mid-run, previous digest still renders.
- **I13**: the web process cannot decrypt a credential — asserted, not assumed.
- **I14**: seed the test mailbox with mail from a non-allowlisted sender and assert it was
  never `FETCH`ed — not that it was fetched and discarded. The assertion is on the wire, at
  the IMAP wrapper, since the whole privacy claim rests on the request never being made.
- **Retention**: raw bodies past the window are gone, and their ads still evaluate (I1, I6).
- **Tenancy**: a query issued under user A's role returns zero rows of user B's data, with
  RLS doing the work rather than a `WHERE` clause.
