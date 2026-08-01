ALTER TABLE "layouts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "platform_capabilities" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "tvoed_rates" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "layouts_global_read" ON "layouts" AS PERMISSIVE FOR SELECT TO "app_user", "worker" USING (true);--> statement-breakpoint
CREATE POLICY "layouts_worker_write" ON "layouts" AS PERMISSIVE FOR ALL TO "worker" USING (true) WITH CHECK (true);--> statement-breakpoint
CREATE POLICY "platform_capabilities_global_read" ON "platform_capabilities" AS PERMISSIVE FOR SELECT TO "app_user", "worker" USING (true);--> statement-breakpoint
CREATE POLICY "tvoed_rates_global_read" ON "tvoed_rates" AS PERMISSIVE FOR SELECT TO "app_user", "worker" USING (true);