CREATE TYPE "public"."auth_kind" AS ENUM('app_password', 'oauth', 'imap', 'forwarding');--> statement-breakpoint
CREATE TYPE "public"."cause_code" AS ENUM('layout_changed', 'unknown_layout', 'no_text_part', 'unknown_block', 'field_not_provided_by_platform', 'not_an_alert');--> statement-breakpoint
CREATE TYPE "public"."mailbox_status" AS ENUM('pending_verification', 'active', 'auth_failed', 'disabled');--> statement-breakpoint
CREATE TYPE "public"."parse_outcome" AS ENUM('ok', 'partial', 'none', 'not_an_alert', 'unknown_layout');--> statement-breakpoint
CREATE TYPE "public"."platform" AS ENUM('LinkedIn', 'Xing', 'Indeed', 'StepStone');--> statement-breakpoint
CREATE TYPE "public"."run_error_kind" AS ENUM('auth', 'network', 'internal');--> statement-breakpoint
CREATE TYPE "public"."run_status" AS ENUM('running', 'ok', 'error');--> statement-breakpoint
CREATE ROLE "app_user";--> statement-breakpoint
CREATE ROLE "worker";--> statement-breakpoint
CREATE TABLE "accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"subscription_status" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "accounts_email_unique" UNIQUE("email")
);
--> statement-breakpoint
ALTER TABLE "accounts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "ad_narratives" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"ad_id" uuid NOT NULL,
	"profile_version" integer NOT NULL,
	"prompt_version" integer NOT NULL,
	"fit" text NOT NULL,
	"gap" text NOT NULL,
	"model" text NOT NULL,
	"generated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "ad_narratives" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "ad_sightings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"ad_id" uuid NOT NULL,
	"raw_email_id" uuid NOT NULL,
	"alert_name" text,
	"received_at" timestamp with time zone NOT NULL,
	"conflicts" jsonb
);
--> statement-breakpoint
ALTER TABLE "ad_sightings" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "ad_user_state" (
	"ad_id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"saved" boolean DEFAULT false NOT NULL,
	"seen" boolean DEFAULT false NOT NULL,
	"dismissed_at" timestamp with time zone,
	"overridden_at" timestamp with time zone,
	"override_ruleset_version" integer,
	"override_rule_key" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "ad_user_state" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "ads" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"dedupe_key" text NOT NULL,
	"external_url" text,
	"title" text NOT NULL,
	"company" text,
	"location_raw" text,
	"source" "platform" NOT NULL,
	"facts" jsonb NOT NULL,
	"wording" jsonb NOT NULL,
	"enriched" jsonb,
	"extraction" jsonb,
	"score" integer,
	"incomplete" boolean DEFAULT false NOT NULL,
	"incomplete_note" text,
	"first_seen_at" timestamp with time zone NOT NULL,
	"last_seen_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "ads" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "email_parses" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"raw_email_id" uuid NOT NULL,
	"parser_version" integer NOT NULL,
	"outcome" "parse_outcome" NOT NULL,
	"declared_count" integer,
	"declared_count_reason" text,
	"extracted_count" integer DEFAULT 0 NOT NULL,
	"cause_code" "cause_code",
	"field_report" jsonb,
	"parsed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "email_parses" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "layouts" (
	"platform" "platform" NOT NULL,
	"layout_hash" text NOT NULL,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"parser_id" text,
	"notes" text,
	CONSTRAINT "layouts_platform_layout_hash_pk" PRIMARY KEY("platform","layout_hash")
);
--> statement-breakpoint
CREATE TABLE "mailboxes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"auth_kind" "auth_kind" NOT NULL,
	"email_address" text NOT NULL,
	"inbound_address" text,
	"credentials_enc" "bytea",
	"key_version" integer,
	"last_uid_seen" bigint,
	"uid_validity" bigint,
	"status" "mailbox_status" DEFAULT 'pending_verification' NOT NULL,
	"credential_expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "mailboxes" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "platform_capabilities" (
	"platform" "platform" PRIMARY KEY NOT NULL,
	"fields" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "profiles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"data" jsonb NOT NULL,
	"is_active" boolean DEFAULT false NOT NULL,
	"saved_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "profiles" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "raw_emails" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"mailbox_id" uuid NOT NULL,
	"message_id" text NOT NULL,
	"uid" bigint,
	"from_addr" text NOT NULL,
	"subject" text NOT NULL,
	"received_at" timestamp with time zone NOT NULL,
	"raw_bytes" "bytea" NOT NULL,
	"body_text" text,
	"body_html" text,
	"mime_parts" jsonb NOT NULL,
	"layout_hash" text,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "raw_emails" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "rulesets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"rules" jsonb NOT NULL,
	"is_active" boolean DEFAULT false NOT NULL,
	"saved_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "rulesets" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"mailbox_id" uuid,
	"status" "run_status" DEFAULT 'running' NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"emails_total" integer,
	"emails_processed" integer DEFAULT 0 NOT NULL,
	"parser_version" integer NOT NULL,
	"error_kind" "run_error_kind",
	"error_detail" jsonb
);
--> statement-breakpoint
ALTER TABLE "runs" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "tvoed_rates" (
	"group_code" text NOT NULL,
	"monthly_eur" integer NOT NULL,
	"valid_from" timestamp with time zone NOT NULL,
	CONSTRAINT "tvoed_rates_group_code_valid_from_pk" PRIMARY KEY("group_code","valid_from")
);
--> statement-breakpoint
ALTER TABLE "ad_narratives" ADD CONSTRAINT "ad_narratives_user_id_accounts_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ad_narratives" ADD CONSTRAINT "ad_narratives_ad_id_ads_id_fk" FOREIGN KEY ("ad_id") REFERENCES "public"."ads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ad_sightings" ADD CONSTRAINT "ad_sightings_user_id_accounts_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ad_sightings" ADD CONSTRAINT "ad_sightings_ad_id_ads_id_fk" FOREIGN KEY ("ad_id") REFERENCES "public"."ads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ad_sightings" ADD CONSTRAINT "ad_sightings_raw_email_id_raw_emails_id_fk" FOREIGN KEY ("raw_email_id") REFERENCES "public"."raw_emails"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ad_user_state" ADD CONSTRAINT "ad_user_state_ad_id_ads_id_fk" FOREIGN KEY ("ad_id") REFERENCES "public"."ads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ad_user_state" ADD CONSTRAINT "ad_user_state_user_id_accounts_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ads" ADD CONSTRAINT "ads_user_id_accounts_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_parses" ADD CONSTRAINT "email_parses_user_id_accounts_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_parses" ADD CONSTRAINT "email_parses_raw_email_id_raw_emails_id_fk" FOREIGN KEY ("raw_email_id") REFERENCES "public"."raw_emails"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mailboxes" ADD CONSTRAINT "mailboxes_user_id_accounts_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "profiles" ADD CONSTRAINT "profiles_user_id_accounts_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "raw_emails" ADD CONSTRAINT "raw_emails_user_id_accounts_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "raw_emails" ADD CONSTRAINT "raw_emails_mailbox_id_mailboxes_id_fk" FOREIGN KEY ("mailbox_id") REFERENCES "public"."mailboxes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rulesets" ADD CONSTRAINT "rulesets_user_id_accounts_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_user_id_accounts_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_mailbox_id_mailboxes_id_fk" FOREIGN KEY ("mailbox_id") REFERENCES "public"."mailboxes"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "ad_narratives_cache_key" ON "ad_narratives" USING btree ("ad_id","profile_version","prompt_version");--> statement-breakpoint
CREATE INDEX "ad_sightings_ad" ON "ad_sightings" USING btree ("ad_id");--> statement-breakpoint
CREATE INDEX "ad_user_state_user" ON "ad_user_state" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "ads_user_dedupe" ON "ads" USING btree ("user_id","dedupe_key");--> statement-breakpoint
CREATE INDEX "ads_user_first_seen" ON "ads" USING btree ("user_id","first_seen_at");--> statement-breakpoint
CREATE UNIQUE INDEX "email_parses_email_version" ON "email_parses" USING btree ("raw_email_id","parser_version");--> statement-breakpoint
CREATE INDEX "email_parses_user_parsed" ON "email_parses" USING btree ("user_id","parsed_at");--> statement-breakpoint
CREATE UNIQUE INDEX "mailboxes_user_address" ON "mailboxes" USING btree ("user_id","email_address");--> statement-breakpoint
CREATE UNIQUE INDEX "mailboxes_inbound_address" ON "mailboxes" USING btree ("inbound_address");--> statement-breakpoint
CREATE UNIQUE INDEX "profiles_user_version" ON "profiles" USING btree ("user_id","version");--> statement-breakpoint
CREATE UNIQUE INDEX "profiles_one_active_per_user" ON "profiles" USING btree ("user_id") WHERE "profiles"."is_active";--> statement-breakpoint
CREATE UNIQUE INDEX "raw_emails_user_message" ON "raw_emails" USING btree ("user_id","message_id");--> statement-breakpoint
CREATE INDEX "raw_emails_user_received" ON "raw_emails" USING btree ("user_id","received_at");--> statement-breakpoint
CREATE INDEX "raw_emails_layout_hash" ON "raw_emails" USING btree ("layout_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "rulesets_user_version" ON "rulesets" USING btree ("user_id","version");--> statement-breakpoint
CREATE UNIQUE INDEX "rulesets_one_active_per_user" ON "rulesets" USING btree ("user_id") WHERE "rulesets"."is_active";--> statement-breakpoint
CREATE INDEX "runs_user_started" ON "runs" USING btree ("user_id","started_at");--> statement-breakpoint
CREATE POLICY "accounts_self" ON "accounts" AS PERMISSIVE FOR ALL TO "app_user", "worker" USING ("accounts"."id" = NULLIF(current_setting('app.user_id', true), '')::uuid) WITH CHECK ("accounts"."id" = NULLIF(current_setting('app.user_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "ad_narratives_tenant_isolation" ON "ad_narratives" AS PERMISSIVE FOR ALL TO "app_user", "worker" USING (user_id = NULLIF(current_setting('app.user_id', true), '')::uuid) WITH CHECK (user_id = NULLIF(current_setting('app.user_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "ad_sightings_tenant_isolation" ON "ad_sightings" AS PERMISSIVE FOR ALL TO "app_user", "worker" USING (user_id = NULLIF(current_setting('app.user_id', true), '')::uuid) WITH CHECK (user_id = NULLIF(current_setting('app.user_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "ad_user_state_tenant_isolation" ON "ad_user_state" AS PERMISSIVE FOR ALL TO "app_user", "worker" USING (user_id = NULLIF(current_setting('app.user_id', true), '')::uuid) WITH CHECK (user_id = NULLIF(current_setting('app.user_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "ads_tenant_isolation" ON "ads" AS PERMISSIVE FOR ALL TO "app_user", "worker" USING (user_id = NULLIF(current_setting('app.user_id', true), '')::uuid) WITH CHECK (user_id = NULLIF(current_setting('app.user_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "email_parses_tenant_isolation" ON "email_parses" AS PERMISSIVE FOR ALL TO "app_user", "worker" USING (user_id = NULLIF(current_setting('app.user_id', true), '')::uuid) WITH CHECK (user_id = NULLIF(current_setting('app.user_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "mailboxes_tenant_isolation" ON "mailboxes" AS PERMISSIVE FOR ALL TO "app_user", "worker" USING (user_id = NULLIF(current_setting('app.user_id', true), '')::uuid) WITH CHECK (user_id = NULLIF(current_setting('app.user_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "profiles_tenant_isolation" ON "profiles" AS PERMISSIVE FOR ALL TO "app_user", "worker" USING (user_id = NULLIF(current_setting('app.user_id', true), '')::uuid) WITH CHECK (user_id = NULLIF(current_setting('app.user_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "raw_emails_tenant_isolation" ON "raw_emails" AS PERMISSIVE FOR ALL TO "app_user", "worker" USING (user_id = NULLIF(current_setting('app.user_id', true), '')::uuid) WITH CHECK (user_id = NULLIF(current_setting('app.user_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "rulesets_tenant_isolation" ON "rulesets" AS PERMISSIVE FOR ALL TO "app_user", "worker" USING (user_id = NULLIF(current_setting('app.user_id', true), '')::uuid) WITH CHECK (user_id = NULLIF(current_setting('app.user_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "runs_tenant_isolation" ON "runs" AS PERMISSIVE FOR ALL TO "app_user", "worker" USING (user_id = NULLIF(current_setting('app.user_id', true), '')::uuid) WITH CHECK (user_id = NULLIF(current_setting('app.user_id', true), '')::uuid);