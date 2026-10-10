CREATE TABLE "channel_sections" (
	"user_id" text NOT NULL,
	"channel_id" text NOT NULL,
	"section_id" text NOT NULL,
	CONSTRAINT "channel_sections_user_id_channel_id_pk" PRIMARY KEY("user_id","channel_id")
);
--> statement-breakpoint
CREATE TABLE "sidebar_sections" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"name" text NOT NULL,
	"position" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sidebar_sections_id_user_unique" UNIQUE("id","user_id")
);
--> statement-breakpoint
ALTER TABLE "channel_memberships" ADD COLUMN "hidden_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "channel_sections" ADD CONSTRAINT "channel_sections_membership_fk" FOREIGN KEY ("channel_id","user_id") REFERENCES "public"."channel_memberships"("channel_id","user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_sections" ADD CONSTRAINT "channel_sections_section_fk" FOREIGN KEY ("section_id","user_id") REFERENCES "public"."sidebar_sections"("id","user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sidebar_sections" ADD CONSTRAINT "sidebar_sections_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "channel_sections_section_idx" ON "channel_sections" USING btree ("section_id");--> statement-breakpoint
CREATE INDEX "sidebar_sections_user_idx" ON "sidebar_sections" USING btree ("user_id","position");