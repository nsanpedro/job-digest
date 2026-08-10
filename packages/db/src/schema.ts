/**
 * Schema for Job Digest (design §9), multi-tenant from the first migration
 * (design §2): every per-tenant table carries user_id and an RLS policy.
 * Isolation is enforced by Postgres for the app roles, not by a WHERE clause
 * anyone can forget — both `app_user` (web) and `worker` are subject to RLS
 * and scope themselves with `SET LOCAL app.user_id` per unit of work.
 *
 * Grants live in the hand-written migration 0001 (drizzle-kit does not manage
 * them), including the I13 column-level rule: `app_user` cannot SELECT
 * credential ciphertext at all.
 */
import type { Facts, Ruleset, TitleFacts, Wording } from '@job-digest/core';
import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  customType,
  index,
  integer,
  jsonb,
  pgEnum,
  pgPolicy,
  pgRole,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

const bytea = customType<{ data: Buffer }>({ dataType: () => 'bytea' });

/** Web process role. No credential ciphertext access (I13, migration 0001). */
export const appUser = pgRole('app_user');
/** Ingestion worker role. Subject to RLS like everyone else (design §2). */
export const worker = pgRole('worker');

/**
 * The tenant scope: rows are visible iff user_id matches the session setting.
 * NULLIF matters: set_config(..., NULL) stores an empty string, and ''::uuid
 * is an error — an unset or cleared scope must mean zero rows, never a crash.
 */
const tenantScope = sql`user_id = NULLIF(current_setting('app.user_id', true), '')::uuid`;

const tenantPolicy = (table: string) =>
  pgPolicy(`${table}_tenant_isolation`, {
    for: 'all',
    to: [appUser, worker],
    using: tenantScope,
    withCheck: tenantScope,
  });

export const platformEnum = pgEnum('platform', ['LinkedIn', 'Xing', 'Indeed', 'StepStone']);
export const authKindEnum = pgEnum('auth_kind', ['app_password', 'oauth', 'imap', 'forwarding']);
export const mailboxStatusEnum = pgEnum('mailbox_status', [
  'pending_verification',
  'active',
  'auth_failed',
  'disabled',
]);
export const runStatusEnum = pgEnum('run_status', ['running', 'ok', 'error']);
export const runErrorKindEnum = pgEnum('run_error_kind', ['auth', 'network', 'internal']);
export const parseOutcomeEnum = pgEnum('parse_outcome', [
  'ok',
  'partial',
  'none',
  'not_an_alert',
  'unknown_layout',
]);
/** Closed enum: each cause has an authored, mechanism-naming explanation (design §9). */
export const causeCodeEnum = pgEnum('cause_code', [
  'layout_changed',
  'unknown_layout',
  'no_text_part',
  'unknown_block',
  'field_not_provided_by_platform',
  'not_an_alert',
]);
/** Search modes (design §7.7). Stored per ruleset version, not per account. */
export const rulesetModeEnum = pgEnum('ruleset_mode', ['steady', 'urgent']);
/**
 * Closed enum, same reasoning as cause_code: each value needs authored copy,
 * and an open set means unauthored copy. `interviewing` covers every live
 * conversation deliberately — splitting screen/technical/on-site is detail the
 * user would have to maintain for no decision it would change.
 */
export const applicationStatusEnum = pgEnum('application_status', [
  'applied',
  'interviewing',
  'offer',
  'rejected',
  'withdrawn',
]);

/** Role discovery from a CV (docs/adr-001-role-discovery.md §3) — same status/error shape as `runs`. */
export const derivationStatusEnum = pgEnum('derivation_status', ['running', 'ok', 'error']);
/**
 * Mirrors `CvExtractionFailure` (packages/ingest/src/cv-pdf.ts) for the
 * failures that happen before the model call, plus 'refused' for a Claude
 * safety-classifier decline and 'internal' for anything else.
 */
export const derivationErrorKindEnum = pgEnum('derivation_error_kind', [
  'not_a_pdf',
  'too_large',
  'too_many_pages',
  'no_text_layer',
  'corrupt',
  'refused',
  'internal',
]);
export const directionDistanceEnum = pgEnum('direction_distance', ['adjacent', 'stretch']);
export const directionStateEnum = pgEnum('direction_state', [
  'suggested',
  'interested',
  'dismissed',
  'alert_configured',
]);

// ── Tenancy root ────────────────────────────────────────────────────────────

export const accounts = pgTable(
  'accounts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    email: text('email').notNull().unique(),
    /** Billing is metering hooks, not a pricing model yet (design §2). */
    subscriptionStatus: text('subscription_status'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // accounts has no user_id column; its id IS the tenant id.
    pgPolicy('accounts_self', {
      for: 'all',
      to: [appUser, worker],
      using: sql`${t.id} = NULLIF(current_setting('app.user_id', true), '')::uuid`,
      withCheck: sql`${t.id} = NULLIF(current_setting('app.user_id', true), '')::uuid`,
    }),
  ],
);

const userId = () =>
  uuid('user_id')
    .notNull()
    .references(() => accounts.id, { onDelete: 'cascade' });

// ── Acquisition (design §4, §6.1) ───────────────────────────────────────────

export const mailboxes = pgTable(
  'mailboxes',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: userId(),
    /** e.g. 'gmail', 'gmx', 'web.de', 'manual' — display + IMAP presets. */
    provider: text('provider').notNull(),
    authKind: authKindEnum('auth_kind').notNull(),
    emailAddress: text('email_address').notNull(),
    /** Forwarding path only (§4.5): the per-user high-entropy inbound address. */
    inboundAddress: text('inbound_address'),
    /**
     * Sealed credential ciphertext (§4.2). The web role can write this but
     * never read it — enforced by column grants in migration 0001 (I13).
     * Null for forwarding mailboxes: no credentials exist at all.
     */
    credentialsEnc: bytea('credentials_enc'),
    keyVersion: integer('key_version'),
    lastUidSeen: bigint('last_uid_seen', { mode: 'number' }),
    /** IMAP UIDVALIDITY — a change invalidates lastUidSeen and forces a re-scan (§6.1). */
    uidValidity: bigint('uid_validity', { mode: 'number' }),
    status: mailboxStatusEnum('status').notNull().default('pending_verification'),
    /** What makes "the app password expired on 27 Jul" a stored date, not a guess. */
    credentialExpiresAt: timestamp('credential_expires_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    /**
     * Watermark for incremental fetch. Null means "never synced" — the fetch
     * falls back to a fixed lookback window (§6.1's original scope cut). Set
     * only after a run completes, to a timestamp captured *before* that run's
     * fetch started, with a safety buffer — the fetch's own message_id dedup
     * makes a slightly wider window free, but a watermark set too late could
     * silently skip a message that arrived mid-run.
     */
    lastSyncedAt: timestamp('last_synced_at', { withTimezone: true }),
  },
  (t) => [
    uniqueIndex('mailboxes_user_address').on(t.userId, t.emailAddress),
    uniqueIndex('mailboxes_inbound_address').on(t.inboundAddress),
    tenantPolicy('mailboxes'),
  ],
);

export const rawEmails = pgTable(
  'raw_emails',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: userId(),
    mailboxId: uuid('mailbox_id')
      .notNull()
      .references(() => mailboxes.id, { onDelete: 'cascade' }),
    messageId: text('message_id').notNull(),
    /** IMAP UID; null on the forwarding path. */
    uid: bigint('uid', { mode: 'number' }),
    fromAddr: text('from_addr').notNull(),
    subject: text('subject').notNull(),
    receivedAt: timestamp('received_at', { withTimezone: true }).notNull(),
    /**
     * Immutable once written (I1). Nothing mutates this row; deletion happens
     * only via the retention job or account deletion. Everything downstream
     * is derived and rebuildable from these bytes.
     */
    rawBytes: bytea('raw_bytes').notNull(),
    bodyText: text('body_text'),
    bodyHtml: text('body_html'),
    /** Which MIME parts existed — how the image-only email case is diagnosed (§6.1). */
    mimeParts: jsonb('mime_parts').notNull().$type<Record<string, unknown>>(),
    /** Structural fingerprint (§5.3); null until computed. */
    layoutHash: text('layout_hash'),
    fetchedAt: timestamp('fetched_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('raw_emails_user_message').on(t.userId, t.messageId),
    index('raw_emails_user_received').on(t.userId, t.receivedAt),
    index('raw_emails_layout_hash').on(t.layoutHash),
    tenantPolicy('raw_emails'),
  ],
);

export const runs = pgTable(
  'runs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: userId(),
    mailboxId: uuid('mailbox_id').references(() => mailboxes.id, { onDelete: 'set null' }),
    status: runStatusEnum('status').notNull().default('running'),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    /** emailsProcessed / emailsTotal is literally the "Reading the inbox… 4 of 12" label. */
    emailsTotal: integer('emails_total'),
    emailsProcessed: integer('emails_processed').notNull().default(0),
    parserVersion: integer('parser_version').notNull(),
    errorKind: runErrorKindEnum('error_kind'),
    errorDetail: jsonb('error_detail').$type<Record<string, unknown>>(),
  },
  (t) => [index('runs_user_started').on(t.userId, t.startedAt), tenantPolicy('runs')],
);

// ── Extraction (design §6, screen 2) ────────────────────────────────────────

export const emailParses = pgTable(
  'email_parses',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: userId(),
    rawEmailId: uuid('raw_email_id')
      .notNull()
      .references(() => rawEmails.id, { onDelete: 'cascade' }),
    /** One row per (email, parser version); a re-parse inserts, never updates (I2). */
    parserVersion: integer('parser_version').notNull(),
    outcome: parseOutcomeEnum('outcome').notNull(),
    /** The email's own declaration of its payload; null recorded with a reason (I3). */
    declaredCount: integer('declared_count'),
    declaredCountReason: text('declared_count_reason'),
    extractedCount: integer('extracted_count').notNull().default(0),
    causeCode: causeCodeEnum('cause_code'),
    /** Per-field success/failure — the right column of screen 2's cards. */
    fieldReport: jsonb('field_report').$type<Array<{ name: string; ok: boolean; value: string }>>(),
    parsedAt: timestamp('parsed_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('email_parses_email_version').on(t.rawEmailId, t.parserVersion),
    index('email_parses_user_parsed').on(t.userId, t.parsedAt),
    tenantPolicy('email_parses'),
  ],
);

// ── Ads (design §6.7, §9) ───────────────────────────────────────────────────

export const ads = pgTable(
  'ads',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: userId(),
    /**
     * Content hash over title/company/city — never parser-quality-dependent,
     * and cross-platform by construction (§6.7).
     */
    dedupeKey: text('dedupe_key').notNull(),
    /**
     * Platform ad id where one genuinely exists ("linkedin:4444332346").
     * Null for Xing, whose links are per-send tracking tokens. Secondary
     * match: catches a platform rewording a title between sends.
     */
    externalId: text('external_id'),
    externalUrl: text('external_url'),
    /** German, untouched. */
    title: text('title').notNull(),
    company: text('company'),
    locationRaw: text('location_raw'),
    source: platformEnum('source').notNull(),
    /**
     * facts and wording are separate on purpose, mirroring the prototype's
     * `f` and `r`: facts feed evaluation (I6), wording feeds the UI.
     * Collapsing them would couple the rule engine to presentation.
     */
    facts: jsonb('facts').notNull().$type<Facts>(),
    /** Partial: an alert email rarely carries wording for all five rules. */
    wording: jsonb('wording').notNull().$type<Partial<Wording>>(),
    /**
     * Facts read from the title and location line — seniority, discipline,
     * stack, workplace (design note, "chips = hechos, no veredictos", 3 Aug
     * 2026). Deliberately its own column, not folded into `facts`: these do
     * not feed rule evaluation (I6) the way `Facts` does, they feed the card
     * directly. Computed once at first sighting, from the same title/location
     * that are themselves fixed at first sighting (see `upsertAd`) — not
     * recomputed on a later merge.
     *
     * Nullable, not `notNull` with a default: this column was added after
     * ads already existed in production, and every extractor in this codebase
     * signals "not computed" as an absent value, never as an invented empty
     * object (I4's shape, applied to a migration). `null` means "predates
     * this column"; `packages/worker/scripts/backfill-title-facts.ts`
     * computes it for those rows from data already stored (title,
     * location_raw) — nothing to re-fetch, nothing to re-parse.
     */
    titleFacts: jsonb('title_facts').$type<TitleFacts>(),
    /** Enriched facts (§6.6): commute etc. — no quote, marked as inferred. */
    enriched: jsonb('enriched').$type<Record<string, unknown>>(),
    /** Per-field provenance: method (deterministic|llm), extractor version. */
    extraction: jsonb('extraction').$type<Record<string, unknown>>(),
    score: integer('score'),
    incomplete: boolean('incomplete').notNull().default(false),
    incompleteNote: text('incomplete_note'),
    firstSeenAt: timestamp('first_seen_at', { withTimezone: true }).notNull(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull(),
  },
  (t) => [
    uniqueIndex('ads_user_dedupe').on(t.userId, t.dedupeKey),
    uniqueIndex('ads_user_external_id').on(t.userId, t.externalId).where(sql`${t.externalId} IS NOT NULL`),
    index('ads_user_first_seen').on(t.userId, t.firstSeenAt),
    tenantPolicy('ads'),
  ],
);

export const adSightings = pgTable(
  'ad_sightings',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: userId(),
    adId: uuid('ad_id')
      .notNull()
      .references(() => ads.id, { onDelete: 'cascade' }),
    rawEmailId: uuid('raw_email_id')
      .notNull()
      .references(() => rawEmails.id, { onDelete: 'cascade' }),
    /**
     * "Where this came from" in the expanded panel. Despite the column name,
     * this holds the email's subject line, not a user-configured alert name
     * — no platform's alert email exposes the latter, so `ingestEmail` always
     * falls through to `email.subject` (see `IngestInput.alertName`). Kept
     * as-is rather than renamed here; a real rename touches this column plus
     * every query and type that reads it and is a decision for its own
     * change, not a side effect of finding the mislabel.
     */
    alertName: text('alert_name'),
    receivedAt: timestamp('received_at', { withTimezone: true }).notNull(),
    /** A later sighting disagreeing with a stored field is recorded, never overwritten (§6.7). */
    conflicts: jsonb('conflicts').$type<Record<string, unknown>>(),
  },
  (t) => [index('ad_sightings_ad').on(t.adId), tenantPolicy('ad_sightings')],
);

export const adNarratives = pgTable(
  'ad_narratives',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: userId(),
    adId: uuid('ad_id')
      .notNull()
      .references(() => ads.id, { onDelete: 'cascade' }),
    profileVersion: integer('profile_version').notNull(),
    promptVersion: integer('prompt_version').notNull(),
    fit: text('fit').notNull(),
    gap: text('gap').notNull(),
    model: text('model').notNull(),
    generatedAt: timestamp('generated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // A cache keyed by version, not TTL (§6.8).
    uniqueIndex('ad_narratives_cache_key').on(t.adId, t.profileVersion, t.promptVersion),
    tenantPolicy('ad_narratives'),
  ],
);

// ── User-authored state (I10: orthogonal to rule outcomes) ──────────────────

export const rulesets = pgTable(
  'rulesets',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: userId(),
    /** Versioned: Profile diffs draft vs saved, and §7.4 replays history under a version. */
    version: integer('version').notNull(),
    rules: jsonb('rules').notNull().$type<Ruleset>(),
    /**
     * Search mode (§7.7). Lives here rather than on `accounts` so a version
     * keeps fully determining evaluation — the property §7.4's replay rests
     * on. Switching mode therefore creates a version, which is honest: the
     * behaviour of the rules did change.
     */
    mode: rulesetModeEnum('mode').notNull().default('steady'),
    isActive: boolean('is_active').notNull().default(false),
    savedAt: timestamp('saved_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('rulesets_user_version').on(t.userId, t.version),
    uniqueIndex('rulesets_one_active_per_user').on(t.userId).where(sql`${t.isActive}`),
    tenantPolicy('rulesets'),
  ],
);

export const profiles = pgTable(
  'profiles',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: userId(),
    version: integer('version').notNull(),
    /**
     * CV facts, skills, targets, address. First real writer is role discovery
     * (docs/adr-001-role-discovery.md §3): a completed derivation stores
     * `{ skills, directions, dropped, promptVersion, model, derivedAt }`
     * here — the full snapshot, including skill quotes. The `directions`
     * table below holds only what the per-direction UI needs to read without
     * touching CV text again.
     */
    data: jsonb('data').notNull().$type<Record<string, unknown>>(),
    isActive: boolean('is_active').notNull().default(false),
    savedAt: timestamp('saved_at', { withTimezone: true }).notNull().defaultNow(),
    /**
     * Polled the same way `runs.status` is (design's "Reading the inbox…"
     * pattern, reused for "Reading your CV…"). `startDerivation` inserts
     * 'running'; `completeDerivation`/`failDerivation` resolve it.
     */
    status: derivationStatusEnum('status').notNull().default('running'),
    errorKind: derivationErrorKindEnum('error_kind'),
    errorDetail: jsonb('error_detail').$type<Record<string, unknown>>(),
  },
  (t) => [
    uniqueIndex('profiles_user_version').on(t.userId, t.version),
    uniqueIndex('profiles_one_active_per_user').on(t.userId).where(sql`${t.isActive}`),
    tenantPolicy('profiles'),
  ],
);

/**
 * One row per surviving direction from a derivation (docs/adr-001-role-discovery.md
 * §3) — created at `completeDerivation` time, already past I17's gates, so
 * this table only ever holds directions that were safe to show.
 *
 * Denormalized from `profiles.data` on purpose: the direction card renders
 * from this row alone (label, rationale, bridge, searchTerms, distance), no
 * join back to the CV-adjacent blob needed for the common read path. `state`
 * is the one column the user (not the derivation) owns — same split as
 * `ads` / `ad_user_state` (I10), folded into one table here because a
 * direction has no system-vs-user identity split the way an ad does; the
 * row exists because the system proposed it, and `state` is the only field
 * the user ever changes.
 */
export const directions = pgTable(
  'directions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: userId(),
    /** Which `profiles.version` (derivation) produced this row. */
    profileVersion: integer('profile_version').notNull(),
    label: text('label').notNull(),
    rationale: text('rationale').notNull(),
    /** Skill `text` labels from the same derivation that bridge to this direction. */
    bridge: text('bridge').array().notNull(),
    /** German, as typed into a platform search. */
    searchTerms: text('search_terms').array().notNull(),
    distance: directionDistanceEnum('distance').notNull(),
    /** Snapshot at derivation time of the user's own ad titles the model placed here. */
    seenTitles: text('seen_titles').array().notNull().default(sql`'{}'`),
    state: directionStateEnum('state').notNull().default('suggested'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // Guards a retried completeDerivation() from double-inserting the same
    // direction rather than relying on the caller to be careful.
    uniqueIndex('directions_user_version_label').on(t.userId, t.profileVersion, t.label),
    index('directions_user_state').on(t.userId, t.state),
    tenantPolicy('directions'),
  ],
);

export const adUserState = pgTable(
  'ad_user_state',
  {
    /** One row per ad; the worker owns `ads`, the user owns this (I10). */
    adId: uuid('ad_id')
      .primaryKey()
      .references(() => ads.id, { onDelete: 'cascade' }),
    userId: userId(),
    saved: boolean('saved').notNull().default(false),
    seen: boolean('seen').notNull().default(false),
    dismissedAt: timestamp('dismissed_at', { withTimezone: true }),
    /** "Show anyway" on a rule-blocked ad — the §7.5 self-revision signal. */
    overriddenAt: timestamp('overridden_at', { withTimezone: true }),
    overrideRulesetVersion: integer('override_ruleset_version'),
    overrideRuleKey: text('override_rule_key'),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('ad_user_state_user').on(t.userId), tenantPolicy('ad_user_state')],
);

/**
 * The user's own record of a search, one row per state change (design §9,
 * I15/I16).
 *
 * Append-only: the current status of an application is its latest event,
 * derived at read time, never a column that has to be kept in sync. That
 * follows I1 and I2's shape for the same reason they have it — the history is
 * the artifact worth keeping. It also gives the follow-up nudge its clock
 * (days since the last event) without a second field, and makes "how long does
 * my pipeline take" an aggregation rather than new storage.
 *
 * Every row is asserted by the user (I15). The system cannot detect that an
 * application was sent or answered: I14 confines fetching to alert senders, so
 * a reply is never requested in the first place.
 *
 * Cascade on ad deletion is right for account deletion, which is the only
 * thing that deletes ads today. If ad retention is ever added it has to
 * exclude ads with application events — deleting those would break I16.
 */
export const applicationEvents = pgTable(
  'application_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: userId(),
    adId: uuid('ad_id')
      .notNull()
      .references(() => ads.id, { onDelete: 'cascade' }),
    status: applicationStatusEnum('status').notNull(),
    /** When the event happened, which is not always when it was recorded. */
    at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
    note: text('note'),
  },
  (t) => [
    index('application_events_user').on(t.userId),
    // Latest-event-per-ad is the hot read: every applications list derives
    // current status from it.
    index('application_events_ad_at').on(t.adId, t.at.desc()),
    tenantPolicy('application_events'),
  ],
);

// ── Global reference data (no tenant, read-only to app roles) ───────────────

/**
 * Which fields each platform's alert emails ever contain — what lets the UI
 * distinguish "we failed to read the salary" from "LinkedIn does not send
 * one" (design §9).
 */
/**
 * Global reference data has no tenant scope, so every app role may read it —
 * unlike tenantPolicy, this is never a boundary, just an explicit grant.
 *
 * It has to be stated explicitly rather than left implicit: Supabase enables
 * RLS by default on every table regardless of what this schema says, and a
 * table with RLS on and no policy silently returns zero rows to every
 * non-owner role. Found live: platform_capabilities read as empty from
 * app_user in production the moment it had real data to return, with no
 * error anywhere to point at why.
 */
const globalReadPolicy = (table: string) =>
  pgPolicy(`${table}_global_read`, { for: 'select', to: [appUser, worker], using: sql`true` });

export const platformCapabilities = pgTable(
  'platform_capabilities',
  {
    platform: platformEnum('platform').primaryKey(),
    fields: jsonb('fields').notNull().$type<Record<string, boolean>>(),
  },
  () => [globalReadPolicy('platform_capabilities')],
);

/**
 * Known layouts per platform (§5.3); the regression detector reads this, and
 * the worker registers newly discovered layouts here as it finds them
 * (migration 0001 revokes write access from app_user only, not worker).
 */
export const layouts = pgTable(
  'layouts',
  {
    platform: platformEnum('platform').notNull(),
    layoutHash: text('layout_hash').notNull(),
    firstSeenAt: timestamp('first_seen_at', { withTimezone: true }).notNull().defaultNow(),
    /** Which extractor handles this layout; null = we know we are blind. */
    parserId: text('parser_id'),
    notes: text('notes'),
  },
  (t) => [
    primaryKey({ columns: [t.platform, t.layoutHash] }),
    globalReadPolicy('layouts'),
    pgPolicy('layouts_worker_write', { for: 'all', to: [worker], using: sql`true`, withCheck: sql`true` }),
  ],
);

/** TVöD pay-group reference (§6.5): "Vergütung nach TVöD E5" is a lookup, not parsing. */
export const tvoedRates = pgTable(
  'tvoed_rates',
  {
    groupCode: text('group_code').notNull(),
    monthlyEur: integer('monthly_eur').notNull(),
    validFrom: timestamp('valid_from', { withTimezone: true }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.groupCode, t.validFrom] }), globalReadPolicy('tvoed_rates')],
);
