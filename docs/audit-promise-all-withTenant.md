# Audit: `Promise.all` sites whose branches open a DB connection

Reconnaissance only — no code changes as part of this file. Scope covered:
`packages/app/src` and `packages/worker/src`, starting from

```
grep -rn "Promise.all" packages/app/src packages/worker/src
```

For each site: file:line, number of branches, whether all branches touch
the DB, and a one-line recommendation. "Touching the DB" here means the
branch (directly or transitively) opens its own `withTenant` (`@/lib/session`
in the app, `packages/worker/src/tenant.ts` in the worker) or an equivalent
`SET LOCAL ROLE` transaction — anything that consumes a connection from the
shared Supabase pooler (session mode, capped at 15, shared across every
Vercel instance + local dev).

The reason to care: with the app pool at `max: 4` in prod
(`packages/app/src/lib/db.ts:25`), any `Promise.all` whose branches all open
their own `withTenant` holds N concurrent connections per request. A route
whose N is ≥ pool max — like `/profile` was, at 4 — exhausts its instance's
share of the pooler and returns `EMAXCONNSESSION`, which is exactly the
`/profile` incident of 2026-09-18 (Vercel runtime-errors digest `2626183008`,
resolved on `main` by commit `062d27d`).

## Sites

### `packages/app/src/app/(app)/layout.tsx:22` — 5 branches, all DB — **ALREADY FIXED**

```ts
const [unread, savedCount, applications, isOnboarded, city] = await Promise.all([
  getUnreadEmailsCached(user.id),
  getSavedCountCached(user.id),
  getApplicationCountsCached(user.id),
  getIsOnboarded(),
  getUserCityCached(user.id),
]);
```

Every branch opens its own `withTenant`. This layout renders on every
authenticated route, so its five connections stacked on top of whatever the
page below asks for. Serialised to five sequential `await`s in the sibling
branch `fix/pool-serialise-remaining` (see this batch).

### `packages/app/src/app/(app)/digest/page.tsx:37` — 3 branches, 2 DB + 1 non-DB — **ALREADY FIXED**

```ts
const [isOnboarded, gmailState, cookieStore] = await Promise.all([
  getIsOnboarded(),
  getGmailMailboxStatus(user.id),
  cookies(),
]);
```

`getIsOnboarded` and `getGmailMailboxStatus` each open a `withTenant`;
`cookies()` from `next/headers` does not. Combined with the layout's 5, one
`/digest` render was seven concurrent connections. Serialised in the same
branch as the layout fix (see above), with `cookies()` left inline since it
doesn't touch the pool.

### `packages/app/src/components/GmailStatusBanner.tsx:30` — 2 branches, 1 DB + 1 non-DB — **LEAVE AS-IS**

```ts
const [state, cookieStore] = await Promise.all([getGmailMailboxStatus(userId), cookies()]);
```

Only one branch touches the pool. The `Promise.all` here doesn't inflate the
connection count — `cookies()` is a `next/headers` call. Safe as written; the
banner mounts once per authenticated request and already goes through the
one connection it needs.

### `packages/app/src/app/(app)/profile/page.tsx:44,46` — comments — **N/A**

These lines are inside the comment that explains why the profile page uses
sequential `await`s instead of `Promise.all`. Not an active call site — the
fix in commit `062d27d` already applied.

### `packages/worker/src/refresh-onboarding.ts:69` — **CURATED_COMPANIES.length branches (28 today), all DB — CONSOLIDATE OR CAP**

```ts
await Promise.allSettled(CURATED_COMPANIES.map((c) => refreshCompany(db, c)));
```

`refreshCompany` opens `db.transaction` and sets `SET LOCAL ROLE worker` per
company (see `refresh-onboarding.ts:39-49`). Every entry in `CURATED_COMPANIES`
runs in parallel — 28 concurrent worker-role transactions today, growing with
the catalog. The worker pool is separate from the app pool but shares the
same 15-connection pooler. This is only invoked from admin's
`triggerCacheRefresh` (`onboarding-actions.ts:153`), which today writes via
`after()` and stays out of the request budget — but 28 > pool cap, so if
this ever fires while a warm ingest run holds connections, it will trip
`EMAXCONNSESSION` for both roles.

Recommendation: wrap in `mapWithConcurrency` (the same helper `gmail.ts:50`
and `fetch-apis.ts:62` already use) with a small `FETCH_CONCURRENCY` — 3 to
5, whatever leaves headroom over the pool max — so no more than that many
transactions run at once.

### `packages/worker/src/discover-sources.ts:68` — variable branches (up to `toProbe.length`), all DB — **CONSOLIDATE OR CAP**

```ts
await Promise.allSettled(
  toProbe.map(async (company) => {
    const found = await discoverBoard(company);
    if (!found) return;
    await withTenant(db, userId, async (tx) => {
      // insert as 'suggested' ...
    });
  }),
);
```

Each branch opens its own `withTenant`. `toProbe` is filtered from companies
seen in the current run's emails and could realistically be 5–20 entries.
Under an active ingest this stacks on top of the ingest's own connections
too.

Recommendation: same `mapWithConcurrency` pattern with a modest cap, or
better — collect the `discoverBoard` hits in the outer scope first (they
don't need the DB), then open ONE `withTenant` at the end to batch-insert
all the discovered rows. That drops the pattern from N connections to 1 and
removes the fan-out risk entirely.

### `packages/worker/src/gmail.ts:50` and `packages/worker/src/fetch-apis.ts:62` — **N/A (workers already capped)**

Both are `mapWithConcurrency`'s own internals:

```ts
await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
```

The `limit` is `FETCH_CONCURRENCY` (`gmail.ts:80` sets it to 3), so the
concurrency here is already bounded to the intended cap. The DB work each
worker does is inside its own function — not our concern at this site. Leave
as-is; the cap is doing its job.

## Summary

| Site | Branches | All DB? | Action |
|---|---|---|---|
| `layout.tsx:22` | 5 | yes | already fixed in `fix/pool-serialise-remaining` |
| `digest/page.tsx:37` | 3 | 2 of 3 | already fixed in `fix/pool-serialise-remaining` |
| `GmailStatusBanner.tsx:30` | 2 | 1 of 2 | leave as-is |
| `profile/page.tsx:44,46` | — | — | comments, N/A |
| `refresh-onboarding.ts:69` | 28+ | yes | wrap in `mapWithConcurrency` with cap 3–5 |
| `discover-sources.ts:68` | up to `toProbe.length` | yes | consolidate to one `withTenant`, or cap concurrency |
| `gmail.ts:50`, `fetch-apis.ts:62` | ≤3 | — | already bounded by `FETCH_CONCURRENCY` |

Two remaining risks (`refresh-onboarding.ts:69` and `discover-sources.ts:68`)
worth scheduling as follow-up branches when the pool budget matters — both
sit in worker paths off the request thread, so they're less urgent than
`/profile`/`/digest`/layout were, but they are the same class of bug and
would surface as `EMAXCONNSESSION` under coincident load.
