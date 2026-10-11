CREATE TABLE "plugins" (
	"id" text PRIMARY KEY NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"git_url" text NOT NULL,
	"git_ref" text NOT NULL,
	"git_path" text DEFAULT '' NOT NULL,
	"installed_by" text,
	"installed_by_user_id" text,
	"skipped" jsonb DEFAULT '{"parts":[]}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "mcp_servers" ADD COLUMN "plugin_id" text;--> statement-breakpoint
ALTER TABLE "mcp_servers" ADD COLUMN "auth_kind" text;--> statement-breakpoint
ALTER TABLE "mcp_servers" ADD COLUMN "transport" text;--> statement-breakpoint
ALTER TABLE "mcp_servers" ADD COLUMN "header_templates" jsonb;--> statement-breakpoint
ALTER TABLE "mcp_servers" ADD COLUMN "oauth_metadata" jsonb;--> statement-breakpoint
ALTER TABLE "skills" ADD COLUMN "plugin_id" text;--> statement-breakpoint
ALTER TABLE "skills" ADD COLUMN "offered_to_all_bots" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "plugins" ADD CONSTRAINT "plugins_installed_by_user_id_users_id_fk" FOREIGN KEY ("installed_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "plugins_slug_key" ON "plugins" USING btree ("slug");--> statement-breakpoint
ALTER TABLE "mcp_servers" ADD CONSTRAINT "mcp_servers_plugin_id_plugins_id_fk" FOREIGN KEY ("plugin_id") REFERENCES "public"."plugins"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skills" ADD CONSTRAINT "skills_plugin_id_plugins_id_fk" FOREIGN KEY ("plugin_id") REFERENCES "public"."plugins"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "mcp_servers_plugin_idx" ON "mcp_servers" USING btree ("plugin_id");--> statement-breakpoint
CREATE INDEX "skills_plugin_idx" ON "skills" USING btree ("plugin_id");