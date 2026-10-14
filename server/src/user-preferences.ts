import { and, eq, sql } from "drizzle-orm";
import type { Locale } from "../../shared/i18n/locales";
import {
  DEFAULT_USER_PREFERENCES,
  type UserPreferences,
} from "../../shared/user-preferences";
import type { Database } from "./db/client";
import { users } from "./db/schema";

export type UserPreferencesStore = {
  read: (userId: string) => Promise<UserPreferences>;
  patch: (
    userId: string,
    preferences: Partial<UserPreferences>,
  ) => Promise<UserPreferences>;
  /** The interface language this person chose, or null when they have not chosen one. */
  locale: (userId: string) => Promise<Locale | null>;
  /**
   * Records a language somebody else suggested, such as the platform that signed this person in,
   * only while they have not chosen one themselves. A choice made inside the app is never
   * overwritten by a suggestion arriving with the next sign-in.
   */
  seedLocale: (userId: string, locale: Locale) => Promise<void>;
};

export function createUserPreferencesStore(
  database: Database,
): UserPreferencesStore {
  return {
    async read(userId) {
      const [user] = await database
        .select({ preferences: users.preferences })
        .from(users)
        .where(eq(users.id, userId))
        .limit(1);
      if (!user) throw new Error("User preferences could not be found.");
      return { ...DEFAULT_USER_PREFERENCES, ...user.preferences };
    },
    async patch(userId, preferences) {
      const [user] = await database
        .update(users)
        .set({
          // Merge in Postgres so simultaneous updates to different preferences are preserved.
          preferences: sql`${users.preferences} || ${preferences}::jsonb`,
          updatedAt: new Date(),
        })
        .where(eq(users.id, userId))
        .returning({ preferences: users.preferences });
      if (!user) throw new Error("User preferences could not be saved.");
      return { ...DEFAULT_USER_PREFERENCES, ...user.preferences };
    },
    async locale(userId) {
      const [user] = await database
        .select({ preferences: users.preferences })
        .from(users)
        .where(eq(users.id, userId))
        .limit(1);
      return user?.preferences.locale ?? null;
    },
    async seedLocale(userId, locale) {
      // One conditional update, so a choice saved between a read and a write cannot be lost to it.
      await database
        .update(users)
        .set({
          preferences: sql`${users.preferences} || ${{ locale }}::jsonb`,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(users.id, userId),
            sql`coalesce(${users.preferences}->>'locale', '') = ''`,
          ),
        );
    },
  };
}
