/**
 * Run tables: what a run's own stream said, kept briefly so the browser and the server agree fast.
 *
 * Split by owner, like every schema file: this one belongs to the run path (copilot.ts, the
 * approval gate's saved-call check, and the in-run computer tools). Both tables are short-lived by
 * design and purged after a day (`purge` in runs/ledger.ts and runs/waits.ts).
 */
import {
  index,
  pgTable,
  primaryKey,
  text,
  timestamp,
} from "drizzle-orm/pg-core";
import { users } from "./core";
import { jsonb } from "./json";

/**
 * Every computer tool call a run's model streamed, by conversation and call id.
 *
 * Written ONLY by the server's own observer on the agent's event stream (`ToolCallLedgerMiddleware`),
 * never from anything a browser sends, so a row is evidence that the model really made that call
 * with those arguments. The approval gate checks a browser-executed action against it before
 * falling back to reading the saved conversation, which can lag the stream by seconds, and marks
 * the row used so one call can be carried out once.
 */
export const runToolCalls = pgTable(
  "run_tool_calls",
  {
    threadId: text("thread_id").notNull(),
    toolCallId: text("tool_call_id").notNull(),
    ownerUserId: text("owner_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    botId: text("bot_id").notNull(),
    toolName: text("tool_name").notNull(),
    /** SHA-256 of the arguments as canonical JSON (keys sorted). Never the arguments themselves. */
    argsHash: text("args_hash").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    /** Set when the gate let this call through; a second request for it is a replay. */
    usedAt: timestamp("used_at", { withTimezone: true }),
  },
  (t) => [
    primaryKey({ columns: [t.threadId, t.toolCallId] }),
    index("run_tool_calls_created_at_idx").on(t.createdAt),
  ],
);

/**
 * A computer tool the server carried out inside a run that is now waiting on a person: a sign-in,
 * a takeover, a secret, an approval.
 *
 * The run ended at that call. Whoever resumes it claims the row first, so the open tab and the
 * server never both continue one turn: the tab when it is there, the server when it is not.
 */
export const runWaits = pgTable(
  "run_waits",
  {
    threadId: text("thread_id").notNull(),
    toolCallId: text("tool_call_id").notNull(),
    ownerUserId: text("owner_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    botId: text("bot_id").notNull(),
    /** `computer_sign_in`, `computer_handoff`, `computer_secret` or `approval`. */
    kind: text("kind").notNull(),
    requestId: text("request_id"),
    /** What the waiting said, without its continuation. */
    waiting: jsonb("waiting").notNull(),
    /** The interrupted run, the same shape an approval keeps, so the server can resume it. */
    continuation: jsonb("continuation").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    claimedAt: timestamp("claimed_at", { withTimezone: true }),
    /** `tab`, `server` or `stopped`. */
    claimedBy: text("claimed_by"),
  },
  (t) => [
    primaryKey({ columns: [t.threadId, t.toolCallId] }),
    index("run_waits_open_idx").on(t.claimedAt, t.createdAt),
  ],
);
