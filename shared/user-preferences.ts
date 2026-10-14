import type { Locale } from "./i18n/locales";

export type MessageListEmphasis = "agent" | "thread";

export type UserPreferences = {
  messageListEmphasis: MessageListEmphasis;
  /** Whether this person closed the banner offering help self-hosting OpenBot. */
  selfHostBannerDismissed: boolean;
  /**
   * The interface language this person chose. Absent or null until they choose one, which is
   * different from having chosen English: an unchosen language may still follow the deployment's
   * default or the browser, and a platform that signs them in may suggest one. Optional, and absent
   * from the defaults, so a person who never chose reads exactly as they did before languages existed.
   */
  locale?: Locale | null;
};

export const DEFAULT_USER_PREFERENCES: UserPreferences = {
  // The Bot's name leads each roster row, the way a messaging app leads with who said it.
  messageListEmphasis: "agent",
  selfHostBannerDismissed: false,
};
