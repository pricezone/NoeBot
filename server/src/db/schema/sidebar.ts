import {
  foreignKey,
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
} from "drizzle-orm/pg-core";
import { channelMemberships, users } from "./core";

/**
 * A heading somebody made in their own sidebar, to group conversations under.
 *
 * One person's, entirely: nobody else in a channel sees how its members file it, the same way a pin
 * is one member's (`channel_memberships.pinned_at`). `position` is the order the headings are drawn
 * in, smallest first; the store keeps it dense from 0 and rewrites it whole on a reorder.
 */
export const sidebarSections = pgTable(
  "sidebar_sections",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    position: integer("position").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    /*
     * Redundant as a key, since `id` is already unique, and there for the foreign key below: it is
     * what lets a placement name its section AND its owner, so the database itself refuses to file
     * one person's conversation under somebody else's heading.
     */
    unique("sidebar_sections_id_user_unique").on(table.id, table.userId),
    index("sidebar_sections_user_idx").on(table.userId, table.position),
  ],
);

/**
 * Which section one person filed one of their conversations under.
 *
 * Keyed on the person and the channel, which is the "one section per chat per person" rule as a
 * primary key rather than as code: moving a chat is an upsert, and taking it out is a delete. Both
 * foreign keys are composite and both cascade. Through the membership, so a placement leaves with
 * the membership it belongs to; through the section with its owner, so deleting a section ungroups
 * its chats and a placement can never point at a section its own person does not own.
 */
export const channelSections = pgTable(
  "channel_sections",
  {
    userId: text("user_id").notNull(),
    channelId: text("channel_id").notNull(),
    sectionId: text("section_id").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.userId, table.channelId] }),
    foreignKey({
      name: "channel_sections_membership_fk",
      columns: [table.channelId, table.userId],
      foreignColumns: [channelMemberships.channelId, channelMemberships.userId],
    }).onDelete("cascade"),
    foreignKey({
      name: "channel_sections_section_fk",
      columns: [table.sectionId, table.userId],
      foreignColumns: [sidebarSections.id, sidebarSections.userId],
    }).onDelete("cascade"),
    // The section's side of the cascade, which would otherwise scan every placement to find its own.
    index("channel_sections_section_idx").on(table.sectionId),
  ],
);
