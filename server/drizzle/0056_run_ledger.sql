CREATE TABLE "run_tool_calls" (
	"thread_id" text NOT NULL,
	"tool_call_id" text NOT NULL,
	"owner_user_id" text NOT NULL,
	"bot_id" text NOT NULL,
	"tool_name" text NOT NULL,
	"args_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"used_at" timestamp with time zone,
	CONSTRAINT "run_tool_calls_thread_id_tool_call_id_pk" PRIMARY KEY("thread_id","tool_call_id")
);
--> statement-breakpoint
CREATE TABLE "run_waits" (
	"thread_id" text NOT NULL,
	"tool_call_id" text NOT NULL,
	"owner_user_id" text NOT NULL,
	"bot_id" text NOT NULL,
	"kind" text NOT NULL,
	"request_id" text,
	"waiting" jsonb NOT NULL,
	"continuation" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"claimed_at" timestamp with time zone,
	"claimed_by" text,
	CONSTRAINT "run_waits_thread_id_tool_call_id_pk" PRIMARY KEY("thread_id","tool_call_id")
);
--> statement-breakpoint
ALTER TABLE "run_tool_calls" ADD CONSTRAINT "run_tool_calls_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_waits" ADD CONSTRAINT "run_waits_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "run_tool_calls_created_at_idx" ON "run_tool_calls" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "run_waits_open_idx" ON "run_waits" USING btree ("claimed_at","created_at");