export type MessageListEmphasis = "agent" | "thread";

export type UserPreferences = {
  messageListEmphasis: MessageListEmphasis;
  /** Whether this person closed the banner offering help self-hosting OpenBot. */
  selfHostBannerDismissed: boolean;
};

export const DEFAULT_USER_PREFERENCES: UserPreferences = {
  // The Bot's name leads each roster row, the way a messaging app leads with who said it.
  messageListEmphasis: "agent",
  selfHostBannerDismissed: false,
};
