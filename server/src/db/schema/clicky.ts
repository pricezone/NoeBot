/**
 * Clicky Mode and linked phones.
 *
 * Owned by `server/src/clicky/` (sessions) and `server/src/mobile/` (devices). Both tables are new
 * with Clicky and start empty; nothing migrates into them.
 */
import { sql } from "drizzle-orm";
import {
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import type { ClickySession } from "../../../../shared/clicky";
import type { MobilePlatform } from "../../../../shared/mobile-link";
import { agents, sessions, users } from "./core";
import { pushDevices } from "./delivery";
import { jsonb } from "./json";

/**
 * One Clicky session per person and Bot computer.
 *
 * The whole session is one JSON document, written by the reducer in `shared/clicky-state.ts` and
 * read back whole: it is small (a walkthrough, the last twenty turns, a proposal) and nothing queries
 * inside it. `seq` is mirrored into a column so a writer can update it compare-and-set, which keeps
 * two replicas, or a command racing a model answer, from writing over each other.
 */
export const clickySessions = pgTable(
  "clicky_sessions",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    botId: text("bot_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    session: jsonb("session").$type<ClickySession>().notNull(),
    seq: integer("seq").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    /** Set when a session is put away; the next one for the same person and Bot starts fresh. */
    endedAt: timestamp("ended_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("clicky_sessions_open_idx")
      .on(t.userId, t.botId)
      .where(sql`${t.endedAt} is null`),
  ],
);

/**
 * A phone linked to a person's account through the HyperNoesis app.
 *
 * Each row is one Better Auth session the phone holds (`session_id`), so revoking the phone is
 * deleting that session. `push_device_id` is the phone's Expo registration in `push_devices`, when the
 * person allowed notifications; `clicky_bot_id` is the computer its Clicky is paired with, which is
 * where "Noë Bot needs you" is sent.
 */
export const mobileDevices = pgTable(
  "mobile_devices",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    platform: text("platform").$type<MobilePlatform>().notNull(),
    sessionId: text("session_id").references(() => sessions.id, {
      onDelete: "set null",
    }),
    pushDeviceId: text("push_device_id").references(() => pushDevices.id, {
      onDelete: "set null",
    }),
    clickyBotId: text("clicky_bot_id").references(() => agents.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (t) => [
    index("mobile_devices_user_idx").on(t.userId),
    uniqueIndex("mobile_devices_session_idx").on(t.sessionId),
  ],
);
