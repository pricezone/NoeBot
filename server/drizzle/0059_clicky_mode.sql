CREATE TABLE "clicky_sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"bot_id" text NOT NULL,
	"session" jsonb NOT NULL,
	"seq" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ended_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "mobile_devices" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"name" text NOT NULL,
	"platform" text NOT NULL,
	"session_id" text,
	"push_device_id" text,
	"clicky_bot_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "clicky_sessions" ADD CONSTRAINT "clicky_sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clicky_sessions" ADD CONSTRAINT "clicky_sessions_bot_id_agents_id_fk" FOREIGN KEY ("bot_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mobile_devices" ADD CONSTRAINT "mobile_devices_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mobile_devices" ADD CONSTRAINT "mobile_devices_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mobile_devices" ADD CONSTRAINT "mobile_devices_push_device_id_push_devices_id_fk" FOREIGN KEY ("push_device_id") REFERENCES "public"."push_devices"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mobile_devices" ADD CONSTRAINT "mobile_devices_clicky_bot_id_agents_id_fk" FOREIGN KEY ("clicky_bot_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "clicky_sessions_open_idx" ON "clicky_sessions" USING btree ("user_id","bot_id") WHERE "clicky_sessions"."ended_at" is null;--> statement-breakpoint
CREATE INDEX "mobile_devices_user_idx" ON "mobile_devices" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "mobile_devices_session_idx" ON "mobile_devices" USING btree ("session_id");